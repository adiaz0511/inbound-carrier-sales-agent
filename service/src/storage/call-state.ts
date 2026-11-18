// Live call state (decision D-017): what the service must remember while a call is in progress.
//
// It holds enforcement state only (hashed code, attempts, counter rounds, booking attempts, per-carrier
// caps), never a business record; those go to Twin. Every change is a read-modify-write inside a
// transaction, so limits stay exact even if the same tool call is retried or two requests overlap.
//
// Two implementations behind one interface: Firestore in the cloud, and an in-memory one for tests.
// Expiry is a stored timestamp checked on every read (Firestore's automatic TTL deletes aren't free, R-28);
// a finished call's document is deleted explicitly.

import { Firestore } from '@google-cloud/firestore';

export type ReservationStatus = 'reserved' | 'confirming' | 'confirmed' | 'booking_unresolved' | 'released';

export interface OtpState {
  codeHash?: string;           // keyed hash (HMAC) of the code; the code itself is never stored. Unset until delivered
  expiresAt: number;           // epoch ms (0 until delivered)
  pendingTo?: string;          // destination of a send that the hidden delivery step hasn't collected yet (D-024)
  sends: number;               // initial send + resends
  channel: 'sms' | 'email';
  destinationMasked: string;
}

export interface CarrierState {
  mcNumber: string;
  dotNumber: number;
  legalName: string;
  eligible: boolean;
  contactSource?: 'broker_records' | 'fmcsa_census' | 'sandbox_caller';
  phone?: string;       // full contact, kept only here (short-lived, private) to send the code; never returned
  email?: string;
  sandbox?: boolean;
}

export interface CallState {
  callId: string;
  verifiedAt?: number;
  verifiedMc?: string;       // verification belongs to this exact carrier identity
  wrongAttempts?: number;  // wrong codes on this call, across resends (never reset: a resend is not a new set of guesses)
  locked?: boolean;        // too many wrong codes: verification is over for this call
  mcNumber?: string;
  mcTries?: string[];   // distinct MCs checked on this call (capped, against fishing for valid MCs)
  carrier?: CarrierState;
  verified: boolean;
  otp?: OtpState;
  counterRounds?: number;    // carrier counter rounds consumed across the complete call (brief: max 3 per call)
  negotiation?: {
    loadId: string;
    lane: string;
    equipment: string;
    postedUsd: number;
    ceilingUsd: number;          // MAX_BUY, kept here and in Twin load_pricing only; never sent to the agent
    rounds: number;
    standingCounterUsd?: number;
    finalOffered: boolean;
    status: 'open' | 'agreed' | 'no_deal';
    agreedUsd?: number;
  };
  // The agent can only reserve (D-025): a time-limited hold. A senior rep confirms it into a TMS booking later.
  reservation?: { loadId: string; priceUsd: number; expiresAt: number };
  transferred?: boolean;
  outcome?: string;        // terminal outcome once decided (mirrors Twin calls.outcome)
  endedAt?: number;        // set once by endCall; the state then keeps only this tombstone until it expires
  createdAt: number;
  expiresAt: number;           // the whole call's state is ignored after this
}

export const CALL_STATE_TTL_MS = 2 * 60 * 60 * 1000; // a call never lasts 2 hours
export const RESERVATION_TTL_MS = 60 * 60 * 1000;     // a rep has an hour to confirm a reserved load (D-025)

/**
 * A load held for one carrier at an agreed price until a senior rep confirms it (booking in the TMS) or
 * releases it. Durable beyond the call: it outlives the call's live state. One per load (keyed by load id).
 */
export interface Reservation {
  reservationId: string;     // stable generation; prevents stale finalization of a replacement hold
  loadId: string;
  callId: string;
  mcNumber: string;
  carrierName?: string;
  priceUsd: number;
  postedUsd: number;
  ceilingUsd: number;        // kept server-side only, like call state; never returned to the agent
  lane: string;
  equipment: string;
  createdAt: number;
  expiresAt: number;
  status: ReservationStatus;
  confirmationAttemptId?: string;
  confirmationStartedAt?: number;
  bookingRef?: string;
  closedAt?: number;
  closedReason?: string;
}

