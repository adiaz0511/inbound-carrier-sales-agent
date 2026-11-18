# Carrier Ops dashboard

Ops dashboard for the inbound carrier sales voice agent. Senior reps use it to see KPIs, calls, holds and carrier onboarding, and to confirm or release holds. It is planned to become a HappyRobot App (Next.js, App Router, Vercel).

## Environment variables (server only)

| Name | Purpose |
| --- | --- |
| `SERVICE_BASE_URL` | Base URL of the carrier sales service |
| `OPS_CLIENT_ID` | OAuth client id for the ops scope |
| `OPS_CLIENT_SECRET` | OAuth client secret (never sent to the browser) |
| `DASHBOARD_ENV_LABEL` | Optional label shown under the title. Default `staging` |

Put them in `.env.local` (git-ignored). Never prefix them with `NEXT_PUBLIC_`.

## Run

```
npm install
npm run dev     # local development
npm run build   # production build and type check
```

## How it talks to the service

All service calls happen on the server: server components, and server actions in `app/**/actions.ts`. `lib/service.ts` gets an ops token with the client credentials, caches it until 60 s before it expires, and retries once on 401. The browser never sees the secret or the token, and never calls the service directly.

## Decisions

- D-026: the dashboard reads through the service's ops API (`/v1/ops/*`).
- D-027: the dashboard has its own OAuth client with the `ops` scope only.
- D-028: the KPIs and the senior-rep actions (confirm, release, onboarding contact) shown here.
