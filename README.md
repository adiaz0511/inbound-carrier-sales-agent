# Inbound carrier sales agent for HappyRobot Logistics

An AI voice agent built on HappyRobot that takes the first part of every inbound carrier call. It verifies the carrier with FMCSA and a one-time code, finds a matching load in the legacy TMS, negotiates the rate for up to three rounds without ever revealing the broker's ceiling, and places a 60-minute hold. A senior representative then confirms or releases the booking in the Carrier Ops dashboard, and every step is recorded in Twin.

## Links

- HappyRobot workflow (live Production version): https://platform.happyrobot.ai/fdearturodazsegovia/workflows/gzojj9w9w21e/editor/ir5y8dekuxqi
- Talk to the agent (web call, Production): https://platform.happyrobot.ai/deployments/gzojj9w9w21e. The video uses MC 133655, whose code goes to the contact on file; to test it yourself, use the sandbox carrier MC 138328, which accepts an email address given during the call.
- Carrier Ops dashboard (HappyRobot App): https://hr-carrier-ops.happyrobot.dev
- Build document: [`docs/deliverables/BUILD_DOC.md`](docs/deliverables/BUILD_DOC.md), with its [appendix](docs/deliverables/BUILD_DOC_APPENDIX.md)
- Full technical reference: [`docs/reference/TECHNICAL_REFERENCE.md`](docs/reference/TECHNICAL_REFERENCE.md)
- QA results: [`docs/research/qa/QA_RESULTS.md`](docs/research/qa/QA_RESULTS.md)

## How it fits together

The HappyRobot workflow runs the conversation and calls a small set of tools. Every tool is an endpoint of the carrier sales service in `service/`, which holds all the rules: verification, the negotiation strategy, the private ceiling, reservations and the connection to the legacy TMS. The voice model never receives the ceiling and cannot create a booking. As a result, a prompt failure cannot leak a price or skip a check.

| Part | Where | What it does |
|---|---|---|
| Voice agent and workflow | HappyRobot platform | Conversation, tool calls, hidden code delivery, mocked handoff |
| Carrier sales service | `service/` (TypeScript, Fastify, Docker) | OAuth2-protected API that enforces every rule |
| TMS adapter | `service/src/tms/` | Raw TCP, fixed-width protocol, retries, circuit breaker, safe booking |
| Durable records | Twin, schema in `twin/migrations/` | Calls, offers, events, private pricing, onboarding |
| Live state | Firestore | Code attempts, negotiation rounds and holds, which need atomic updates |
| Carrier Ops dashboard | `dashboard/` (Next.js), deployed as a HappyRobot App | KPIs, calls, holds, confirm or release, onboarding |

The build document explains the design, the security model and the evidence in full.

## Run it

Requirements: Node.js 24 and the values listed in `.env.example`, copied into a git-ignored `.env`.

```bash
cd service && npm install
npm test            # 312 tests
npm run dev         # local service on port 8080
```

Read-only checks against the real TMS (they never book a load):

```bash
cd service && npx tsx --env-file=../.env scripts/soak.ts 300
cd service && npx tsx --env-file=../.env scripts/demo-check.ts LD01157
```

## Deploy

The service ships as one Docker image and deploys with one command per environment:

```bash
./deploy.sh gcp staging
./deploy.sh gcp production
```

Google Cloud (Cloud Run, Secret Manager, Firestore) is the implemented target. The script also accepts `aws` and `azure` and prints the path for each; the image and its environment-variable contract are the same on any container platform. Production secrets are created in Google Secret Manager by the script and never stored in `.env`.

## How it was built: the project notebook

The whole build was planned and recorded in a project notebook in `docs/`: the build plan by phase, the requirements checklist, the system design, every design decision with the options considered and the trade-offs accepted, and the research behind each one (the TMS protocol probes, the FMCSA API, the Twin interface). Each decision is numbered (D-001 to D-035) and the build document refers to them by number.

To open it, open `docs/index.html` in a browser; it needs no server. Its content lives in `docs/data/*.js`.

## Repository layout

| Path | Contents |
|---|---|
| `service/` | Carrier sales service: source, tests, Dockerfile, scripts |
| `twin/migrations/` | Twin table definitions |
| `dashboard/` | Carrier Ops dashboard source |
| `docs/` | Project notebook (`index.html`, `data/`) |
| `docs/deliverables/` | Build document and appendix, summary email |
| `docs/reference/` | Full technical reference |
| `docs/research/` | TMS protocol research, probes and the QA suite with its results |
| `deploy.sh` | One-command deployment |