/** A hold that still blocks the load: reserved and not expired. Confirmed loads are gone from the board anyway. */
export function isActiveHold(r: Reservation | null, now = Date.now()): r is Reservation {
  return !!r && r.status === 'reserved' && r.expiresAt > now;
}

/** A reservation that must keep the load unavailable until an operator resolves it. */
export function blocksLoad(r: Reservation | null, now = Date.now()): r is Reservation {
  if (!r) return false;
  if (r.status === 'confirming' || r.status === 'booking_unresolved' || r.status === 'confirmed') return true;
  return r.status === 'reserved' && r.expiresAt > now;
}

export interface CallStateStore {
  /** Current state, or null if none or expired. */
  get(callId: string): Promise<CallState | null>;
  /**
   * Atomically read, change and write a call's state. `fn` gets the current state (a fresh one if none)
   * and returns the new state plus a result. If two updates race, one is retried on fresh data.
   */
  update<T>(callId: string, fn: (s: CallState) => { state: CallState; result: T }): Promise<T>;
  /** Atomically count an event for a carrier inside a rolling window; returns the count after adding. */
  bumpCarrierCounter(mcNumber: string, counter: string, windowMs: number): Promise<number>;
  delete(callId: string): Promise<void>;
  /** Take a short exclusive lock (e.g. one booking per load at a time). True if taken. Expires after ttlMs. */
  tryLock(name: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLock(name: string, owner: string): Promise<void>;
  getReservation(loadId: string): Promise<Reservation | null>;
  /**
   * Atomically read and change a load's reservation. `fn` gets the current one (or null) and returns the new
   * one (`undefined` = leave unchanged) plus a result.
   */
  updateReservation<T>(loadId: string, fn: (r: Reservation | null) => { reservation?: Reservation; result: T }): Promise<T>;
  /** Every reservation (active, confirmed and released). For the ops dashboard's holds view (D-026). */
  listReservations(): Promise<Reservation[]>;
}

function fresh(callId: string, now: number): CallState {
  return { callId, verified: false, createdAt: now, expiresAt: now + CALL_STATE_TTL_MS };
}

// --- Firestore implementation ---------------------------------------------------------------------

export class FirestoreCallStateStore implements CallStateStore {
  private readonly db: Firestore;
  private readonly calls: string;
  private readonly carriers: string;
  private readonly locks: string;
  private readonly reservations: string;

  /**
   * `environment` prefixes every collection: one free database serves staging and production (D-017).
   * Authentication is the runtime's own Google identity (Cloud Run service account, or a developer's
   * application-default login); no key is involved.
   */
  constructor(environment: string, projectId?: string, db?: Firestore) {
    this.db = db ?? new Firestore({ projectId, ignoreUndefinedProperties: true });
    this.calls = `${environment}_call_state`;
    this.carriers = `${environment}_carrier_counters`;
    this.locks = `${environment}_locks`;
    this.reservations = `${environment}_reservations`;
  }

  async get(callId: string): Promise<CallState | null> {
    const snap = await this.db.collection(this.calls).doc(callId).get();
    const s = snap.exists ? (snap.data() as CallState) : null;
    return s && s.expiresAt > Date.now() ? s : null;
  }

  async update<T>(callId: string, fn: (s: CallState) => { state: CallState; result: T }): Promise<T> {
    const ref = this.db.collection(this.calls).doc(callId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const existing = snap.exists ? (snap.data() as CallState) : null;
      const current = existing && existing.expiresAt > now ? existing : fresh(callId, now);
      const { state, result } = fn(structuredClone(current));
      tx.set(ref, state);
      return result;
    });
  }

