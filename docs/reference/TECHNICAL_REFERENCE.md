# Technical reference

This document preserves the complete technical detail behind the build description and appendix.

## Contents

- [A. Full glossary](#a-full-glossary)
- [B. Component responsibilities and API surface](#b-component-responsibilities-and-api-surface)
- [C. Security detail](#c-security-detail)
- [D. Legacy TMS integration detail](#d-legacy-tms-integration-detail)
- [E. Reliability: failure modes](#e-reliability-failure-modes)
- [F. Data and audit trail detail](#f-data-and-audit-trail-detail)
- [G. KPI dictionary and test-layer detail](#g-kpi-dictionary-and-test-layer-detail)
- [H. Design decisions](#h-design-decisions)
- [I. Full limits and next steps list](#i-full-limits-and-next-steps-list)
- [J. Deployment and portability detail](#j-deployment-and-portability-detail)

## A. Full glossary

| No. | Term | Plain-language meaning |
|---:|---|---|
| 1 | Carrier Ops | The HappyRobot App used by operations staff to review calls, holds, onboarding requests, and performance measures, and to confirm or release reservations. |
| 2 | Firestore | Google Cloud's document database. The service uses it for short-lived call state, counters, and atomic reservation changes. |
| 3 | Cloud Run | Google's managed container platform, where the carrier sales service runs. |
| 4 | MC number | A Motor Carrier number assigned for federal operating-authority purposes. |
| 5 | DOT number | A U.S. Department of Transportation identifier. The service requires the DOT number in an FMCSA census contact to match the authority record. |
| 6 | FMCSA | The Federal Motor Carrier Safety Administration, whose data is used to check carrier authority and identity. |
| 7 | TMS | The transportation management system that stores loads, availability, private pricing, and bookings. The legacy TMS here uses raw Transmission Control Protocol (TCP) rather than the web's Hypertext Transfer Protocol (HTTP). |
| 8 | Twin | HappyRobot's structured data store for durable carrier, call, offer, event, pricing, and onboarding records. |
| 9 | Ceiling or `MAX_BUY` | The private maximum amount the broker may pay for a load. The voice model never receives it. |
| 10 | Negotiation room | The difference between the posted rate and the private ceiling. |
| 11 | Hold | A temporary reservation that keeps a load from being offered to another caller while a representative reviews it. |
| 12 | OTP or one-time code | A single-use, six-digit verification code sent to a trusted contact. |
| 13 | Allow-list | An explicit list of fields permitted to leave the service. Public load responses are built from an allow-list so private TMS fields cannot pass through. |
| 14 | OAuth2 scope | A permission on an access token. The workflow receives `carrier-calls`; Carrier Ops receives `ops`. |
| 15 | Staging and production | Separate operating environments. Staging supports development and fault tests; production uses production credentials and records. |
| 16 | KPI | A key performance indicator, meaning a defined measure used to judge safety, service, or business performance. |
| 17 | Circuit breaker | A control that temporarily stops calls to a repeatedly failing dependency so later requests fail quickly. |
| 18 | Idempotent | Safe to repeat without creating another effect after the first successful operation. |
| 19 | Atomic | Completed as one indivisible state change, so concurrent requests cannot leave a partial result. |
| 20 | D-numbers | Design-decision identifiers. The principal decisions and their trade-offs appear in Appendix H. |
| 21 | Durable outbox | A stored queue of records waiting to be delivered to another system, with replay after an outage. |
| 22 | p90 and p99 | Latency percentiles. p90 means 90% of measured requests finished at or below that time; p99 means 99% did. |
| 23 | Northstar | A HappyRobot evaluation that checks a conversation against expected agent behavior. |
| 24 | Soak test | A sustained series of operations used to observe reliability and timing under repeated work. |

## B. Component responsibilities and API surface

### Component responsibilities

| Component | Responsibility |
|---|---|
| HappyRobot workflow and voice agent | Runs the conversation, invokes narrow service tools, performs the native broker-record lookup, hides the code-delivery output from the model, and records the mocked handoff. |
| Carrier sales service | Enforces authentication, carrier eligibility, verification, load-response allow-lists, negotiation, reservations, booking state, and audit writes. |
| Firestore | Stores short-lived call state, hashed code data, counters, negotiation state, and reservation records that need atomic updates. |
| TMS adapter | Opens a fresh TCP connection per attempt, frames requests, validates replies, separates read retries from booking reconciliation, and applies the circuit breaker. |
| FMCSA authority and census APIs | Supply operating authority and a fallback trusted contact. A census contact is accepted only when its DOT number matches. |
| Twin | Stores the durable business record across six tables and provides read-only data to Carrier Ops. |
| Carrier Ops | Displays KPIs, calls, holds, onboarding work, and operations-only pricing, and sends scoped confirm or release actions. |

### API surface

Every route except token issuance requires a bearer token. The default scope is `carrier-calls`; routes under `/v1/ops/` and the two final reservation actions require `ops`.

| Method | Path | Required scope | Purpose |
|---|---|---|---|
| POST | `/oauth/token` | None | Exchange approved client credentials for a 15-minute access token. |
| GET | `/health` | `carrier-calls` | Report environment, service health, and TMS-breaker state. |
| GET | `/v1/diagnostics/tms` | `carrier-calls` | Send a read-only TMS echo for deployment diagnostics. |
| POST | `/v1/carrier/check` | `carrier-calls` | Check MC format, FMCSA authority, broker status, and trusted-contact availability. |
| POST | `/v1/verification/send` | `carrier-calls` | Approve a code send, apply limits, and return only the masked destination. |
| POST | `/v1/verification/deliver` | `carrier-calls` | Create one code and return it once to the hidden delivery step. |
| POST | `/v1/verification/check` | `carrier-calls` | Validate the spoken code and bind verification to the active carrier. |
| POST | `/v1/loads/search` | `carrier-calls` | Search normalized, open, future, unheld loads for a verified call. |
| GET | `/v1/loads/:loadId` | `carrier-calls` | Return allow-listed load details for a verified call. |
| POST | `/v1/negotiation/start` | `carrier-calls` | Recheck a load and create server-side negotiation state. |
| POST | `/v1/negotiation/offer` | `carrier-calls` | Evaluate a carrier counter against the standing offer, round count, and ceiling. |
| POST | `/v1/reservations` | `carrier-calls` | Recheck availability and create an atomic hold from verified call state. |
| POST | `/v1/reservations/confirm` | `ops` | Claim a hold and send the final TMS booking. |
| POST | `/v1/reservations/release` | `ops` | Release a reserved hold with representative initials and a reason. |
| POST | `/v1/calls/transfer` | `carrier-calls` | Record the mocked handoff for a live hold. |
| POST | `/v1/calls/end` | `carrier-calls` | Finalize the call once, using service state to determine the outcome. |
| GET | `/v1/ops/kpis` | `ops` | Return the KPI window, funnel, outcomes, timing, reservation, margin, and TMS-error measures. |
| GET | `/v1/ops/holds` | `ops` | List holds needing review, active holds, and recently closed holds. |
| GET | `/v1/ops/calls` | `ops` | List recent calls with outcome and operations-only pricing measures. |
| GET | `/v1/ops/calls/:callId` | `ops` | Return one call with its event timeline and offers. |
| GET | `/v1/ops/onboarding` | `ops` | List open onboarding requests. |
| POST | `/v1/ops/onboarding/:id/contacted` | `ops` | Record an onboarding contact attempt. |
| POST | `/v1/ops/carriers/:mc/contact` | `ops` | Add a validated email or E.164 phone number, in international `+country-code` format, to an existing carrier. |

## C. Security detail

The workflow handles identity, pricing, and booking data, so a prompt rule alone is not an adequate control. The service enforces access, verification, and pricing boundaries before the model can receive data or cause a state change.

### Authentication, authorization, and rate limits

- OAuth2 client credentials issue JSON Web Tokens signed with the symmetric HS256 algorithm. They expire after 15 minutes and are checked for algorithm, issuer, audience, environment, subject, scope, issue time, expiry, and token ID.
- The workflow client receives only `carrier-calls`. Carrier Ops receives only `ops`, which prevents the workflow from reading dashboard data or completing a booking.
- Authentication covers health checks and unmatched routes as well as business routes. Only `/oauth/token` is public.
- Token issuance allows 10 attempts per minute. The API allows 300 requests per minute, and verification routes apply a stricter limit of 30 requests per minute. These limits are per caller IP and per service instance because they are stored in memory.
- Authentication failures log the reason, caller IP, and client ID when available. Credentials and bearer tokens are not logged.

### One-time-code controls

- The service permits three distinct MC numbers per call. Changing the MC number clears the previous verification and negotiation state and releases that call's active reserved hold.
- An eligible carrier must use a contact from broker records or a DOT-matched FMCSA census record. A caller-supplied email is accepted only for a carrier marked as a sandbox carrier.
- The code contains six cryptographically generated digits and expires after 10 minutes. It is single-use and bound to the call ID and active MC number.
- Firestore stores only a keyed SHA-256 message-authentication hash (HMAC-SHA256), not the code. Comparison uses constant-time logic.
- A resend replaces the earlier code. The call permits three sends, and a carrier permits five sends across calls in a rolling hour.
- Three wrong codes lock the call. Resending does not reset the wrong-attempt count, and unclear speech that is not exactly six digits does not consume an attempt.
- Code creation and the full destination appear only in a hidden delivery step. The agent-facing response contains a safe status and masked destination.
- Every carrier-facing load, negotiation, and reservation route checks current verification in service state. Verification is invalid if the carrier identity changes.

### Pricing, reservation, and data controls

- The TMS ceiling remains in the service and the restricted `load_pricing` table. Agent-facing responses are constructed field by field from allow-lists.
- Negotiation accepts no ceiling, MC number, load price, or booking price from the model. The service reads those values from TMS data and verified call state.
- A load with a ceiling below its posted rate is treated as unavailable. No unsafe price is pitched.
- Holds and confirmation claims use Firestore transactions. One active hold can block a load, and an operations claim moves it to `confirming` before the TMS booking is sent.
- The workflow cannot reach final confirmation or release because both routes require `ops`. Carrier Ops sends its service calls from the server rather than exposing credentials in the browser.
- Twin reads use fixed SQL text with validated integers, universally unique identifiers (UUIDs), and MC numbers. Free text is sent through the writer API rather than interpolated into SQL.

### Secrets and rotation

Production secrets are stored in Google Secret Manager. The deployment script rejects local `.env` files containing `PRODUCTION_*` values, creates selected production secrets inside Secret Manager, and grants the Cloud Run identity access to individual secrets.

| Secret | Rotation procedure |
|---|---|
| OAuth signing key | Deploy a new current key and retain the former key as `OAUTH_SIGNING_KEY_PREVIOUS`. Remove the former key after the 15-minute token lifetime. |
| Workflow or operations client secret | Deploy the replacement, update the matching consumer, validate its single scope, and then disable the former secret. Rotate the two clients separately. |
| Twin writer or reader key | Create a replacement with the same restricted role, deploy it, test one permitted and one denied operation, and revoke the former key. |
| FMCSA web key | Deploy the replacement, perform a read-only authority check, and revoke the former key. URLs containing the key are not logged. |
| TMS token | Deploy an overlapping replacement and validate a read-only echo or lookup before revocation. If overlap is unavailable, use a short maintenance window. |
| One-time-code hash key | The current single-key build requires outstanding codes to drain for 10 minutes. Zero-downtime rotation requires previous-key verification, which remains a next step. |

## D. Legacy TMS integration detail

The legacy TMS can time out, return partial or malformed data, or leave a booking result uncertain. Read operations can be repeated, but booking sends require a narrower policy because a repeated booking can create an irreversible effect.

The adapter opens one TCP connection per attempt and sends one ASCII command with authentication and named fields. It reads fixed-width records until `END` or a single `ERR` line, then validates record counts, field names, widths, types, duplicate fields, unknown fields, and frame size.

### Read policy

Search, load lookup, and the booking availability pre-check are safe to repeat. Each attempt has a 1.2-second timeout. The deployed configuration permits up to four attempts inside a 6.5-second operation budget, with exponential backoff starting at 150 milliseconds plus jitter, a small random delay. Five consecutive failed operations open the circuit breaker for 20 seconds, so later requests receive a fast unavailable result rather than opening another socket.

### Booking policy

The adapter first checks that the load is still open. It then sends `LOAD_BOOK` no more than twice. If the first result is a timeout, cut-off reply, closed connection, transient server error, or malformed success, the second send can use the token-scoped `ALREADY_BOOKED` result to determine that the first attempt landed. If the adapter still cannot confirm the result, the reservation becomes `booking_unresolved`; the system does not release it or send another booking automatically.

The recorded soak test completed 300 of 300 read operations after retries at a 16.2% raw fault rate. The p90 latency was 818 milliseconds, and p99 was about 4.2 seconds. Staging can simulate down, timeout, or malformed behavior; production refuses to start unless that switch is off.

## E. Reliability: failure modes

Dependency failures must preserve safety even when they interrupt the caller's path. The current build favors a clear stop over guessing, and it leaves ambiguous bookings blocked for operations review.

| Dependency | System behavior | Timeout and retry | What the caller hears | Audit effect | Recovery |
|---|---|---|---|---|---|
| Legacy TMS | Reads retry under the read policy. Booking uses an availability pre-check and at most two sends; an uncertain result becomes `booking_unresolved`. | Reads: 1.2 seconds per attempt, up to four attempts, 6.5-second budget, backoff, and a 20-second breaker after five failed operations. Booking: the pre-check plus no more than two booking sends. | Search or recheck: “The load board is not responding right now.” Booking happens after the call and is handled in Carrier Ops. | TMS faults and breaker events enter Cloud Run logs. A call ended for this reason can record `tms_unavailable` in Twin. An uncertain booking records an error event when Twin is available. | Retry a read when appropriate. For `booking_unresolved`, check the TMS manually before changing any state. |
| FMCSA authority API | The service does not infer eligibility when the API is unavailable. | 2.5 seconds per attempt, two attempts, and 150-millisecond backoff. | The carrier lookup is unavailable and the caller is asked to try again in a few minutes. | The service attempts to record `fmcsa_unavailable`; a Twin failure is logged separately. | Retry on a later call after the FMCSA dependency recovers. |
| FMCSA census API | The service may use an existing broker contact. If no broker contact exists and census lookup fails, verification stops without creating a no-contact onboarding request. | 2.5 seconds per attempt, two attempts, and 150-millisecond backoff. | The verification system is unavailable and the caller is asked to try again in a few minutes. | The service attempts to record `contact_resolved` with `census_unavailable`. | Retry after the census API recovers or add a trusted broker contact through Carrier Ops. |
| Email delivery | The hidden workflow step receives the code once. The service has no provider receipt and no delivery-failure callback. | No delivery timeout or provider retry is implemented in the service. A caller can request a new code within the send limits. | The workflow says the code was sent and can offer a resend if it does not arrive. | `code_sent` records an approved send attempt before provider delivery; it does not prove receipt. | Resend within the call and carrier limits, check spam, or retry on a later call. Add delivery receipts with an approved SMS or email integration. |
| Twin | Business-path writes are awaited, retried, and then treated as best-effort. Carrier Ops reads fail closed with HTTP 503. | Writes: 3 seconds per request, up to three attempts with backoff. Reads: one 5-second request. | A logging failure does not stop the carrier call. Carrier Ops reports Twin as unavailable rather than displaying partial query results. | Final write failure creates `audit_write_failed` in Cloud Run logs, but the intended Twin row can remain missing. | Reconcile from logs manually. Add a durable outbox and replay worker. |
| Firestore | Transactions protect counters and reservation changes. A dependency error is not converted into a business response. | No application timeout or explicit retry policy is set around the Firestore client. | No dependency-specific caller script is defined; the tool request fails. | Live state or the requested transition may be unavailable, and a related Twin event may not be written. | Retry only after checking whether the operation committed, especially for reservation actions. Add alerting and an incident procedure. |
| Token issuance | Valid clients receive a locally signed token. Bad grants return 400; bad credentials return 401; bad service configuration prevents startup. | No external call, timeout, or retry is involved. Token requests are limited to 10 per minute. | The carrier does not interact with token issuance. The workflow or Carrier Ops cannot call the service until authentication succeeds. | `auth_failed` logs the reason and IP without credentials. | Check the client ID, secret version, environment, signing key, and scope, then request a new token. |

## F. Data and audit trail detail

Operations needs a durable account of each call without putting live enforcement or private codes into the reporting store. Twin holds the business history; Firestore holds the state that must change atomically during a call.

### Twin records

| Table | Contents |
|---|---|
| `carriers` | Broker-approved identity, trusted contacts, demonstration and sandbox flags, status, and notes. |
| `calls` | Run timing, MC number, carrier, authority and verification results, selected load, public and agreed rates, rounds, outcome, booking reference, transfer status, run link, and notes. |
| `offers` | One row per negotiation round, including the carrier ask, service decision, and permitted service counter. |
| `call_events` | Append-oriented timeline of checks, code status, searches, pitches, offers, reservations, booking attempts, bookings, transfers, errors, and call end. Details are masked and never contain the code. |
| `load_pricing` | The private ceiling, agreed rate, and retained margin for operations-only use. |
| `onboarding_requests` | Eligible carriers without a usable contact and the follow-up status. |

Migration 001 creates the six tables. Migration 002 adds `reserved` and `released` call outcomes plus their event types; it does not create another table. The production proof record states that both migrations were applied to production.

### Firestore state

Firestore stores the active carrier and full trusted contact, the keyed code hash, expiry and attempt counters, verification binding, negotiation state, call outcome, and reservation state. Call state is treated as expired after two hours. Reservations keep their own expiry and remain available to Carrier Ops as historical Firestore documents.

Full contact data is used only to deliver the code and is never returned to the model or written unmasked into call events. However, the project does not yet define a complete retention, physical deletion, backup, restore, personally identifiable information (PII), or transcript policy. Appendix I makes that policy an explicit next step.

### Audit delivery

Twin inserts use client-generated identifiers so a retry cannot create a second event. The writer can insert and update the required records but does not delete events. After three failed write attempts, the carrier path continues and Cloud Run logs `audit_write_failed`. This preserves call availability but does not provide guaranteed audit delivery; the missing durable outbox is the principal audit limitation.

## G. KPI dictionary and test-layer detail

Safety claims require more than a successful demonstration, while business measures require enough real traffic to be meaningful. The test record separates deterministic controls, staged scenarios, model behavior, and the small production proof.

### Recorded test layers

The QA record is dated November 11, 2026. Its 312 of 312 service-test result is a recorded run from the project environment, not a claim about every later local environment.

| Test layer | What it tested | Recorded result |
|---|---|---|
| Service tests | Ceiling privacy, carrier-bound verification, three-round call limit, atomic reservations, OAuth scopes, TMS faults, inconsistent TMS pricing, and the production fault-switch guard. | 312 of 312 passed. |
| Scripted staging API suite | Standard calls, edge cases, security controls, carrier switching, call-wide rounds, and inconsistent-ceiling handling. | 18 passed, 0 failed, and 1 was blocked because no safe staging fixture existed. The suite did not call final confirmation. |
| HappyRobot northstars | Nine plain-language scenario checks for verification behavior, negotiation, safe wording, short turns, and clear numbers. | On Version 18, all nine tests passed in all 19 runs: four ordinary tests ran once each, and five ceiling-extraction tests ran three times each. |
| Model comparison | The same scenario set compared two workflow versions to choose the model and prompt before the final prompt revision. | Version 14 using `gpt-4.1` passed 23 of 27 runs. Version 15 using `gpt-5.6-luna` passed 22 of 27, so `gpt-4.1` was retained. |
| Verification attacks | Lost phone, claimed owner authority, and false codes attempted to bypass verification. | All three passed after the Version 18 prompt fix; the service gate remained the enforcement boundary. |
| Production proof | One live path ended after three counter rounds with no deal and no transfer. A separate path verified, reserved, transferred, and was confirmed once by a representative. | Both paths completed on November 11, 2026. These are proof cases, not production performance samples. |

“Prompt tests” are isolated conversations with predefined caller messages and expected behaviors. Tools are mocked when the test needs a verified state because simulated callers cannot read a real emailed code. They test what the model says and which tool it chooses; service tests separately prove that a real unverified request cannot reach load or reservation data.

### KPI evidence from QA

| KPI | Target | Recorded result and scope |
|---|---:|---|
| Ceiling disclosures | 0 | 0 in agent-facing API scans and five ceiling-extraction scenarios. |
| Verification bypasses | 0 | 0 in three bypass attacks and service gate tests. |
| Bookings above ceiling | 0 | 0 in strategy tests across about 250 posted-rate and ceiling combinations. |
| Verification pass rate | At least 85% | 71% in seeded data that deliberately included ineligible carriers, lockouts, and false-code cases. |
| Time to verify | At most 90 seconds | 4 to 16 seconds through the API and about 30 to 45 seconds in live calls. |
| Reservation rate among verified calls | At least 35% | 50% in the small seeded mix. |
| Negotiation room retained | At least 25% | 27% in the small seeded mix. |
| TMS operations successful after retries | At least 99% | 100% of 300 read operations in the soak test at a 16.2% raw fault rate. |

The safety results support the implemented controls within the tested cases. The conversion, timing, and margin results come from small scripted samples and should not be treated as forecasts.

### KPI dictionary

| KPI | Formula and denominator | Data source | Target |
|---|---|---|---:|
| Ceiling disclosures | Count of agent-facing responses or audited utterances that reveal the private ceiling. | API response scans and HappyRobot audits. | 0 |
| Verification bypasses | Count of load, negotiation, or reservation actions accepted without current carrier-bound verification. | Service tests, API tests, and call event review. | 0 |
| Above-ceiling bookings | Count of bookings where agreed rate is greater than ceiling. | `load_pricing` joined to booked calls. | 0 |
| Verification pass rate | Verified calls divided by calls that reached a code-sent, verified, or failed verification state. | `calls.verification_status`; Carrier Ops funnel. | At least 85% |
| Time to verify | `verified_at - started_at` for verified calls; dashboard reports average and median. | `calls`; Carrier Ops KPI query. | At most 90 seconds |
| Reservation rate | Calls with reserved, released, booked, or booked-reference-pending outcomes divided by verified calls. | `calls`; Carrier Ops KPI query. | At least 35% |
| Confirmation rate | Booked or booked-reference-pending calls divided by reserved, released, booked, or booked-reference-pending calls. | `calls`; Carrier Ops KPI query. | Set after pilot baseline |
| Negotiation room retained | Average of `(ceiling - agreed rate) / (ceiling - posted rate)` for qualifying deals with a positive room. | `load_pricing` joined to `calls`. | At least 25% |
| TMS success after retries | Completed TMS read operations divided by attempted TMS read operations. | Soak-test results; production success telemetry is not yet exposed by Carrier Ops. | At least 99% |

## H. Design decisions

The main design choices protect identity and pricing while keeping a representative responsible for the permanent booking. Their costs are operational complexity, two data stores, and manual review when a booking result is uncertain.

| Decision | Chosen approach and reason | Concrete trade-off |
|---|---|---|
| D-006 | Isolate the raw-TCP TMS behind a TypeScript adapter with new sockets, reply validation, read retries, booking reconciliation, and a circuit breaker. HappyRobot cannot open the required socket or safely interpret partial replies. | The service must maintain a legacy protocol adapter and monitor connection faults. |
| D-007 and D-021 | Keep the workflow thin and put deterministic identity, pricing, and booking rules in modular service code. | Workflow tool contracts and service request schemas must change together. |
| D-010 | Keep `MAX_BUY` inside the service and return only a decision and permitted public price. | Negotiation follows a fixed strategy instead of allowing the model to improvise. |
| D-016 | Protect every non-token route with short-lived, environment-bound OAuth2 tokens. | The proof of concept operates its own token endpoint; a larger deployment should use a managed identity provider. |
| D-017 | Use Firestore for atomic live state and Twin for durable reporting. | Two stores require separate access controls, health checks, and reconciliation. Staging and production currently share one Firestore database with prefixed collections. |
| D-018 | Store production credentials in Secret Manager and use separate restricted Twin writer and reader keys. | Secret creation, consumer updates, and rotation require an operator procedure. |
| D-019 | Use six Twin tables and isolate private pricing in `load_pricing`. | A call produces several writes, and append-only event behavior depends on service and key permissions rather than a database immutability feature. |
| D-020 | Counter at 35%, 65%, and 90% of the negotiation room for rounds one through three, rounded down to $25 and never above the ceiling. The third counter is final. | A carrier asking between the final offer and the ceiling may be lost so that the ceiling remains private and the final offer stays below it. |
| D-024 | Generate and expose the code only inside a hidden delivery branch; return the model only a masked destination and safe status. | Delivery requires an extra workflow step, and provider receipt is not captured by the service. |
| D-025 | Let the agent create a 60-minute hold and require a representative to send the permanent TMS booking. | Firestore must maintain the reservation state, and operations must review holds before they expire. |
| D-026 | Let Carrier Ops read Twin through fixed, validated service queries using a read-only key. | Dashboard availability adds another service and Twin dependency. |
| D-027 | Give Carrier Ops a separate OAuth client and `ops` scope. | A second credential must be rotated, and the current token identifies the application rather than an individual representative, so initials are collected separately. |
| D-030 | Permit TMS fault injection only in staging and reject production startup when it is enabled. | Staging carries one additional setting that must remain guarded by code and tests. |
| D-031 | Set zero-tolerance safety targets and provisional business targets before final QA. | Business targets remain hypotheses until the pilot provides real traffic. |
| D-032 | Retry Twin writes but allow the carrier call to continue after final failure, with `audit_write_failed` in Cloud Run logs. | A durable record can remain incomplete until manual reconciliation or a future outbox replay. |
| D-035 | State desired prompt behavior without repeating forbidden phrases, and place the lost-phone resend rule first. | The prompt must be published separately as a new version in Development and Production. |

## I. Full limits and next steps list

The proof of concept has passed its recorded safety tests, but production readiness also depends on communications, identity, audit delivery, monitoring, data governance, and capacity planning. The following work should preserve the current service-side gates.

1. Run a controlled production pilot with known carriers, named operations owners, a fixed observation window, and baseline measures for answer rate, handling time, conversion, margin, and representative effort.
2. Add an approved SMS sender, retain email as a fallback, and capture delivery receipts and failures without exposing the code to the model.
3. Replace the mocked handoff with a phone entry point and tested senior-representative queue while retaining reservation-first booking control.
4. Replace self-reported initials with platform identity and restrict ceiling, margin, booking, and onboarding views by role.
5. Obtain written TMS time-zone semantics for pickup and delivery timestamps, then add daylight-saving regression tests if the zone is not UTC.
6. Add a durable Twin outbox with stable event IDs, replay, reconciliation status, and an owner for unresolved gaps.
7. Move token issuance to a managed identity provider and evaluate centralized edge rate limits and mutual TLS if the threat model or traffic requires them.
8. Separate Firestore infrastructure by environment when cost constraints no longer justify prefixed collections in one database.
9. Implement and test previous-key verification for zero-downtime one-time-code hash-key rotation.
10. Define SLOs and alert rules for authentication, TMS latency and breaker state, FMCSA failures, Firestore errors, Twin write gaps, and unresolved bookings. Assign severity, owner, escalation path, and response runbook to each alert.
11. Approve a data policy that classifies contact data, codes, pricing, transcripts, and logs; defines retention and deletion; documents backup and restore; and sets a reconciliation deadline for missing audit records.
12. Measure calls per minute, concurrent calls, TMS socket pressure, Firestore transaction load, Twin request volume, and token traffic. Use those results to set instance, concurrency, quota, and centralized-rate-limit triggers.
13. Write a deployment and rollback runbook covering prerequisites, Twin migration order, smoke checks, Cloud Run revision rollback, secret rollback, schema compatibility, workflow-version rollback, and post-rollback verification.

## J. Deployment and portability detail

The deployment keeps staging and production credentials separate and caps the proof of concept's runtime footprint. Operations can run the current system, but rollback, alert thresholds, and capacity triggers still need formal runbooks.

### Deployment

One command builds and deploys each Google Cloud environment:

```bash
./deploy.sh gcp staging
./deploy.sh gcp production
```

The script checks Google authentication, enables Cloud Run, Cloud Build, Artifact Registry, Secret Manager, and Firestore, grants the build and datastore roles, synchronizes secrets, builds the Docker image, and deploys the service. Twin migrations are maintained separately in `twin/migrations` and are not applied by `deploy.sh`.

Cloud Run is configured with scale-to-zero, no more than two instances, 1 CPU, 512 MiB of memory, 40 concurrent requests per instance, and startup CPU boost. Staging and production run separate Cloud Run services. Both use the same image contract, while their credentials, Twin environment, Firestore collection prefixes, OAuth issuer and audience, and TMS fault settings remain environment-bound.

HappyRobot Version 18 is published to Development with staging integrations. The same final prompt is published as Version 19 to Production with production credentials and Twin settings. Production startup rejects any TMS fault mode other than `off`.

### Current operations

Carrier Ops is the standard interface for calls, holds, onboarding, and final booking actions. Cloud Run logs expose authentication failures, TMS faults and breaker events, unresolved booking attempts, and `audit_write_failed`. HappyRobot provides run transcripts and 100% audit sampling for the active northstars.

No service-level objectives (SLOs), alert thresholds, escalation owners, or automated rollback procedure are defined yet. Until they are, the logs are evidence sources rather than a complete monitoring and incident-response system.

### Portability limits

The Docker image and environment-variable contract can run on another container platform, and the script documents unimplemented AWS and Azure paths. Only Google Cloud Run is implemented. A move would require replacements for Secret Manager, Cloud identity, logs, Firestore's transactional state, network access to the TMS, deployment checks, and rollback procedures.
