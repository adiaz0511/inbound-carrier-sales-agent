#!/usr/bin/env bash
# One-command deploy:  ./deploy.sh <cloud> <environment>
#   ./deploy.sh gcp staging
#   ./deploy.sh gcp production
#
# The container image is cloud-neutral (service/Dockerfile). Each cloud is one function below.
# Only gcp (Google Cloud Run) is implemented for the demo; the others are documented to show the path.
#
# Reads settings and secrets from .env (never committed). Secrets go to the cloud's secret store,
# never into the image or the command line.
set -euo pipefail

CLOUD="${1:-}"; ENVIRONMENT="${2:-}"
cd "$(dirname "$0")"

usage() { echo "usage: ./deploy.sh <gcp|aws|azure> <staging|production>" >&2; exit 1; }
[[ "$ENVIRONMENT" == "staging" || "$ENVIRONMENT" == "production" ]] || usage
[[ -f .env ]] || { echo ".env not found (copy .env.example)" >&2; exit 1; }

# Load .env without executing it.
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }

# Production's own credentials never live on a developer machine (D-018): they are created with
# random values inside Secret Manager on the first production deploy and only ever read there.
# .env holds staging values plus the few values that are the same everywhere (TMS, client id).
GENERATED_IN_STORE=(OAUTH_CLIENT_SECRET OPS_CLIENT_SECRET OAUTH_SIGNING_KEY OTP_HASH_KEY)
if grep -qE '^PRODUCTION_' .env; then
  echo "Refusing to deploy: .env contains PRODUCTION_* values. Production secrets live only in Secret Manager (D-018)." >&2
  exit 1
fi
in_store_only() { [[ "$ENVIRONMENT" == "production" && " ${GENERATED_IN_STORE[*]} " == *" $1 "* ]]; }

SECRETS=(OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET OPS_CLIENT_ID OPS_CLIENT_SECRET OAUTH_SIGNING_KEY TMS_HOST TMS_PORT TMS_AUTH_TOKEN TWIN_WRITER_API_KEY TWIN_READER_API_KEY FMCSA_WEB_KEY OTP_HASH_KEY)
# Production values that only a person can create (issued by HappyRobot): must already be in Secret Manager.
PROVIDED_IN_STORE=(TWIN_WRITER_API_KEY TWIN_READER_API_KEY)
provided_in_store() { [[ "$ENVIRONMENT" == "production" && " ${PROVIDED_IN_STORE[*]} " == *" $1 "* ]]; }
SERVICE="carrier-sales-${ENVIRONMENT}"

# Grant a project role to a member only if it isn't already granted, retrying on Google's
# "concurrent policy changes" conflict (enabling some services edits the policy in the background).
ensure_project_role() {
  local project="$1" member="$2" role="$3" n
  if gcloud projects get-iam-policy "$project" --flatten='bindings[].members' \
       --filter="bindings.role=${role} AND bindings.members=${member}" --format='value(bindings.role)' 2>/dev/null | grep -q .; then
    return 0
  fi
  for n in 1 2 3 4 5; do
    if gcloud projects add-iam-policy-binding "$project" --member="$member" --role="$role" --condition=None >/dev/null 2>&1; then
      return 0
    fi
    sleep $((n * 3))
  done
  echo "Could not grant ${role} to ${member} after 5 tries" >&2
  exit 1
}

