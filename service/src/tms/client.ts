// TMS client: the only part of the system that talks to the legacy TMS (decision D-006).
//
// Reliability rules, from the spec and our live measurements (R-11 to R-18):
//   - Each attempt opens a fresh TCP connection, with its own timeout well under the server's 30 s idle close,
//     and stops reading at END/ERR (wire.ts).
//   - Faults are silent (timeout, cut-off reply, garbled reply, held-open connection), so every reply is
//     validated field by field (records.ts) and anything off counts as a fault.
//   - Searches and lookups are safe to repeat, so faults are retried with short, jittered backoff inside a
//     fixed overall time budget (a live call can't wait long).
//   - A booking is NOT safe to blindly repeat. Bookings are scoped to our token and monotonic (spec,
//     LOAD_BOOK): once our token has booked a load, every later LOAD_BOOK on it returns ALREADY_BOOKED.
//     So after an ambiguous fault we resend once; ALREADY_BOOKED then means our earlier attempt landed.
//     A pre-check (LOAD_GET status OPEN) tells that apart from a load that was already gone.
//   - A circuit breaker stops calling a TMS that keeps failing, so callers get a fast, clear answer.
//   - Error codes are mapped by meaning; codes we don't know are treated as a generic failure (the spec says
//     its list isn't exhaustive, and live codes already differ: NOT_FOUND vs UNKNOWN_LOAD).

import { buildLine, sendRequest, type WireOptions, type WireOutcome } from './wire.js';
import { MalformedRecord, parseBooking, parseDetail, parseSummary, type LoadDetail, type LoadSummary } from './records.js';

export type TmsFailure =
  | { kind: 'unavailable'; reason: string }                // faults persisted, breaker open, or auth/server trouble
  | { kind: 'rejected'; code: string; message: string };   // the TMS refused the request itself (bad filter etc.)

export type Result<T> = { ok: true; value: T } | { ok: false; error: TmsFailure };

export type BookingOutcome =
  | { status: 'booked'; bookingRef: string; confirmed: true }
  | { status: 'booked'; bookingRef: null; confirmed: false }   // landed, but the reply with the reference was lost
  | { status: 'not_available' }                                // booked or gone before we tried
  | { status: 'not_found' }
  | { status: 'invalid_rate' };

export interface SearchFilters {
  ORIG_CITY?: string; ORIG_STATE?: string; ORIG_ZIP?: string;
  DEST_CITY?: string; DEST_STATE?: string; DEST_ZIP?: string;
  EQTYPE?: string;
  MAX_RESULTS?: number;
}

export type TmsFaultMode = 'off' | 'down' | 'timeout' | 'garbage';

