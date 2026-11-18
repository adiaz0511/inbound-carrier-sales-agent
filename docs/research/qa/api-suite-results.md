# Staging API Suite Results

- Date: 2026-11-11T00:46:31.367Z
- Base URL: https://carrier-sales-staging-891703837363.us-central1.run.app
- Totals: 19 cases; 18 PASS; 0 FAIL; 1 BLOCKED

| id | scenario | requirement | result | detail |
|---|---|---|---|---|
| STD-S1 | S1 no deal after three rounds | S1; D-029; D-031 ceiling disclosure 0 and correct no-deal outcome | PASS | Three nondecreasing counters ended in no_deal without a ceiling disclosure. |
| STD-S2 | S2 deal, reserve, transfer, end, release | S2; D-029; reservation is held and transferred without TMS confirmation | PASS | Outcome was reserved; the hold was transferred and then released with the ops token. |
| STD-WALK | Walk away after pitch | Standard walk-away; a pitched call ends as no_deal | PASS | Pitched call ended with no_deal and no reservation or transfer. |
| EDGE-MC1 | MC 1 not eligible | S3; inactive authority is rejected before verification | PASS | Carrier check returned not_eligible and no code was sent. |
| EDGE-MC99999999 | MC 99999999 not found | S4; unknown MC is handled without verification | PASS | Carrier check returned not_found and no code was sent. |
| EDGE-NOMATCH | No matching loads | S9; an empty board search ends with no_match | PASS | Empty search returned count 0 and the recorded outcome was no_match. |
| EDGE-LOCK | Three wrong codes lock verification | S6; three wrong codes lock the call and load search remains gated | PASS | Third wrong code locked the call; search returned 403 not_verified. |
| EDGE-GARBAGE | Garbage code does not consume an attempt | Verification edge; unclear input preserves all three attempts | PASS | Input abc returned unclear with three attempts left. |
| EDGE-PREVERIFY | Search before verification | S5; service-side verification gate refuses load search | PASS | Search returned HTTP 403 not_verified before any code was sent. |
| REG-IDENTITY | Verified carrier identity cannot be reused | Audit 4.1; changing MC clears identity state and requires a new code | PASS | MC change blocked search, negotiation, and reservation until the replacement carrier completed its own code check. |
| REG-ROUNDS | Counter limit is call-wide | Audit 4.4; restarting negotiation cannot reset the three-counter limit | PASS | After three counters, a new negotiation start returned closed and no reservation was created. |
| REG-CEILING | Inconsistent ceiling is not pitchable | Audit 4.5; MAX_BUY below posted rate is refused and logged | BLOCKED | QA_INCONSISTENT_LOAD_ID is not configured; no staging TMS record was changed |
| EDGE-RESERVE | Reserve before agreement | Reservation guard; no hold exists until negotiation records agreement | PASS | Reservation returned no_agreed_price before any offer was accepted. |
| EDGE-TRANSFER | Transfer before reserve | Transfer guard; only a live reservation may transfer | PASS | Transfer returned not_reserved. |
| EDGE-END2 | Second end_call is idempotent | Call finalization; a repeated end cannot change the outcome | PASS | Second end_call returned OK and the outcome remained no_match. |
| SEC-UNKNOWN | Unknown price and ceiling fields | Strict schemas reject agent-supplied agreement and ceiling values | PASS | Both unknown-field requests returned HTTP 400 invalid_request. |
| SEC-SCOPES | Token scopes and missing token | D-029 security layer; workflow, ops, and absent credentials are isolated | PASS | Wrong scopes returned 403; missing credentials returned 401; no confirmation request was sent. |
| SEC-DELIVER2 | Deliver endpoint called twice | D-024 hidden delivery is one-time and returns no second code | PASS | Second delivery returned nothing_to_deliver and exposed no code. |
| SEC-CEILING | Whole-run agent response scan | S7; D-031 ceiling disclosed 0 across every agent-facing response | PASS | Scanned 96 agent-facing responses; no forbidden key or documented ceiling value appeared. |