deploy_gcp() {
  local project region sa tms_fault_mode
  project="$(env_get GCP_PROJECT_ID)"; region="$(env_get CLOUD_REGION)"; region="${region:-us-central1}"
  if [[ "$ENVIRONMENT" == "staging" ]]; then
    tms_fault_mode="$(env_get TMS_FAULT_MODE)"; tms_fault_mode="${tms_fault_mode:-off}"
  else
    tms_fault_mode="off"
  fi
  [[ -n "$project" ]] || { echo "GCP_PROJECT_ID missing in .env" >&2; exit 1; }
  # Fail loudly if the gcloud session has expired (otherwise the silenced steps below exit with no message).
  gcloud auth print-access-token >/dev/null 2>&1 || { echo "gcloud is not signed in (or the session expired): run 'gcloud auth login', then retry." >&2; exit 1; }
  gcloud config set project "$project" >/dev/null 2>&1

  # Default compute identity: Cloud Build builds the image as it, and Cloud Run runs the service as it.
  sa="$(gcloud projects describe "$project" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

  # One-time project setup, safe to repeat, so a brand-new project deploys with this same command:
  # turn on the services we use, and let the build identity build from source (roles/run.builder:
  # read the uploaded source, write the image and build logs; nothing else).
  echo "→ Checking project setup"
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    secretmanager.googleapis.com firestore.googleapis.com --project "$project" >/dev/null
  ensure_project_role "$project" "serviceAccount:${sa}" roles/run.builder

  # Firestore holds short-lived call state only (D-017). One free database per project, so
  # staging and production share it, separated by an environment prefix on every collection.
  # The service authenticates as its own identity: roles/datastore.user (read/write documents;
  # no admin rights), no key or secret involved.
  if ! gcloud firestore databases describe --database='(default)' --project "$project" >/dev/null 2>&1; then
    gcloud firestore databases create --database='(default)' --location="$region" --type=firestore-native \
      --project "$project" >/dev/null
  fi
  ensure_project_role "$project" "serviceAccount:${sa}" roles/datastore.user

  echo "→ Syncing secrets to Secret Manager"
  local mapping=() name value current
  for key in "${SECRETS[@]}"; do
    name="cs-${ENVIRONMENT}-${key//_/-}"; name="$(echo "$name" | tr '[:upper:]' '[:lower:]')"
    if provided_in_store "$key"; then
      if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
        echo "Missing ${name}: create a production-only HappyRobot key with the 'Twin writer' role and add it in" >&2
        echo "Google Cloud console → Secret Manager → Create secret '${name}' (never in .env, D-018)." >&2
        exit 1
      fi
    elif in_store_only "$key"; then
      # Create once with a random value generated in the pipe; never written to disk or printed.
      if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -d '\n' | gcloud secrets create "$name" --data-file=- --replication-policy=automatic >/dev/null
        echo "  created ${name} in Secret Manager (random value, not stored locally)"
      fi
    else
    value="$(env_get "$key")"
    [[ -n "$value" ]] || { echo "$key missing in .env" >&2; exit 1; }
    if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
      printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic >/dev/null
    else
      current="$(gcloud secrets versions access latest --secret="$name" 2>/dev/null || true)"
      [[ "$current" == "$value" ]] || printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
    fi
    fi
    gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:${sa}" \
      --role=roles/secretmanager.secretAccessor >/dev/null
    mapping+=("${key}=${name}:latest")
  done

  echo "→ Building in Cloud Build and deploying ${SERVICE} to Cloud Run (${region})"
  # --no-invoker-iam-check: Cloud Run's own sign-in gate needs Google identity tokens, which the
  # HappyRobot webhook can't send; every route is instead protected by OAuth2 access tokens (D-016).
  # This flag turns the gate off without granting access to allUsers, so it also works under
  # Google Workspace orgs that forbid allUsers (domain restricted sharing).
  # --max-instances caps cost; --min-instances 0 keeps it inside the free tier.
  gcloud run deploy "$SERVICE" \
    --source service \
    --region "$region" \
    --no-invoker-iam-check \
    --min-instances 0 --max-instances 2 \
    --cpu 1 --memory 512Mi --concurrency 40 --cpu-boost \
    --set-secrets "$(IFS=,; echo "${mapping[*]}")" \
    --set-env-vars "ENVIRONMENT=${ENVIRONMENT},GCP_PROJECT_ID=${project},TMS_FAULT_MODE=${tms_fault_mode},TMS_TIMEOUT_MS=$(v="$(env_get TMS_TIMEOUT_MS)"; echo "${v:-1200}"),TMS_MAX_ATTEMPTS=$(v="$(env_get TMS_MAX_ATTEMPTS)"; echo "${v:-4}"),CODE_CHANNELS=$(v="$(env_get CODE_CHANNELS)"; echo "${v:-email}")" \
    --quiet

  echo "→ Live at: $(gcloud run services describe "$SERVICE" --region "$region" --format='value(status.url)')"
}

deploy_aws() {
  cat >&2 <<'EOF'
Not implemented for the demo. Path: build service/Dockerfile, push to ECR, store the same
secrets in AWS Secrets Manager, deploy on App Runner (or ECS Fargate) with port 8080.
EOF
  exit 2
}

deploy_azure() {
  cat >&2 <<'EOF'
Not implemented for the demo. Path: `az containerapp up --source service`, store the same
secrets as Container Apps secrets, ingress external on port 8080.
EOF
  exit 2
}

case "$CLOUD" in
  gcp) deploy_gcp ;;
  aws) deploy_aws ;;
  azure) deploy_azure ;;
  *) usage ;;
esac