  async bumpCarrierCounter(mcNumber: string, counter: string, windowMs: number): Promise<number> {
    const ref = this.db.collection(this.carriers).doc(`${mcNumber}_${counter}`);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const times = ((snap.exists ? (snap.data()?.times as number[]) : []) ?? []).filter((t) => t > now - windowMs);
      times.push(now);
      tx.set(ref, { times, updatedAt: now });
      return times.length;
    });
  }

  async delete(callId: string): Promise<void> {
    await this.db.collection(this.calls).doc(callId).delete();
  }

  async tryLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const ref = this.db.collection(this.locks).doc(name);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const cur = snap.exists ? (snap.data() as { owner: string; until: number }) : null;
      if (cur && cur.until > now && cur.owner !== owner) return false;
      tx.set(ref, { owner, until: now + ttlMs });
      return true;
    });
  }

  async releaseLock(name: string, owner: string): Promise<void> {
    const ref = this.db.collection(this.locks).doc(name);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { owner: string }).owner === owner) tx.delete(ref);
    });
  }

  async getReservation(loadId: string): Promise<Reservation | null> {
    const snap = await this.db.collection(this.reservations).doc(loadId).get();
    return snap.exists ? (snap.data() as Reservation) : null;
  }

  async updateReservation<T>(loadId: string, fn: (r: Reservation | null) => { reservation?: Reservation; result: T }): Promise<T> {
    const ref = this.db.collection(this.reservations).doc(loadId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const { reservation, result } = fn(snap.exists ? (snap.data() as Reservation) : null);
      if (reservation) tx.set(ref, reservation);
      return result;
    });
  }

  async listReservations(): Promise<Reservation[]> {
    const snap = await this.db.collection(this.reservations).get();
    return snap.docs.map((d) => d.data() as Reservation);
  }
}

// --- In-memory implementation (tests, local development) ------------------------------------------

export class MemoryCallStateStore implements CallStateStore {
  private readonly calls = new Map<string, CallState>();
  private readonly counters = new Map<string, number[]>();
  private chain: Promise<unknown> = Promise.resolve(); // serialize updates like a transaction would

  async get(callId: string): Promise<CallState | null> {
    const s = this.calls.get(callId);
    return s && s.expiresAt > Date.now() ? structuredClone(s) : null;
  }

  update<T>(callId: string, fn: (s: CallState) => { state: CallState; result: T }): Promise<T> {
    const run = this.chain.then(() => {
      const now = Date.now();
      const existing = this.calls.get(callId);
      const current = existing && existing.expiresAt > now ? existing : fresh(callId, now);
      const { state, result } = fn(structuredClone(current));
      this.calls.set(callId, structuredClone(state));
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async bumpCarrierCounter(mcNumber: string, counter: string, windowMs: number): Promise<number> {
    const key = `${mcNumber}_${counter}`;
    const now = Date.now();
    const times = (this.counters.get(key) ?? []).filter((t) => t > now - windowMs);
    times.push(now);
    this.counters.set(key, times);
    return times.length;
  }

  async delete(callId: string): Promise<void> {
    this.calls.delete(callId);
  }

  private readonly lockTable = new Map<string, { owner: string; until: number }>();
  async tryLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const cur = this.lockTable.get(name);
    if (cur && cur.until > Date.now() && cur.owner !== owner) return false;
    this.lockTable.set(name, { owner, until: Date.now() + ttlMs });
    return true;
  }
  async releaseLock(name: string, owner: string): Promise<void> {
    if (this.lockTable.get(name)?.owner === owner) this.lockTable.delete(name);
  }

  private readonly reservationTable = new Map<string, Reservation>();
  async getReservation(loadId: string): Promise<Reservation | null> {
    const r = this.reservationTable.get(loadId);
    return r ? structuredClone(r) : null;
  }
  updateReservation<T>(loadId: string, fn: (r: Reservation | null) => { reservation?: Reservation; result: T }): Promise<T> {
    const run = this.chain.then(() => {
      const cur = this.reservationTable.get(loadId);
      const { reservation, result } = fn(cur ? structuredClone(cur) : null);
      if (reservation) this.reservationTable.set(loadId, structuredClone(reservation));
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async listReservations(): Promise<Reservation[]> {
    return [...this.reservationTable.values()].map((r) => structuredClone(r));
  }
}
