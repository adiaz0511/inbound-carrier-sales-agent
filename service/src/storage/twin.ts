// Durable call records in Twin (decision D-019), written through the Twin REST API.
//
// - Only inserts and updates by primary key: the service never deletes, and never updates call_events
//   (append-only audit trail). The key it uses carries a 'Twin writer' role (D-018).
// - Every insert carries a client-generated UUID primary key, so a retried insert can't duplicate a row:
//   a "duplicate key" answer to a retry means the first attempt landed.
// - Writes are awaited inside the request. On Cloud Run's request-based billing the CPU is only
//   allocated while a request is in flight, so "fire and forget after replying" can stall (R-32).
// - The REST API takes every value as a string (R-22); objects become JSON text for jsonb columns.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type TwinEnvironment = 'staging' | 'production';
type Value = string | number | boolean | Date | Record<string, unknown> | null | undefined;
type Row = Record<string, Value>;

export interface TwinWriterOptions {
  apiKey: string;
  environment: TwinEnvironment;
  baseUrl?: string;               // default https://platform.happyrobot.ai/api/v2
  timeoutMs?: number;             // per request (default 3000)
  maxAttempts?: number;           // default 3
  fetchImpl?: typeof fetch;
  log?: (event: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class TwinWriteError extends Error {
  constructor(readonly table: string, readonly status: number | 'network', detail: string) {
    super(`Twin write to ${table} failed (${status}): ${detail}`);
  }
}

function encode(row: Row): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null) continue; // omit: the column keeps its default / stays null
    if (v instanceof Date) out[k] = v.toISOString().replace('Z', ''); // UTC, stored without zone
    else if (typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = String(v);
  }
  return out;
}

