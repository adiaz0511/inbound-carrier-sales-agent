// Response shapes of the service's ops API (service/src/routes/ops.ts, decisions D-026 to D-028).
// Twin returns every database value as text, so raw rows (calls detail, events, offers, onboarding) are typed loosely.

export type Kpis = {
  window_days: number;
  total: number;
  by_outcome: Record<string, number>;
  funnel: { calls: number; eligible: number; code_sent: number; verified: number; lockouts: number };
  time_to_verify_seconds: { avg: number | null; median: number | null };
  reservations: { reserved_total: number; reservation_rate: number | null; confirmed: number; confirmed_rate: number | null };
  negotiation: { avg_counter_rounds: number | null };
  margin: { deals: number; total_margin_usd: number; avg_margin_usd: number | null; avg_pct_of_room: number | null };
  tms: { tms_unavailable_calls: number; error_events_by_day: { day: string; count: number }[] };
};

export type Hold = {
  loadId: string;
  callId: string;
  mcNumber: string;
  carrierName: string | null;
  lane: string;
  equipment: string;
  priceUsd: number;
  status: 'reserved' | 'confirmed' | 'released';
  expiresAt: string;
  minutesLeft: number | null;
  bookingRef: string | null;
  closedReason: string | null;
};

export type CallSummary = {
  call_id: string;
  started_at: string | null;
  ended_at: string | null;
  mc_number: string | null;
  carrier_name: string | null;
  notes: string | null;
  fmcsa_result: string | null;
  verification_status: string | null;
  load_id: string | null;
  lane: string | null;
  equipment: string | null;
  posted_rate_usd: number | null;
  agreed_rate_usd: number | null;
  counter_rounds: number;
  outcome: string | null;
  transferred: boolean;
  run_url: string | null;
};

export type Row = Record<string, unknown>;

export type CallDetail = {
  call: Row;
  events: { type: string; occurred_at: string; detail: unknown }[];
  offers: Row[];
};

export type OnboardingRequest = {
  request_id: string;
  call_id: string | null;
  mc_number: string | null;
  carrier_name: string | null;
  reason: string | null;
  status: string;
  created_at: string;
};

export type BookingResult =
  | { ok: true; status: 'booked' | 'booked_ref_pending'; booking_ref: string | null; call_id: string }
  | { ok: false; reason: string; retryable?: boolean };
