// Negotiation, booking, mocked transfer and call end (Phase 5; decisions D-010, D-020, D-019).
//
// The service holds every number that matters. The agent sends what the carrier said; it never sends or
// receives the ceiling, and it can't choose the price, MC or load that gets booked: those come from call state.
//
//   start   verified call + load id -> load re-read from the TMS (open, future pickup); posted rate to pitch
//   offer   the carrier's ask       -> accept / counter / final offer / no deal (strategy.ts)
//   reserve agreed + confirmed deal -> time-limited hold on the load at the agreed price (D-025); no TMS booking
//   confirm  senior rep (ops side)   -> the TMS booking, with the price and MC from the hold; safe against TMS faults
//   release  senior rep (ops side)   -> load back on the board
//   transfer reserved call           -> mocked handoff to a senior rep (web calls can't transfer, brief)
//   end      any call              -> outcome finalized in Twin, live state deleted

import { randomUUID } from 'node:crypto';
import { RESERVATION_TTL_MS, blocksLoad, isActiveHold, type CallState, type CallStateStore, type Reservation } from '../storage/call-state.js';
import type { CallRecords, CallOutcome } from '../storage/twin.js';
import type { TmsClient } from '../tms/client.js';
import { toPublicDetail } from '../routes/loads.js';
import { decide, MAX_ROUNDS } from './strategy.js';

export interface DealDeps {
  state: CallStateStore;
  records: CallRecords;
  tms: TmsClient;
  log: (event: Record<string, unknown>) => void;
}

type Say = { next_step: string };

const tell = {
  notVerified: 'The carrier has not been verified. Send and check the one-time code first.',
  notFound: 'That load is not on the board. Offer to search again.',
  unavailable: 'That load is no longer available. Offer to search for another one.',
  tmsDown: 'The load board is not responding. Apologize and offer a callback.',
  pitch: (l: { lane: string; posted: number }) => `Pitch the load (${l.lane}) at the posted rate of $${l.posted}. If they accept it, pass $${l.posted} to carrier_offer; if they ask for more, pass their number. Never mention any other number.`,
  noNegotiation: 'Start with a load first.',
  closed: 'This negotiation is already closed.',
  accept: (p: number) => `The carrier's $${p} works. Do not reserve yet: repeat the deal back (the lane and $${p} all-in) and ask if they want you to lock it in. Call reserve_load only after they clearly say yes in their next reply; if they hesitate or change the price, keep negotiating.`,
  acceptOurs: (p: number) => `The carrier accepted your offer of $${p}; that is their confirmation. Call reserve_load now. Do not ask them to confirm again.`,
  counter: (p: number, left: number) => `Counter-offer $${p}, in words like: "I could do $${p} on this one. Would that work?" It is not your best or final offer: never call it that. Do not reveal any other number. If they accept $${p}, pass $${p} to carrier_offer. (${left} counter ${left === 1 ? 'round' : 'rounds'} left.)`,
  final: (p: number) => `Make a final offer of $${p}: say it is the best you can do on this load. If they accept, pass $${p} to the offer tool; if not, the call ends with no deal.`,
  noDeal: 'No deal this time. Say you understand, thank them for considering it, invite them to call back for other loads, then call end_call. Do not transfer.',
  notAgreed: 'There is no agreed price yet. Finish the negotiation first.',
  notRecorded: (p: number) => `The carrier's yes isn't recorded yet. If they just accepted your offer of $${p}, call carrier_offer with ${p} and then reserve_load right away. They already said yes: don't ask them again.`,
  reserved: (p: number) => `Reserved at $${p} and held for this carrier. Call transfer_to_rep now: it tells the carrier the load is reserved and hands them to a senior rep. Do not say goodbye yet.`,
  gone: 'Someone just took that load. Apologize and offer to search for another one.',
  notReserved: 'Only a carrier with a reserved load is transferred. Reserve the load first.',
  transferred: 'Handed off to the senior rep queue (simulated: web calls cannot be transferred; the carrier has already been told). Call end_call now: it says the goodbye.',
};

async function safe(d: DealDeps, write: () => Promise<unknown>) {
  try { await write(); } catch (e) { d.log({ event: 'audit_write_failed', error: (e as Error).message.slice(0, 200) }); }
}

