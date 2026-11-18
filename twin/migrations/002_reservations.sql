-- 002: an agreed price reserves the load; a senior rep confirms it into a TMS booking (D-025).
-- New call outcomes: reserved (held, awaiting the rep), released (hold given back).
-- New event types: reserved, reservation_released. ('booked' is now written when the rep confirms.)
-- Applied to Twin staging on 2026-11-10. Production: with the rest of P9.

BEGIN;

ALTER TABLE calls DROP CONSTRAINT calls_outcome_check;
ALTER TABLE calls ADD CONSTRAINT calls_outcome_check CHECK (outcome IN (
  'reserved', 'released', 'booked', 'booked_ref_pending', 'no_deal', 'not_eligible', 'not_verified', 'no_contact',
  'no_match', 'tms_unavailable', 'caller_ended', 'error'));

ALTER TABLE call_events DROP CONSTRAINT call_events_type_check;
ALTER TABLE call_events ADD CONSTRAINT call_events_type_check CHECK (type IN (
  'call_started', 'fmcsa_checked', 'contact_resolved', 'code_sent', 'code_wrong', 'code_verified',
  'code_locked', 'search', 'pitch', 'offer', 'reserved', 'reservation_released', 'booking_attempt', 'booked',
  'transfer', 'call_ended', 'error'));

COMMIT;