export class TwinWriter {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: TwinWriterOptions) {
    this.base = (o.baseUrl ?? 'https://platform.happyrobot.ai/api/v2').replace(/\/$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Insert a row. `idColumn` names its UUID primary key, filled in if absent. Returns the id.
   * `idempotent`: the key is meaningful (e.g. the call's run id), so "already exists" on any attempt
   * means the row is there; used when the workflow may repeat a step.
   */
  async insert(table: string, row: Row, idColumn?: string, idempotent = false): Promise<string | undefined> {
    const values = { ...row };
    if (idColumn && !values[idColumn]) values[idColumn] = randomUUID();
    await this.request('POST', table, { values: encode(values) }, { duplicateIsSuccess: true, anyAttempt: idempotent });
    return idColumn ? String(values[idColumn]) : undefined;
  }

  /** Update one row by primary key. */
  async update(table: string, primaryKey: Record<string, string>, updates: Row): Promise<void> {
    await this.request('PATCH', table, { primaryKey, updates: encode(updates) }, { duplicateIsSuccess: false });
  }

  private async request(method: 'POST' | 'PATCH', table: string, body: unknown, opts: { duplicateIsSuccess: boolean; anyAttempt?: boolean }): Promise<void> {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`invalid table name ${table}`);
    const maxAttempts = this.o.maxAttempts ?? 3;
    let last = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 3000);
      try {
        const res = await this.fetchImpl(`${this.base}/twin/tables/${table}/rows`, {
          method,
          headers: {
            Authorization: `Bearer ${this.o.apiKey}`,
            'Content-Type': 'application/json',
            'x-twin-environment': this.o.environment,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (res.ok) return;
        const text = (await res.text()).slice(0, 300);
        // A retried insert whose first attempt landed: the row is there, which is what we wanted.
        if (opts.duplicateIsSuccess && (attempt > 1 || opts.anyAttempt) && /duplicate key|already exists|unique/i.test(text)) return;
        if (res.status === 429 || res.status >= 500) { last = `${res.status} ${text}`; }
        else throw new TwinWriteError(table, res.status, text); // 4xx: our request is wrong, retrying won't help
      } catch (e) {
        if (e instanceof TwinWriteError) throw e;
        last = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message;
      } finally {
        clearTimeout(timer);
      }
      this.o.log?.({ event: 'twin_write_retry', table, attempt, reason: last.slice(0, 120) });
      if (attempt < maxAttempts) await this.sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
    }
    throw new TwinWriteError(table, 'network', last);
  }
}

// --- Typed helpers for our tables (column names match twin/migrations/001_init.sql) ---

export type CallOutcome =
  | 'reserved' | 'released' | 'booked' | 'booked_ref_pending' | 'no_deal' | 'not_eligible' | 'not_verified' | 'no_contact'
  | 'no_match' | 'tms_unavailable' | 'caller_ended' | 'error';

export type EventType =
  | 'call_started' | 'fmcsa_checked' | 'contact_resolved' | 'code_sent' | 'code_wrong' | 'code_verified'
  | 'code_locked' | 'search' | 'pitch' | 'offer' | 'reserved' | 'reservation_released' | 'booking_attempt' | 'booked'
  | 'transfer' | 'call_ended' | 'error';

// Mirrors the CHECK constraints in twin/migrations/001_init.sql. Twin answers a constraint violation with a
// generic 500 (R-33), which looks like an outage and gets retried, so values are checked here first and an
// invalid one fails at once with a clear message.
const callUpdate = z.object({
  ended_at: z.date(),
  mc_number: z.string().regex(/^[0-9]{1,8}$/),
  carrier_name: z.string().max(200),
  fmcsa_result: z.enum(['eligible', 'inactive_authority', 'not_allowed_to_operate', 'not_found', 'fmcsa_unavailable']),
  verification_status: z.enum(['not_started', 'no_contact', 'code_sent', 'verified', 'failed']),
  verification_channel: z.enum(['sms', 'email']),
  contact_source: z.enum(['broker_records', 'fmcsa_census', 'sandbox_caller']),
  verified_at: z.date(),
  load_id: z.string().regex(/^LD\d{1,10}$/),
  lane: z.string().max(200),
  equipment: z.string().max(20),
  posted_rate_usd: z.number().int().positive(),
  agreed_rate_usd: z.number().int().positive(),
  counter_rounds: z.number().int().min(0).max(3),
  outcome: z.enum(['reserved', 'released', 'booked', 'booked_ref_pending', 'no_deal', 'not_eligible', 'not_verified', 'no_contact', 'no_match', 'tms_unavailable', 'caller_ended', 'error']),
  booking_ref: z.string().max(100),
  transferred: z.boolean(),
  notes: z.string().max(4000),
}).partial().strict();
export type CallUpdate = z.infer<typeof callUpdate>;

export class InvalidRecord extends Error {}

function check<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new InvalidRecord(`${what}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return r.data;
}

export class CallRecords {
  constructor(private readonly twin: TwinWriter, private readonly environment: TwinEnvironment) {}

  startCall(callId: string, runUrl?: string): Promise<string | undefined> {
    return this.twin.insert('calls', { call_id: callId, environment: this.environment, started_at: new Date(), run_url: runUrl }, undefined, true);
  }

  async updateCall(callId: string, fields: CallUpdate): Promise<void> {
    const valid = check(callUpdate, fields, 'call update');
    return this.twin.update('calls', { call_id: callId }, { ...valid, updated_at: new Date() });
  }

  /** Append-only. `detail` must already be masked: never a code, never a full phone or email. */
  event(callId: string, type: EventType, detail: Record<string, unknown> = {}): Promise<string | undefined> {
    return this.twin.insert('call_events', { call_id: callId, occurred_at: new Date(), type, detail }, 'event_id');
  }

  async offer(callId: string, loadId: string, round: number, carrierOfferUsd: number, decision: 'accept' | 'counter' | 'final_no_deal', counterUsd?: number) {
    check(z.number().int().min(1).max(3), round, 'offer round');
    check(z.number().int().positive(), carrierOfferUsd, 'carrier offer');
    if (counterUsd !== undefined) check(z.number().int().positive(), counterUsd, 'counter');
    return this.twin.insert('offers', { call_id: callId, load_id: loadId, round, carrier_offer_usd: carrierOfferUsd, decision, counter_usd: counterUsd }, 'offer_id');
  }

  pricing(callId: string, loadId: string, postedRateUsd: number, ceilingUsd: number | undefined, agreedRateUsd?: number) {
    const margin = ceilingUsd !== undefined && agreedRateUsd !== undefined ? ceilingUsd - agreedRateUsd : undefined;
    return this.twin.insert('load_pricing', { call_id: callId, load_id: loadId, posted_rate_usd: postedRateUsd, ceiling_usd: ceilingUsd, agreed_rate_usd: agreedRateUsd, margin_vs_ceiling_usd: margin });
  }

  onboardingRequest(callId: string, mcNumber: string, carrierName: string | undefined, reason: 'no_contact_on_file' | 'contact_bounced' | 'code_locked') {
    return this.twin.insert('onboarding_requests', { call_id: callId, mc_number: mcNumber, carrier_name: carrierName, reason }, 'request_id');
  }

  /** Ops: record a contact attempt on an open onboarding request. It stays open until the carrier's contact is saved. */
  onboardingContacted(requestId: string, resolutionNote: string): Promise<void> {
    return this.twin.update('onboarding_requests', { request_id: requestId }, { resolution_note: resolutionNote });
  }

  /** Ops: set a known carrier's contact details. Validation (E.164, email) is done by the route before this. */
  carrierContact(mcNumber: string, contact: { email?: string; phone?: string }): Promise<void> {
    return this.twin.update('carriers', { mc_number: mcNumber }, { contact_email: contact.email, contact_phone: contact.phone, updated_at: new Date() });
  }
}

/** Masks contact details for the audit trail: "+1•••••••42", "j•••@acme.com". */
export function maskContact(value: string): string {
  if (value.includes('@')) {
    const [user, domain] = value.split('@');
    return `${user!.slice(0, 1)}•••@${domain}`;
  }
  return value.length <= 4 ? '••••' : `${value.slice(0, 2)}${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-2)}`;
}
