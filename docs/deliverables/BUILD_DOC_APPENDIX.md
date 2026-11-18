# Build document appendix: IT review detail

The [full technical reference](https://github.com/adiaz0511/happyrobot-carrier-sales/blob/main/docs/reference/TECHNICAL_REFERENCE.md) documents the complete implementation, controls, and test detail in the repository.

## A. API surface

Bearer-token enforcement covers every route except token issuance. The workflow receives `carrier-calls`; operations routes and final reservation actions require `ops`.

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| POST | `/oauth/token` | None | Issue a 15-minute access token. |
| GET | `/health` | `carrier-calls` | Report service and TMS-breaker health. |
| GET | `/v1/diagnostics/tms` | `carrier-calls` | Run a read-only TMS echo. |
| POST | `/v1/carrier/check` | `carrier-calls` | Check authority, status, and contact. |
| POST | `/v1/verification/send` | `carrier-calls` | Apply send limits and mask the destination. |
| POST | `/v1/verification/deliver` | `carrier-calls` | Return one code to the hidden delivery step. |
| POST | `/v1/verification/check` | `carrier-calls` | Check the code and bind the carrier. |
| POST | `/v1/loads/search` | `carrier-calls` | Search eligible loads for a verified call. |
| GET | `/v1/loads/:loadId` | `carrier-calls` | Return allow-listed load details. |
| POST | `/v1/negotiation/start` | `carrier-calls` | Recheck a load and start negotiation. |
| POST | `/v1/negotiation/offer` | `carrier-calls` | Evaluate a counter within service limits. |
| POST | `/v1/reservations` | `carrier-calls` | Recheck availability and create a hold. |
| POST | `/v1/reservations/confirm` | `ops` | Claim the hold and book in the TMS. |
| POST | `/v1/reservations/release` | `ops` | Release a hold with initials and reason. |
| POST | `/v1/calls/transfer` | `carrier-calls` | Record the mocked handoff. |
| POST | `/v1/calls/end` | `carrier-calls` | Finalize the first call outcome. |
| GET | `/v1/ops/kpis` | `ops` | Return operational and KPI measures. |
| GET | `/v1/ops/holds` | `ops` | List holds for review. |
| GET | `/v1/ops/calls` | `ops` | List calls and private pricing measures. |
| GET | `/v1/ops/calls/:callId` | `ops` | Return a call, events, and offers. |
| GET | `/v1/ops/onboarding` | `ops` | List open onboarding requests. |
| POST | `/v1/ops/onboarding/:id/contacted` | `ops` | Record a contact attempt. |
| POST | `/v1/ops/carriers/:mc/contact` | `ops` | Add a validated carrier contact. |

## B. Failure modes

The build stops rather than inferring a safe result. An uncertain booking remains blocked for operations review.

| Dependency | Behavior | Timeout and retry | Caller and audit effect | Recovery |
| --- | --- | --- | --- | --- |
| Legacy TMS | Reads retry; booking uses a pre-check and at most two sends. Uncertainty becomes `booking_unresolved`. | Reads use 1.2-second attempts, four attempts, a 6.5-second budget, and a 20-second breaker after five failures. | The caller hears that the load board is unavailable. Faults enter logs and may enter Twin. | Retry reads. Reconcile unresolved bookings manually. |
| FMCSA authority API | Eligibility is not inferred during an outage. | Two 2.5-second attempts with 150-millisecond backoff. | The caller is asked to try again. The service attempts to record `fmcsa_unavailable`. | Retry after recovery. |
| FMCSA census API | A broker contact may be used; otherwise verification stops. | Two 2.5-second attempts with 150-millisecond backoff. | The caller hears that verification is unavailable. The result may enter Twin. | Retry or add a trusted contact. |
| Email delivery | The hidden step receives one code; provider receipt is unavailable. | No provider timeout or retry. Resends stay within service limits. | `code_sent` proves an approved attempt, not receipt. | Resend, check spam, or retry later. |
| Twin | Writes retry and then become best-effort; reads fail closed. | Three 3-second write attempts; one 5-second read. | Calls continue, but Carrier Ops returns 503. Final failures enter Cloud Run logs. | Reconcile from logs; add a durable outbox. |
| Firestore | Transactions protect counters and reservations. Dependency errors remain errors. | No application timeout or explicit retry policy. | The tool request fails; related Twin events may be missing. | Check commit state before retrying reservation actions. |
| Token issuance | Valid clients receive local tokens; invalid requests fail. | No external retry. Limit is 10 requests per minute. | The workflow or Carrier Ops cannot call the service. Failures exclude credentials. | Check configuration and request a new token. |

## C. Data: Twin tables

| Table | Contents |
| --- | --- |
| `carriers` | Approved identity, trusted contacts, flags, status, and notes. |
| `calls` | Timing, carrier, verification, load, rates, outcome, booking, transfer, and run data. |
| `offers` | Carrier asks, service decisions, and permitted counters by round. |
| `call_events` | Masked timeline of checks, searches, offers, reservations, bookings, errors, and call end. |
| `load_pricing` | Private ceiling, agreed rate, and retained margin. |
| `onboarding_requests` | Eligible carriers without a usable contact and their follow-up status. |

## D. Design decisions

| Decision | Approach and reason | Trade-off |
| --- | --- | --- |
| D-006 | Isolate raw-TCP TMS access behind an adapter because HappyRobot cannot open the socket or interpret partial replies safely. | The service maintains protocol and fault handling. |
| D-007 and D-021 | Keep deterministic identity, pricing, and booking rules in modular service code. | Workflow tools and service schemas must stay aligned. |
| D-010 | Keep `MAX_BUY` in the service and return only permitted public decisions. | Negotiation follows a fixed strategy. |
| D-016 | Require short-lived, environment-bound OAuth2 tokens on non-token routes. | The proof of concept operates its token endpoint. |
| D-017 | Use Firestore because Twin's available external interface could not update verification attempts, negotiation rounds, and holds atomically; Twin remains the durable record. | Two stores require separate controls and reconciliation. |
| D-018 | Keep production credentials in Secret Manager with restricted Twin keys. | Rotation requires an operator procedure. |
| D-019 | Use six Twin tables and isolate private pricing. | Each call produces several writes. |
| D-020 | Counter at 35%, 65%, and 90% of room, rounded down to $25; the third counter is final. | Some asks below the ceiling may still be declined. |
| D-024 | Expose the code only to the hidden delivery branch. | Delivery adds a workflow step without provider receipt. |
| D-025 | Let the agent create a 60-minute hold; require a representative to book. | Operations must review holds before expiry. |
| D-026 | Give Carrier Ops fixed Twin queries through a read-only key. | Dashboard availability depends on the service and Twin. |
| D-027 | Give Carrier Ops a separate client and `ops` scope. | A second credential needs rotation; initials remain separate. |
| D-030 | Permit TMS fault injection only in staging. | One setting requires code and test guards. |
| D-031 | Set safety targets and provisional business targets before QA. | Business targets await pilot evidence. |
| D-032 | Retry Twin writes, then continue the call and log the failure. | The durable record may need reconciliation. |
| D-035 | State desired prompt behavior and lead with the lost-phone resend rule. | New prompt versions require separate publication. |