function verified(s: CallState | null): s is CallState {
  return !!s?.verifiedAt && !s.locked && !!s.carrier?.eligible && s.verifiedMc === s.carrier.mcNumber;
}

// --- start ---------------------------------------------------------------------------------------

export async function startNegotiation(input: { callId: string; loadId: string }, d: DealDeps) {
  const s = await d.state.get(input.callId);
  if (!verified(s)) return { ok: false as const, reason: 'not_verified' as const, next_step: tell.notVerified };
  if ((s.counterRounds ?? 0) >= MAX_ROUNDS) return { ok: false as const, reason: 'closed' as const, next_step: tell.closed };

  const r = await d.tms.getLoad(input.loadId);
  if (!r.ok) return { ok: false as const, reason: 'tms_unavailable' as const, next_step: tell.tmsDown };
  if (r.value === null) return { ok: false as const, reason: 'not_found' as const, next_step: tell.notFound };
  const load = r.value;
  if (load.status !== 'OPEN' || load.pickupAt.getTime() <= Date.now()) return { ok: false as const, reason: 'not_available' as const, next_step: tell.unavailable };
  // Held for another carrier (reserved, awaiting a rep): not pitchable.
  const hold = await d.state.getReservation(load.loadId);
  if (blocksLoad(hold) && hold.callId !== input.callId) return { ok: false as const, reason: 'not_available' as const, next_step: tell.unavailable };

  const lane = `${load.origin.city}, ${load.origin.state} -> ${load.destination.city}, ${load.destination.state}`;
  // Missing MAX_BUY means posted rate only. A defined ceiling below posted is inconsistent and unsafe to pitch.
  if (load.maxBuy !== undefined && load.maxBuy < load.postedRate) {
    d.log({ event: 'inconsistent_ceiling', load_id: load.loadId, posted_rate_usd: load.postedRate, max_buy_usd: load.maxBuy });
    return { ok: false as const, reason: 'not_available' as const, next_step: tell.unavailable };
  }
  const ceiling = load.maxBuy ?? load.postedRate;
  const started = await d.state.update<'started' | 'not_verified' | 'closed'>(input.callId, (st) => {
    if (!verified(st)) return { state: st, result: 'not_verified' };
    const rounds = st.counterRounds ?? 0;
    if (rounds >= MAX_ROUNDS) return { state: st, result: 'closed' };
    return {
      state: { ...st, negotiation: { loadId: load.loadId, lane, equipment: load.equipment, postedUsd: load.postedRate, ceilingUsd: ceiling, rounds, finalOffered: false, status: 'open' } },
      result: 'started',
    };
  });
  if (started !== 'started') {
    return { ok: false as const, reason: started, next_step: started === 'not_verified' ? tell.notVerified : tell.closed };
  }
  await safe(d, () => Promise.all([
    d.records.event(input.callId, 'pitch', { load_id: load.loadId, lane, posted_rate_usd: load.postedRate }),
    d.records.updateCall(input.callId, { load_id: load.loadId, lane, equipment: load.equipment, posted_rate_usd: load.postedRate }),
  ]));
  return { ok: true as const, load: toPublicDetail(load), pitch_rate_usd: load.postedRate, next_step: tell.pitch({ lane, posted: load.postedRate }) };
}

// --- offer ---------------------------------------------------------------------------------------

