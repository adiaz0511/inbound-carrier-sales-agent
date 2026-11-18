import { GATE } from '../verification/service.js';
// The carrier check: first step of every call (Phase 3; decisions D-008, D-017, D-019).
//
//   1. Normalize the spoken MC; cap distinct MCs per call (no fishing for valid numbers).
//   2. FMCSA authority (our rule, R-19).
//   3. If eligible, find a contact on file, in trust order:
//        broker records (read from Twin by the workflow and passed in, never from the caller)
//        -> FMCSA census (DOT must match FMCSA's) -> none: polite end + onboarding request.
//      Sandbox carriers (flagged in Twin by ops) are the only ones that may use a caller-given email.
//   4. Remember the full contact in call state (to send the code in Phase 4); return only a masked version.
//   5. Record everything in Twin.
//
// The census lookup runs in parallel with FMCSA when broker records have no contact, to save a round trip.

import type { CallStateStore, CarrierState } from '../storage/call-state.js';
import { maskContact, type CallRecords } from '../storage/twin.js';
import { normalizeMc, toE164, validEmail, type CensusClient, type CensusResult, type FmcsaClient, type FmcsaResult } from './fmcsa.js';

export const MAX_MC_TRIES_PER_CALL = 3;

export interface RegistryRow {
  mcNumber?: string;
  legalName?: string;
  contactPhone?: string;
  contactEmail?: string;
  isSandbox?: boolean;
  status?: string;
}

export interface CheckInput {
  callId: string;
  runUrl?: string;
  mcSpoken: string;
  registry?: RegistryRow;   // undefined when the carrier isn't in broker records
}

export type CheckResult =
  | { result: 'invalid_mc'; next_step: string }
  | { result: 'too_many_attempts'; next_step: string }
  | { result: 'not_found'; mc_number: string; next_step: string }
  | { result: 'fmcsa_unavailable'; next_step: string }
  | { result: 'not_eligible'; mc_number: string; carrier_name: string; reason: 'inactive_authority' | 'not_allowed_to_operate' | 'blocked'; next_step: string }
  | {
      result: 'eligible'; mc_number: string; carrier_name: string;
      verification:
        | { possible: true; channel: 'sms' | 'email'; destination_masked: string; other_channel_available: boolean; needs_caller_email: false }
        | { possible: true; channel: 'email'; destination_masked: null; other_channel_available: false; needs_caller_email: true }
        | { possible: false; reason: 'no_contact_on_file' | 'contact_lookup_unavailable' };
      next_step: string;
    };

export interface CheckDeps {
  fmcsa: FmcsaClient;
  census: CensusClient;
  state: CallStateStore;
  records: CallRecords;
  log: (event: Record<string, unknown>) => void;
}

const say = {
  invalid: 'Ask the carrier to repeat their MC number, digit by digit.',
  tooMany: 'Too many different MC numbers on this call. Kindly ask them to call back with their MC number handy, thank them, then call end_call.',
  notFound: 'That MC number was not found. Ask them to confirm it once, digit by digit; if it is still not found, kindly explain you could not find it in the FMCSA records, suggest they double-check it and call back, then call end_call.',
  fmcsaDown: 'The carrier lookup is not responding right now. Apologize, explain it is a system issue on our side, ask them to try again in a few minutes, thank them, then call end_call.',
  notEligible: 'This carrier does not have active operating authority. Kindly explain that you can only book carriers with active FMCSA authority, that they are welcome to call back once it is active, thank them, then call end_call. Do not transfer.',
  blocked: 'You cannot book with this carrier. Kindly say you are not able to book loads with them at the moment, without giving a reason, thank them for calling, then call end_call. Do not transfer.',
  noContact: 'There is no contact on file to send a verification code to. Kindly explain you need to verify carriers before booking, that a member of the team will reach out to complete their setup, thank them, then call end_call.',
  lookupDown: 'The verification system is not responding right now. Apologize, explain it is a system issue on our side, ask them to try again in a few minutes, thank them, then call end_call.',
  send: (c: string, m: string) => `Tell the carrier you are sending a 6-digit code by ${c === 'sms' ? 'text' : 'email'} to ${m}, then send it.` + GATE,
  sandbox: 'This is a test carrier. Ask for the email address to send the 6-digit code to, then send it.',
};

