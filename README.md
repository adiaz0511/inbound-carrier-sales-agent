# Inbound carrier sales agent

An AI voice agent that answers inbound calls from trucking carriers for a freight brokerage, verifies who is calling, offers a matching load, negotiates the rate and reserves the load for a human representative to confirm. It was built on the HappyRobot voice platform for a fictional mid-sized brokerage, HappyRobot Logistics, which moves about 500 loads a week with a dispatch team that could not keep up with inbound calls.

The project covers the full system: the voice workflow, a TypeScript service that enforces every business rule, an integration with an unreliable legacy TMS, an operations dashboard, automated and adversarial testing, and a one-command cloud deployment.

## The problem

Carriers call a brokerage to find their next load. At peak hours many of those calls go unanswered, and the carrier books with another broker. The calls that are answered take a dispatcher through the same steps every time: check the carrier's federal operating authority, search the load board, quote a rate and negotiate. Each dispatcher negotiates differently, which leaks margin, and there is no reliable record of what was offered or agreed.

## What a call looks like

1. The carrier opens a web call and gives an MC number. The service checks operating authority with the FMCSA, the U.S. carrier registry.
2. A one-time code goes to the contact the brokerage already has on file, not to a number the caller provides. No load is discussed until the carrier reads the code back. Stories such as "I lost my phone" or "I'm the owner" do not get around it.
3. The agent searches the TMS for open loads on the carrier's lane and equipment, and pitches one.
4. The carrier can counter up to three times. Every counter comes from the service, which knows the broker's private maximum rate; the voice model never sees it, so it cannot reveal it.
5. On agreement, the service places a 60-minute hold on the load and the agent hands the carrier to a senior representative. The representative confirms the booking in the dashboard or releases it. The agent can never book a load on its own.

Every step is recorded: calls, code checks, offers, outcomes and the private pricing, so a disputed rate becomes a lookup.

## How it is built

The central design choice is that the voice model only talks. All decisions live in a service it calls through narrow, authenticated tools, so a failure in the conversation cannot leak a price, skip verification or create a booking.

| Part | Technology | Role |
|---|---|---|
| Voice agent and workflow | HappyRobot | Runs the conversation and calls the service's tools |
| Carrier sales service | TypeScript, Fastify, Docker | OAuth2-protected API that enforces verification, negotiation, holds and audit writes (`service/`) |
| TMS adapter | TypeScript, raw TCP | Speaks the legacy fixed-width protocol, validates every reply, retries reads behind a circuit breaker and never retries a booking blindly (`service/src/tms/`) |
| Durable records | HappyRobot Twin (Postgres) | Calls, offers, events, private pricing and onboarding requests (`twin/migrations/`) |
| Live state | Firestore | Code attempts, negotiation rounds and holds, which need atomic updates |
| Operations dashboard | Next.js, deployed as a HappyRobot App | KPIs, call history, the holds queue with confirm and release, onboarding (`dashboard/`) |

The service ships as one Docker image, reads all configuration from environment variables and keeps live state behind a storage interface, so it can run on any container platform. Google Cloud Run is the implemented target.

## Evidence

- 312 automated service tests, covering the private ceiling, the verification gate, the three-round limit, reservation states and TMS faults.
- A scripted API suite run against the deployed staging service: 18 scenarios passed, none failed.
- Adversarial tests against the agent: attempts to extract the maximum rate (direct questions, budget probing, prompt injection, false market claims) and to skip verification (lost phone, owner authority, false codes). None succeeded.
- A soak test against the real TMS: 300 of 300 reads completed while the TMS failed 16% of raw requests.

## Status

This was built in November 2026 as a forward deployed engineering challenge. The live deployment, the voice workflow and the dashboard have since been shut down, so the links inside the documents no longer resolve. The code, tests and documentation are complete.

## Documentation

- [Build document](docs/deliverables/BUILD_DOC.md): the proposal for the brokerage's business and IT reviewers, with the architecture, security model, test results and return on investment. Its [appendix](docs/deliverables/BUILD_DOC_APPENDIX.md) has the API surface, failure modes, data model and design decisions.
- [Technical reference](docs/reference/TECHNICAL_REFERENCE.md): the full detail behind the build document.
- [QA results](docs/research/qa/QA_RESULTS.md): every test layer and its results.
- Project notebook: open `docs/index.html` in a browser. It records how the project was planned and built: the phases, the requirements checklist, the system design, and 35 numbered design decisions, each with the options considered and the trade-offs accepted.

## Running it

Requirements: Node.js 24, plus the values listed in `.env.example` in a git-ignored `.env`. Without TMS, FMCSA and Twin credentials, the test suite still runs, because it uses in-memory fakes.

```bash
cd service
npm install
npm test        # 312 tests
npm run dev     # local service on port 8080
```

Deployment uses one command per environment:

```bash
./deploy.sh gcp staging
./deploy.sh gcp production
```

## Repository layout

| Path | Contents |
|---|---|
| `service/` | Carrier sales service: source, tests, Dockerfile, scripts |
| `dashboard/` | Operations dashboard |
| `twin/migrations/` | Database schema |
| `docs/deliverables/` | Build document, appendix and summary email |
| `docs/reference/` | Technical reference |
| `docs/research/` | Probes and the QA suite with its results |
| `docs/` | Project notebook |
| `deploy.sh` | One-command deployment |