export async function submitOffer(input: { callId: string; askUsd: number }, d: DealDeps) {
  type R =
    | { kind: 'error'; reason: 'not_verified' | 'no_negotiation' | 'closed' }
    | { kind: 'decided'; action: 'accept' | 'counter' | 'final_offer' | 'no_deal'; priceUsd?: number; round: number; loadId: string; recordRound: boolean; ourOffer: boolean };

  const r = await d.state.update<R>(input.callId, (st) => {
    if (!verified(st)) return { state: st, result: { kind: 'error', reason: 'not_verified' } };
    const n = st.negotiation;
    if (!n) return { state: st, result: { kind: 'error', reason: 'no_negotiation' } };
    if (n.status !== 'open') return { state: st, result: { kind: 'error', reason: 'closed' } };
    const dec = decide(n, input.askUsd);
    if (dec.action === 'accept') {
      const round = dec.consumedRound ? n.rounds + 1 : n.rounds;
      // "Ours" = the carrier said yes to the number we last put on the table (posted rate, counter or final offer).
      const ourOffer = dec.priceUsd === (n.standingCounterUsd ?? n.postedUsd);
      return { state: { ...st, counterRounds: round, negotiation: { ...n, rounds: round, status: 'agreed', agreedUsd: dec.priceUsd } },
        result: { kind: 'decided', action: 'accept', priceUsd: dec.priceUsd, round, loadId: n.loadId, recordRound: dec.consumedRound, ourOffer } };
    }
    if (dec.action === 'no_deal') {
      return { state: { ...st, counterRounds: n.rounds, outcome: 'no_deal', negotiation: { ...n, status: 'no_deal' } }, result: { kind: 'decided', action: 'no_deal', round: n.rounds, loadId: n.loadId, recordRound: false, ourOffer: false } };
    }
    return { state: { ...st, counterRounds: dec.round, negotiation: { ...n, rounds: dec.round, standingCounterUsd: dec.priceUsd, finalOffered: dec.action === 'final_offer' } },
      result: { kind: 'decided', action: dec.action, priceUsd: dec.priceUsd, round: dec.round, loadId: n.loadId, recordRound: true, ourOffer: false } };
  });

  if (r.kind === 'error') {
    return { ok: false as const, reason: r.reason, next_step: r.reason === 'not_verified' ? tell.notVerified : r.reason === 'no_negotiation' ? tell.noNegotiation : tell.closed };
  }

  // Audit trail: one offers row per carrier counter (rounds 1-3); events for every exchange.
  const writes: Promise<unknown>[] = [d.records.event(input.callId, 'offer', { round: r.round, carrier_offer_usd: input.askUsd, decision: r.action, our_price_usd: r.priceUsd ?? null })];
  if (r.recordRound) writes.push(d.records.offer(input.callId, r.loadId, r.round, input.askUsd, r.action === 'accept' ? 'accept' : 'counter', r.action === 'accept' ? undefined : r.priceUsd));
  writes.push(d.records.updateCall(input.callId, {
    counter_rounds: r.round,
    ...(r.action === 'accept' ? { agreed_rate_usd: r.priceUsd } : {}),
    ...(r.action === 'no_deal' ? { outcome: 'no_deal' as const } : {}),
  }));
  await safe(d, () => Promise.all(writes));

  const left = MAX_ROUNDS - r.round;
  switch (r.action) {
    case 'accept': return { ok: true as const, decision: 'accept' as const, price_usd: r.priceUsd!, next_step: r.ourOffer ? tell.acceptOurs(r.priceUsd!) : tell.accept(r.priceUsd!) };
    case 'counter': return { ok: true as const, decision: 'counter' as const, price_usd: r.priceUsd!, rounds_left: left, next_step: tell.counter(r.priceUsd!, left) };
    case 'final_offer': return { ok: true as const, decision: 'final_offer' as const, price_usd: r.priceUsd!, rounds_left: 0, next_step: tell.final(r.priceUsd!) };
    case 'no_deal': return { ok: true as const, decision: 'no_deal' as const, next_step: tell.noDeal };
  }
}

// --- reserve (agent) ------------------------------------------------------------------------------
//
// D-025: an agreed price only reserves the load (brief: "the booking is tentatively reserved"; the senior rep
// "confirms the booking"). The agent's last step is a time-limited hold; the permanent TMS booking happens when
// a rep confirms it (confirmReservation, from the ops side). No agent tool can book in the TMS.