export interface TmsClientOptions extends WireOptions {
  token: string;
  faultMode?: TmsFaultMode;
  maxAttempts?: number;        // per read operation (default 3)
  budgetMs?: number;           // overall time budget per read operation (default 6500)
  backoffMs?: number;          // base backoff between attempts (default 150, doubled, plus jitter)
  breakerThreshold?: number;   // consecutive failed operations before opening (default 5)
  breakerCooldownMs?: number;  // how long the breaker stays open (default 20000)
  log?: (event: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Attempt = { kind: 'ok'; lines: string[] } | { kind: 'err'; code: string; message: string } | { kind: 'fault'; reason: string };

const NOT_FOUND_CODES = new Set(['NOT_FOUND', 'UNKNOWN_LOAD']);
const REQUEST_CODES = new Set(['MISSING_FIELD', 'UNKNOWN_CMD', 'MALFORMED']); // our request was refused: don't retry
const TRANSIENT_CODES = new Set(['SERVER_ERROR']);

export class TmsClient {
  private readonly o: Required<Omit<TmsClientOptions, 'log' | 'sleep'>> & Pick<TmsClientOptions, 'log'>;
  private readonly sleep: (ms: number) => Promise<void>;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(options: TmsClientOptions) {
    this.o = {
      faultMode: 'off', maxAttempts: 3, budgetMs: 6500, backoffMs: 150, breakerThreshold: 5, breakerCooldownMs: 20_000,
      ...options,
    };
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get breakerOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  async searchLoads(filters: SearchFilters): Promise<Result<LoadSummary[]>> {
    this.logInjectedFault('search');
    return this.read('LOAD_QUERY', { ...filters }, (lines) => lines.map(parseSummary));
  }

  /** Full record including the broker ceiling (maxBuy). Internal use only. */
  async getLoad(loadId: string): Promise<Result<LoadDetail | null>> {
    this.logInjectedFault('get');
    return this.getLoadInternal(loadId);
  }

  private async getLoadInternal(loadId: string): Promise<Result<LoadDetail | null>> {
    const r = await this.read('LOAD_GET', { LOAD_ID: loadId }, (lines) => {
      if (lines.length !== 1) throw new MalformedRecord(`expected 1 record, got ${lines.length}`);
      return parseDetail(lines[0]!);
    });
    if (!r.ok && r.error.kind === 'rejected' && NOT_FOUND_CODES.has(r.error.code)) return { ok: true, value: null };
    return r;
  }

  async bookLoad(loadId: string, mcNumber: string, agreedRate: number): Promise<Result<BookingOutcome>> {
    if (!Number.isInteger(agreedRate) || agreedRate <= 0) return { ok: true, value: { status: 'invalid_rate' } };
    if (!/^\d{1,8}$/.test(mcNumber)) return { ok: false, error: { kind: 'rejected', code: 'BAD_MC', message: 'MC must be digits' } };
    this.logInjectedFault('book');

    // Pre-check: is it still open on our token? Separates "already gone" from "our own earlier attempt landed".
    const pre = await this.getLoadInternal(loadId);
    if (!pre.ok) return pre;
    if (pre.value === null) return { ok: true, value: { status: 'not_found' } };
    if (pre.value.status !== 'OPEN') return { ok: true, value: { status: 'not_available' } };
    if (this.breakerOpen) return this.fail({ kind: 'unavailable', reason: 'breaker_open' });

    const fields = { LOAD_ID: loadId, MC_NUM: mcNumber, AGREED_RATE: agreedRate };
    let ambiguous = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const a = await this.attempt('LOAD_BOOK', fields);
      if (a.kind === 'ok') {
        try {
          if (a.lines.length !== 1) throw new MalformedRecord(`expected 1 record, got ${a.lines.length}`);
          const conf = parseBooking(a.lines[0]!);
          this.succeeded();
          return { ok: true, value: { status: 'booked', bookingRef: conf.bookingRef, confirmed: true } };
        } catch (e) {
          if (!(e instanceof MalformedRecord)) throw e;
          ambiguous = true; // a garbled success may still have booked
          this.log({ event: 'tms_fault', cmd: 'LOAD_BOOK', attempt, reason: e.message });
          continue;
        }
      }
      if (a.kind === 'err') {
        if (a.code === 'ALREADY_BOOKED') {
          this.succeeded();
          // After an ambiguous attempt, our own booking is the reason (token-scoped, monotonic).
          return { ok: true, value: ambiguous ? { status: 'booked', bookingRef: null, confirmed: false } : { status: 'not_available' } };
        }
        if (a.code === 'INVALID_RATE') { this.succeeded(); return { ok: true, value: { status: 'invalid_rate' } }; }
        if (NOT_FOUND_CODES.has(a.code)) { this.succeeded(); return { ok: true, value: { status: 'not_found' } }; }
        if (!TRANSIENT_CODES.has(a.code)) return this.fail({ kind: 'rejected', code: a.code, message: a.message });
        ambiguous = true;
        continue;
      }
      ambiguous = true; // timeout / cut-off / closed: it may or may not have landed
      this.log({ event: 'tms_fault', cmd: 'LOAD_BOOK', attempt, reason: a.reason });
      if (attempt === 1) await this.sleep(this.backoff(1));
    }
    return this.fail({ kind: 'unavailable', reason: 'booking_unconfirmed' });
  }

  // --- internals ---

  private async read<T>(cmd: string, fields: Record<string, string | number>, parse: (lines: string[]) => T): Promise<Result<T>> {
    if (this.breakerOpen) return { ok: false, error: { kind: 'unavailable', reason: 'breaker_open' } };
    const deadline = Date.now() + this.o.budgetMs;
    let lastReason = 'no_attempt';
    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      const a = await this.attempt(cmd, fields, Math.min(this.o.timeoutMs, deadline - Date.now()));
      if (a.kind === 'ok') {
        try {
          const value = parse(a.lines);
          this.succeeded();
          return { ok: true, value };
        } catch (e) {
          if (!(e instanceof MalformedRecord)) throw e;
          lastReason = 'malformed';
          this.log({ event: 'tms_fault', cmd, attempt, reason: e.message });
        }
      } else if (a.kind === 'err') {
        if (NOT_FOUND_CODES.has(a.code) || REQUEST_CODES.has(a.code)) {
          this.succeeded(); // the TMS is healthy; it just said no
          return { ok: false, error: { kind: 'rejected', code: a.code, message: a.message } };
        }
        if (a.code === 'AUTH_FAILED') return this.fail({ kind: 'unavailable', reason: 'auth_failed' });
        if (!TRANSIENT_CODES.has(a.code)) return this.fail({ kind: 'unavailable', reason: `unknown_code_${a.code}` });
        lastReason = a.code;
        this.log({ event: 'tms_fault', cmd, attempt, reason: a.code });
      } else {
        lastReason = a.reason;
        this.log({ event: 'tms_fault', cmd, attempt, reason: a.reason });
      }
      const wait = this.backoff(attempt);
      if (attempt === this.o.maxAttempts || Date.now() + wait + 200 >= deadline) break;
      await this.sleep(wait);
    }
    return this.fail({ kind: 'unavailable', reason: lastReason });
  }

  private async attempt(cmd: string, fields: Record<string, string | number>, timeoutMs = this.o.timeoutMs): Promise<Attempt> {
    let outcome: WireOutcome;
    if (this.o.faultMode === 'down') {
      outcome = { kind: 'socket_error', reason: 'ECONNREFUSED' };
    } else if (this.o.faultMode === 'timeout') {
      await this.sleep(Math.max(timeoutMs, 1));
      outcome = { kind: 'timeout', partial: '' };
    } else if (this.o.faultMode === 'garbage') {
      outcome = { kind: 'ok', lines: ['garbage'] };
    } else {
      outcome = await sendRequest(
        { host: this.o.host, port: this.o.port, timeoutMs: Math.max(timeoutMs, 100) },
        buildLine(cmd, this.o.token, fields),
      );
    }
    switch (outcome.kind) {
      case 'ok': return { kind: 'ok', lines: outcome.lines };
      case 'error': return { kind: 'err', code: outcome.code, message: outcome.message };
      default: return { kind: 'fault', reason: outcome.kind };
    }
  }

  private backoff(attempt: number): number {
    return this.o.backoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * this.o.backoffMs);
  }

  private succeeded(): void {
    this.consecutiveFailures = 0;
  }

  private fail<T>(error: TmsFailure): Result<T> {
    if (error.kind === 'unavailable') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.o.breakerThreshold) {
        this.openUntil = Date.now() + this.o.breakerCooldownMs;
        this.consecutiveFailures = 0;
        this.log({ event: 'tms_breaker_open', cooldownMs: this.o.breakerCooldownMs });
      }
    }
    return { ok: false, error };
  }

  private log(event: Record<string, unknown>): void {
    this.o.log?.(event);
  }

  private logInjectedFault(operation: 'search' | 'get' | 'book'): void {
    if (this.o.faultMode !== 'off') {
      this.log({ event: 'tms_fault_injected', mode: this.o.faultMode, operation });
    }
  }
}