function cleanRegistry(r: RegistryRow | undefined, mc: string): RegistryRow | undefined {
  // Only trust a registry row that is for this exact MC (the workflow reads it by the normalized MC).
  if (!r || !r.mcNumber || normalizeMc(r.mcNumber) !== mc) return undefined;
  return r;
}

export async function checkCarrier(input: CheckInput, d: CheckDeps): Promise<CheckResult> {
  const mc = normalizeMc(input.mcSpoken);
  if (!mc) return { result: 'invalid_mc', next_step: say.invalid };

  // Count distinct MCs on this call before doing any lookup.
  const identity = await d.state.update(input.callId, (s) => {
    const tries = s.mcTries ?? [];
    if (!tries.includes(mc)) tries.push(mc);
    if (tries.length > MAX_MC_TRIES_PER_CALL) {
      return { state: { ...s, mcTries: tries }, result: { allowed: false, releasedLoadId: undefined as string | undefined } };
    }
    if (s.mcNumber && s.mcNumber !== mc) {
      const releasedLoadId = s.reservation?.loadId;
      const {
        verifiedAt: _verifiedAt, verifiedMc: _verifiedMc, otp: _otp, carrier: _carrier,
        negotiation: _negotiation, reservation: _reservation, transferred: _transferred,
        outcome: _outcome, endedAt: _endedAt, ...preserved
      } = s;
      return {
        state: { ...preserved, mcNumber: mc, mcTries: tries, verified: false },
        result: { allowed: true, releasedLoadId },
      };
    }
    return { state: { ...s, mcTries: tries }, result: { allowed: true, releasedLoadId: undefined as string | undefined } };
  });

  await safe(d, () => d.records.startCall(input.callId, input.runUrl));
  if (!identity.allowed) {
    await safe(d, () => d.records.event(input.callId, 'error', { reason: 'too_many_mc_attempts' }));
    return { result: 'too_many_attempts', next_step: say.tooMany };
  }
  if (identity.releasedLoadId) {
    const released = await d.state.updateReservation(identity.releasedLoadId, (r) => {
      if (!r || r.callId !== input.callId || r.status !== 'reserved') return { result: false };
      return {
        reservation: { ...r, status: 'released', closedAt: Date.now(), closedReason: 'carrier_identity_changed' },
        result: true,
      };
    });
    if (released) {
      await safe(d, () => d.records.event(input.callId, 'reservation_released', {
        load_id: identity.releasedLoadId,
        reason: 'carrier_identity_changed',
      }));
    }
  }

  const registry = cleanRegistry(input.registry, mc);
  const registryPhone = toE164(registry?.contactPhone);
  const registryEmail = validEmail(registry?.contactEmail);
  const needCensus = !registry?.isSandbox && !registryPhone && !registryEmail;

  const t0 = Date.now();
  const [fm, census] = await Promise.all([
    d.fmcsa.lookupMc(mc),
    needCensus ? d.census.contactForMc(mc) : Promise.resolve(null as CensusResult | null),
  ]);
  d.log({ event: 'carrier_lookup', ms: Date.now() - t0, fmcsa: fm.kind, census: census?.kind ?? 'skipped' });

  const fmcsaResult = mapFmcsa(fm);
  await safe(d, () => Promise.all([
    d.records.event(input.callId, 'fmcsa_checked', { mc_number: mc, result: fmcsaResult }),
    d.records.updateCall(input.callId, {
      mc_number: mc, fmcsa_result: fmcsaResult,
      ...('legalName' in fm && fm.legalName ? { carrier_name: fm.legalName } : {}),
    }),
  ]));

  if (fm.kind === 'unavailable') return { result: 'fmcsa_unavailable', next_step: say.fmcsaDown };
  if (fm.kind === 'not_found') return { result: 'not_found', mc_number: mc, next_step: say.notFound };
  if (fm.kind !== 'eligible') {
    await finish(d, input.callId, 'not_eligible');
    return { result: 'not_eligible', mc_number: mc, carrier_name: fm.legalName, reason: fm.kind, next_step: say.notEligible };
  }
  if (registry?.status === 'blocked') {
    await finish(d, input.callId, 'not_eligible', 'blocked in broker records');
    return { result: 'not_eligible', mc_number: mc, carrier_name: fm.legalName, reason: 'blocked', next_step: say.blocked };
  }

  // Contact on file, in trust order.
  let carrier: CarrierState = { mcNumber: mc, dotNumber: fm.dotNumber, legalName: fm.legalName, eligible: true };
  if (registry?.isSandbox) {
    carrier = { ...carrier, contactSource: 'sandbox_caller', sandbox: true };
  } else if (registryPhone || registryEmail) {
    carrier = { ...carrier, contactSource: 'broker_records', phone: registryPhone, email: registryEmail };
  } else if (census?.kind === 'found' && census.contact.dotNumber === fm.dotNumber && (census.contact.phone || census.contact.email)) {
    carrier = { ...carrier, contactSource: 'fmcsa_census', phone: census.contact.phone, email: census.contact.email };
  } else if (census?.kind === 'unavailable') {
    await d.state.update(input.callId, (s) => ({ state: { ...s, mcNumber: mc, carrier }, result: null }));
    await safe(d, () => d.records.event(input.callId, 'contact_resolved', { source: null, reason: 'census_unavailable' }));
    return { result: 'eligible', mc_number: mc, carrier_name: fm.legalName, verification: { possible: false, reason: 'contact_lookup_unavailable' }, next_step: say.lookupDown };
  }

  await d.state.update(input.callId, (s) => ({ state: { ...s, mcNumber: mc, carrier }, result: null }));

  if (!carrier.contactSource) {
    await safe(d, () => Promise.all([
      d.records.event(input.callId, 'contact_resolved', { source: null, reason: 'no_contact_on_file' }),
      d.records.onboardingRequest(input.callId, mc, fm.legalName, 'no_contact_on_file'),
      d.records.updateCall(input.callId, { verification_status: 'no_contact' }),
    ]));
    await finish(d, input.callId, 'no_contact');
    return { result: 'eligible', mc_number: mc, carrier_name: fm.legalName, verification: { possible: false, reason: 'no_contact_on_file' }, next_step: say.noContact };
  }

  if (carrier.sandbox) {
    await safe(d, () => Promise.all([
      d.records.event(input.callId, 'contact_resolved', { source: 'sandbox_caller' }),
      d.records.updateCall(input.callId, { contact_source: 'sandbox_caller', verification_channel: 'email' }),
    ]));
    return { result: 'eligible', mc_number: mc, carrier_name: fm.legalName,
      verification: { possible: true, channel: 'email', destination_masked: null, other_channel_available: false, needs_caller_email: true }, next_step: say.sandbox };
  }

  const channel: 'sms' | 'email' = carrier.phone ? 'sms' : 'email'; // SMS first: drivers are on the road (D-008)
  const masked = maskContact((channel === 'sms' ? carrier.phone : carrier.email)!);
  await safe(d, () => Promise.all([
    d.records.event(input.callId, 'contact_resolved', { source: carrier.contactSource, channel, destination: masked }),
    d.records.updateCall(input.callId, { contact_source: carrier.contactSource, verification_channel: channel }),
  ]));
  return {
    result: 'eligible', mc_number: mc, carrier_name: fm.legalName,
    verification: { possible: true, channel, destination_masked: masked, other_channel_available: !!(carrier.phone && carrier.email), needs_caller_email: false },
    next_step: say.send(channel, masked),
  };
}

function mapFmcsa(fm: FmcsaResult) {
  return fm.kind === 'unavailable' ? ('fmcsa_unavailable' as const) : fm.kind;
}

async function finish(d: CheckDeps, callId: string, outcome: 'not_eligible' | 'no_contact', notes?: string) {
  await d.state.update(callId, (s) => ({ state: { ...s, outcome }, result: null }));
  await safe(d, () => d.records.updateCall(callId, { outcome, ...(notes ? { notes } : {}) }));
}

// The call must go on even if an audit write fails; the failure is logged loudly (and Cloud Logging keeps it)
// so the record can be repaired. A conversation is never broken by a logging problem.
async function safe(d: CheckDeps, write: () => Promise<unknown>) {
  try { await write(); } catch (e) { d.log({ event: 'audit_write_failed', error: (e as Error).message.slice(0, 200) }); }
}