export async function reserveLoad(input: { callId: string }, d: DealDeps) {
  const s = await d.state.get(input.callId);
  if (!verified(s)) return { ok: false as const, reason: 'not_verified' as const, next_step: tell.notVerified };
  if (s.reservation) {
    return { ok: true as const, status: 'reserved' as const, price_usd: s.reservation.priceUsd, held_minutes: minutesLeft(s.reservation.expiresAt), next_step: tell.reserved(s.reservation.priceUsd) };
  }
  const n = s.negotiation;
  if (!n || n.status !== 'agreed' || n.agreedUsd === undefined) {
    // Common slip: the carrier says yes to our standing offer and the agent jumps straight to reserving.
    const onTable = n?.status === 'open' ? (n.standingCounterUsd ?? n.postedUsd) : undefined;
    return { ok: false as const, reason: 'no_agreed_price' as const, next_step: onTable !== undefined ? tell.notRecorded(onTable) : tell.notAgreed };
  }

  // The board can change mid-call: re-read the load before holding it.
  const r = await d.tms.getLoad(n.loadId);
  if (!r.ok) return { ok: false as const, reason: 'tms_unavailable' as const, next_step: tell.tmsDown };
  if (r.value === null || r.value.status !== 'OPEN' || r.value.pickupAt.getTime() <= Date.now()) {
    await d.state.update(input.callId, (st) => ({ state: { ...st, negotiation: st.negotiation && { ...st.negotiation, status: 'no_deal' } }, result: null }));
    return { ok: false as const, reason: 'not_available' as const, next_step: tell.gone };
  }

  // One active hold per load, across calls and service instances (atomic). MC and price come from call state.
  const now = Date.now();
  const hold: Reservation = {
    reservationId: randomUUID(), loadId: n.loadId, callId: input.callId, mcNumber: s.carrier!.mcNumber, carrierName: s.carrier!.legalName,
    priceUsd: n.agreedUsd, postedUsd: n.postedUsd, ceilingUsd: n.ceilingUsd, lane: n.lane, equipment: n.equipment,
    createdAt: now, expiresAt: now + RESERVATION_TTL_MS, status: 'reserved',
  };
  const placed = await d.state.updateReservation(n.loadId, (cur) =>
    blocksLoad(cur, now) && cur.callId !== input.callId ? { result: false }
      : cur?.status === 'confirmed' || cur?.status === 'confirming' || cur?.status === 'booking_unresolved'
        ? { result: false }
        : { reservation: hold, result: true });
  if (!placed) return { ok: false as const, reason: 'not_available' as const, next_step: tell.gone };

  await d.state.update(input.callId, (st) => ({ state: { ...st, outcome: 'reserved', reservation: { loadId: n.loadId, priceUsd: n.agreedUsd!, expiresAt: hold.expiresAt } }, result: null }));
  await safe(d, () => Promise.all([
    d.records.event(input.callId, 'reserved', { load_id: n.loadId, price_usd: n.agreedUsd, expires_at: new Date(hold.expiresAt).toISOString() }),
    d.records.updateCall(input.callId, { outcome: 'reserved', agreed_rate_usd: n.agreedUsd }),
    d.records.pricing(input.callId, n.loadId, n.postedUsd, n.ceilingUsd, n.agreedUsd),
  ]));
  return { ok: true as const, status: 'reserved' as const, price_usd: n.agreedUsd, held_minutes: minutesLeft(hold.expiresAt), next_step: tell.reserved(n.agreedUsd) };
}

function minutesLeft(until: number): number { return Math.max(0, Math.round((until - Date.now()) / 60_000)); }

// --- confirm / release (senior rep, ops side) -------------------------------------------------------

