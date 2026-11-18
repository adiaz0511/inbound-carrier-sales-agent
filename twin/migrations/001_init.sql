-- Twin schema, version 001 (decision D-019).
-- Twin keeps no schema history, so this file is the history. Apply the same file to both Twin
-- environments (staging and production). Never edit an applied migration; add 002, 003, ...
--
-- Rules for every table:
--   * timestamps are UTC (timestamp without time zone, always written as UTC)
--   * no one-time code is ever stored in readable form; contact details are masked in events
--   * enumerations are text with CHECK constraints, so a bad value fails loudly at write time

-- The brokerage's own, checked carrier records ("already in our records", D-008).
-- Read by the workflow's carrier-check tool, written by ops (dashboard) and seeds.
CREATE TABLE carriers (
  mc_number            text PRIMARY KEY CHECK (mc_number ~ '^[0-9]{1,8}$'),
  dot_number           int8,
  legal_name           text NOT NULL,
  contact_phone        text CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{6,14}$'),  -- E.164
  contact_email        text CHECK (contact_email IS NULL OR contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_verified_at  timestamp,
  is_demo              boolean NOT NULL DEFAULT false,  -- demo carriers for the video (real active MCs, our contact)
  is_sandbox           boolean NOT NULL DEFAULT false,  -- reviewer carriers: the only ones that accept a caller-given email
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  notes                text,
  created_at           timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at           timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

-- One row per call: the dashboard's main table. Keyed by HappyRobot's run id.
CREATE TABLE calls (
  call_id              uuid PRIMARY KEY,
  environment          text NOT NULL CHECK (environment IN ('staging', 'production')),
  started_at           timestamp NOT NULL,
  ended_at             timestamp,
  run_url              text,                       -- link to the run (transcript) in HappyRobot
  mc_number            text,
  carrier_name         text,
  fmcsa_result         text CHECK (fmcsa_result IN ('eligible', 'inactive_authority', 'not_allowed_to_operate', 'not_found', 'fmcsa_unavailable')),
  verification_status  text NOT NULL DEFAULT 'not_started'
                         CHECK (verification_status IN ('not_started', 'no_contact', 'code_sent', 'verified', 'failed')),
  verification_channel text CHECK (verification_channel IN ('sms', 'email')),
  contact_source       text CHECK (contact_source IN ('broker_records', 'fmcsa_census', 'sandbox_caller')),
  verified_at          timestamp,
  load_id              text,
  lane                 text,                       -- e.g. "Atlanta, GA -> Dallas, TX"
  equipment            text,
  posted_rate_usd      int4,
  agreed_rate_usd      int4,
  counter_rounds       int4 NOT NULL DEFAULT 0 CHECK (counter_rounds BETWEEN 0 AND 3),
  outcome              text CHECK (outcome IN (
                         'booked', 'booked_ref_pending', 'no_deal', 'not_eligible', 'not_verified', 'no_contact',
                         'no_match', 'tms_unavailable', 'caller_ended', 'error')),
  booking_ref          text,
  transferred          boolean NOT NULL DEFAULT false,  -- mocked senior-rep handoff
  notes                text,
  updated_at           timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX calls_started_at_idx ON calls (started_at DESC);
CREATE INDEX calls_outcome_idx ON calls (outcome);
CREATE INDEX calls_mc_idx ON calls (mc_number);

-- One row per negotiation round.
CREATE TABLE offers (
  offer_id             uuid PRIMARY KEY,
  call_id              uuid NOT NULL REFERENCES calls (call_id),
  load_id              text NOT NULL,
  round                int4 NOT NULL CHECK (round BETWEEN 1 AND 3),
  carrier_offer_usd    int4 NOT NULL CHECK (carrier_offer_usd > 0),
  decision             text NOT NULL CHECK (decision IN ('accept', 'counter', 'final_no_deal')),
  counter_usd          int4,
  created_at           timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE (call_id, load_id, round)
);

-- Append-only timeline of every step in a call. The service only ever inserts here.
CREATE TABLE call_events (
  event_id             uuid PRIMARY KEY,
  call_id              uuid NOT NULL REFERENCES calls (call_id),
  occurred_at          timestamp NOT NULL,
  type                 text NOT NULL CHECK (type IN (
                         'call_started', 'fmcsa_checked', 'contact_resolved', 'code_sent', 'code_wrong', 'code_verified',
                         'code_locked', 'search', 'pitch', 'offer', 'booking_attempt', 'booked', 'transfer', 'call_ended',
                         'error')),
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb   -- masked: never a code, never a full phone or email
);
CREATE INDEX call_events_call_idx ON call_events (call_id, occurred_at);

-- The broker ceiling and margin, kept apart so only screens that need margin read it (D-019, D-010).
CREATE TABLE load_pricing (
  call_id              uuid NOT NULL REFERENCES calls (call_id),
  load_id              text NOT NULL,
  posted_rate_usd      int4 NOT NULL,
  ceiling_usd          int4,                       -- MAX_BUY from the TMS; null if the token can't see it
  agreed_rate_usd      int4,
  margin_vs_ceiling_usd int4,                      -- ceiling - agreed: money kept by negotiating
  recorded_at          timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  PRIMARY KEY (call_id, load_id)
);

-- Carriers who passed FMCSA but have no usable contact on file: the ops manager's work queue.
CREATE TABLE onboarding_requests (
  request_id           uuid PRIMARY KEY,
  call_id              uuid REFERENCES calls (call_id),
  mc_number            text NOT NULL,
  carrier_name         text,
  reason               text NOT NULL CHECK (reason IN ('no_contact_on_file', 'contact_bounced', 'code_locked')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at           timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  resolved_at          timestamp,
  resolution_note      text
);
CREATE INDEX onboarding_open_idx ON onboarding_requests (status, created_at);