/** The rep confirms a reserved load: the one place a TMS booking is made. Idempotent; safe against TMS faults. */
export async function confirmReservation(input: { loadId: string; by: string }, d: DealDeps) {
  type Claim =
    | { kind: 'start'; reservation: Reservation; attemptId: string }
    | { kind: 'confirmed'; reservation: Reservation }
    | { kind: 'error'; reason: 'no_reservation' | 'released' | 'expired' | 'in_progress' | 'booking_unresolved' };

  const attemptId = randomUUID();
  const claim = await d.state.updateReservation<Claim>(input.loadId, (cur) => {
    if (!cur) return { result: { kind: 'error', reason: 'no_reservation' } };
    if (cur.status === 'confirmed') return { result: { kind: 'confirmed', reservation: cur } };
    if (cur.status === 'released') return { result: { kind: 'error', reason: 'released' } };
    if (cur.status === 'confirming') return { result: { kind: 'error', reason: 'in_progress' } };
    if (cur.status === 'booking_unresolved') return { result: { kind: 'error', reason: 'booking_unresolved' } };
    if (cur.expiresAt <= Date.now()) return { result: { kind: 'error', reason: 'expired' } };
    const reservationId = cur.reservationId ?? randomUUID(); // Backfill holds created before this state machine.
    return {
      reservation: { ...cur, reservationId, status: 'confirming', confirmationAttemptId: attemptId, confirmationStartedAt: Date.now() },
      result: { kind: 'start', reservation: { ...cur, reservationId }, attemptId },
    };
  });

  if (claim.kind === 'confirmed') {
    return { ok: true as const, status: 'booked' as const, booking_ref: claim.reservation.bookingRef ?? null, call_id: claim.reservation.callId };
  }
  if (claim.kind === 'error') return { ok: false as const, reason: claim.reason };

  const res = claim.reservation;
  await safe(d, () => d.records.event(res.callId, 'booking_attempt', {
    load_id: res.loadId, price_usd: res.priceUsd, by: input.by, attempt_id: claim.attemptId,
  }));
  // MC and price come from the reservation, which came from verified call state. Never from a request.
  const r = await d.tms.bookLoad(res.loadId, res.mcNumber, res.priceUsd);
  if (!r.ok || r.value.status !== 'booked') {
    const reason = !r.ok
      ? (r.error.kind === 'unavailable' ? r.error.reason : r.error.code)
      : r.value.status;
    await markBookingUnresolved(res, claim.attemptId, reason, d);
    return { ok: false as const, reason: 'booking_unresolved' as const, retryable: false, call_id: res.callId };
  }

  const b = r.value;
  const status = b.confirmed ? ('booked' as const) : ('booked_ref_pending' as const);
  const ref = b.confirmed ? b.bookingRef : undefined;
  const finalized = await d.state.updateReservation(res.loadId, (cur) => {
    if (!sameConfirmation(cur, res.reservationId, claim.attemptId)) return { result: false };
    return {
      reservation: {
        ...cur, status: 'confirmed', bookingRef: ref, closedAt: Date.now(),
        closedReason: `confirmed_by_${input.by}`,
      },
      result: true,
    };
  });
  if (!finalized) return { ok: false as const, reason: 'booking_unresolved' as const, retryable: false, call_id: res.callId };
  await safe(d, () => Promise.all([
    d.records.event(res.callId, 'booked', { load_id: res.loadId, price_usd: res.priceUsd, confirmed: b.confirmed, by: input.by }),
    d.records.updateCall(res.callId, { outcome: status, ...(ref ? { booking_ref: ref } : {}) }),
  ]));
  return { ok: true as const, status, booking_ref: ref ?? null, call_id: res.callId };
}

/** The rep (or ops) releases a reserved load back to the board. */
export async function releaseReservation(input: { loadId: string; reason: string }, d: DealDeps) {
  type Release =
    | { kind: 'released'; reservation: Reservation }
    | { kind: 'error'; reason: 'no_active_reservation' | 'in_progress' | 'booking_unresolved' };
  const released = await d.state.updateReservation<Release>(input.loadId, (cur) => {
    if (cur?.status === 'confirming') return { result: { kind: 'error', reason: 'in_progress' } };
    if (cur?.status === 'booking_unresolved') return { result: { kind: 'error', reason: 'booking_unresolved' } };
    if (!cur || cur.status !== 'reserved') return { result: { kind: 'error', reason: 'no_active_reservation' } };
    return {
      reservation: { ...cur, status: 'released', closedAt: Date.now(), closedReason: input.reason },
      result: { kind: 'released', reservation: cur },
    };
  });
  if (released.kind === 'error') return { ok: false as const, reason: released.reason };
  const res = released.reservation;
  await safe(d, () => Promise.all([
    d.records.event(res.callId, 'reservation_released', { load_id: res.loadId, reason: input.reason }),
    d.records.updateCall(res.callId, { outcome: 'released' }),
  ]));
  return { ok: true as const, status: 'released' as const, call_id: res.callId };
}

function sameConfirmation(cur: Reservation | null, reservationId: string, attemptId: string): cur is Reservation {
  return !!cur && cur.reservationId === reservationId && cur.status === 'confirming' && cur.confirmationAttemptId === attemptId;
}

async function markBookingUnresolved(res: Reservation, attemptId: string, reason: string, d: DealDeps) {
  await d.state.updateReservation(res.loadId, (cur) => {
    if (!sameConfirmation(cur, res.reservationId, attemptId)) return { result: false };
    return {
      reservation: { ...cur, status: 'booking_unresolved', closedReason: `manual_check_${reason}` },
      result: true,
    };
  });
  await safe(d, () => d.records.event(res.callId, 'error', {
    stage: 'booking', reason, reservation_status: 'booking_unresolved', attempt_id: attemptId,
  }));
}

// --- transfer (mocked) and end -------------------------------------------------------------------

export async function transferToRep(input: { callId: string }, d: DealDeps) {
  const s = await d.state.get(input.callId);
  const hold = s?.reservation ? await d.state.getReservation(s.reservation.loadId) : null;
  // The hold itself must still be live for this call (a rep may have released it, or it expired).
  if (!s?.reservation || !isActiveHold(hold) || hold.callId !== input.callId) return { ok: false as const, reason: 'not_reserved' as const, next_step: tell.notReserved };
  await d.state.update(input.callId, (st) => ({ state: { ...st, transferred: true }, result: null }));
  await safe(d, () => Promise.all([
    // Everything a senior rep needs to pick up the call and confirm the hold. No ceiling, contact details or codes.
    d.records.event(input.callId, 'transfer', {
      mocked: true,
      to: 'senior_rep_queue',
      load_id: s.reservation!.loadId,
      mc_number: s.carrier?.mcNumber,
      carrier_name: s.carrier?.legalName,
      lane: hold.lane,
      equipment: hold.equipment,
      agreed_rate_usd: hold.priceUsd,
      reservation_expires_at: new Date(hold.expiresAt).toISOString(),
    }),
    d.records.updateCall(input.callId, { transferred: true }),
  ]));
  return { ok: true as const, transferred: true, mocked: true, next_step: tell.transferred };
}

/** Finalizes the call record. If nothing else set an outcome, the carrier ended the call. Deletes live state. */
export const END_REASONS = ['no_match', 'caller_ended', 'not_verified', 'tms_unavailable', 'error'] as const;
export type EndReason = (typeof END_REASONS)[number];

export async function endCall(input: { callId: string; reason?: EndReason; summary?: string }, d: DealDeps) {
  // A reserved call's outcome follows its hold, which a rep may already have confirmed or released.
  const live = await d.state.get(input.callId);
  const hold = live?.reservation ? await d.state.getReservation(live.reservation.loadId) : null;
  const holdOutcome: CallOutcome | undefined = !hold || hold.callId !== input.callId ? undefined
    : hold.status === 'confirmed' ? (hold.bookingRef ? 'booked' : 'booked_ref_pending') : hold.status === 'released' ? 'released' : 'reserved';
  // Idempotent: the agent's end_call and the workflow's after-call step both end the call, and the second must
  // not overwrite the first (on a booked call it would erase "booked"). The first one atomically decides the
  // outcome and leaves a tombstone (outcome + times only; contact, negotiation and code data are dropped).
  const claim = await d.state.update<{ already: true } | { already: false; outcome: CallOutcome }>(input.callId, (s) => {
    if (s.endedAt) return { state: s, result: { already: true } };
    // The service's own record wins over what the agent says; the agent's reason only fills a gap.
    const outcome: CallOutcome =
      s.reservation ? (holdOutcome ?? 'reserved')
      : (s.outcome as CallOutcome | undefined) ?? (s.negotiation?.status === 'no_deal' || s.negotiation?.status === 'open' ? 'no_deal' // pitched, not booked
      : s.locked ? 'not_verified'
      : input.reason ?? 'caller_ended');
    return { state: { createdAt: s.createdAt, expiresAt: s.expiresAt, endedAt: Date.now(), outcome } as CallState, result: { already: false, outcome } };
  });
  if (claim.already) {
    // A later end may still bring the agent's summary (the after-call step sends none); the outcome never changes.
    if (input.summary) await safe(d, () => d.records.updateCall(input.callId, { notes: input.summary!.slice(0, 4000) }));
    return { ok: true as const };
  }
  const { outcome } = claim;
  await safe(d, async () => {
    // A carrier can hang up before giving an MC; the record is created here if no earlier step made it,
    // so every call is captured (brief: all call activity in Twin). startCall is idempotent.
    await d.records.startCall(input.callId);
    await d.records.updateCall(input.callId, {
      ended_at: new Date(),
      outcome,
      ...(input.summary ? { notes: input.summary.slice(0, 4000) } : {}),
    });
    await d.records.event(input.callId, 'call_ended', { outcome });
  });
  return { ok: true as const };
}
