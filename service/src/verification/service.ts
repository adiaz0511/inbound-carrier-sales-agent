// Sending and checking one-time codes, and the verification gate (Phase 4, decision D-008).
//
// The code goes only to the contact found by the carrier check (Phase 3), kept in call state. The single
// exception is a sandbox carrier (flagged by ops in Twin), which may give an email for testing.
//
// Limits, all enforced atomically in call state:
//   - 10-minute codes; a resend replaces the previous code (only the newest one works)
//   - 3 sends per call (first + 2 resends); 5 sends per carrier per hour across all calls
//   - 3 wrong codes per call in total, never reset by a resend; then verification is locked for the call
//
// Two steps, so the code never reaches the model (D-024):
//   sendCode     the agent-facing step: checks, limits, picks the destination. Returns only safe fields
//                (channel, masked destination); no code exists yet. Any older code stops working.
//   deliverCode  a separate workflow step, hidden from the model as a whole step: creates the code once,
//                stores only its keyed hash, and hands code + full destination to HappyRobot's email/SMS step.

import type { CallState, CallStateStore } from '../storage/call-state.js';
import { maskContact, type CallRecords } from '../storage/twin.js';
import { validEmail } from '../carriers/fmcsa.js';
import {
  CODE_TTL_MS, MAX_SENDS_PER_CALL, MAX_SENDS_PER_CARRIER_PER_HOUR, MAX_WRONG_ATTEMPTS,
  codeMatches, generateCode, hashCode, normalizeSpokenCode,
} from './otp.js';

export interface VerificationDeps {
  state: CallStateStore;
  records: CallRecords;
  hashKey: string;
  // Channels the workflow can actually deliver on (CODE_CHANNELS). A code is never sent down a channel
  // that can't reach the carrier. Defaults to both; production config narrows it (D-023).
  channels?: readonly ('sms' | 'email')[];
  log: (event: Record<string, unknown>) => void;
}

export type SendResult =
  | { sent: true; channel: 'sms' | 'email'; destination_masked: string; expires_in_seconds: number; sends_left: number;
      next_step: string }
  | { sent: false; reason: 'carrier_not_checked' | 'already_verified' | 'locked' | 'no_contact' | 'channel_unavailable'
      | 'caller_email_required' | 'caller_email_invalid' | 'too_many_sends' | 'carrier_rate_limited'; next_step: string };

export type CheckResult =
  | { verified: true; next_step: string }
  | { verified: false; reason: 'unclear' | 'no_code_sent' | 'expired' | 'wrong_code' | 'locked'; attempts_left: number; can_resend: boolean; next_step: string };

type PerCall = { ok: false } | { ok: true; sends: number };
type Outcome =
  | { kind: 'verified'; already: boolean }
  | { kind: 'locked'; newlyLocked: boolean }
  | { kind: 'wrong' | 'expired' | 'no_code' | 'unclear'; left: number; canResend: boolean };

// Repeated in every pre-verification instruction: the model obeys the newest text best (adversarial test 'Owner authority').
export const GATE = " Until they're verified, don't mention loads, lanes, rates or what they asked for, and don't promise to look for them.";

const tell = {
  notChecked: 'Check the carrier\'s MC number first.',
  already: 'The carrier is already verified. Continue with their lane and equipment.',
  locked: 'Verification failed too many times, so you cannot continue on this call. Kindly explain that for security you can only work with verified callers, that a member of the team can help them get verified, then call end_call. Do not search for loads.',
  noContact: 'There is no contact on file to send a code to. Kindly explain you need to verify carriers before booking, that a member of the team will reach out to set them up, thank them for calling, then call end_call.',
  channel: 'That channel is not on file. Offer to send the code to the contact on file instead.',
  needEmail: 'Ask for the email address to send the code to.' + GATE,
  badEmail: 'That email address does not look valid. Ask them to spell it again.' + GATE,
  tooMany: 'No more codes can be sent on this call. Apologize for the trouble, suggest they check their inbox and spam folder and call back once they have the email, thank them, then call end_call.',
  rateLimited: 'For security, no more codes can be sent to this carrier for about an hour. Apologize for the inconvenience, explain they can call back in an hour to get verified, thank them for their patience, then call end_call.',
  sent: (ch: string, m: string) => `Code sent by ${ch === 'sms' ? 'text' : 'email'} to ${m}. Ask the carrier to read the 6 digits back. Do not search for loads until it is verified.` + GATE,
  verified: 'Verified. Ask for their lane (where they pick up and deliver) and equipment, then search loads.',
  unclear: 'Ask the carrier to read the 6-digit code again, digit by digit.' + GATE,
  noCode: 'No code has been sent yet. Send the code first.' + GATE,
  expired: 'That code expired. Offer to send a new one.' + GATE,
  expiredNoResend: 'That code expired and no more codes can be sent on this call. Apologize, invite them to call back to get a fresh code, thank them, then call end_call.',
  wrong: (left: number) => `That code is not correct. ${left} ${left === 1 ? 'try' : 'tries'} left. Ask them to check the latest message and read it again.` + GATE,
};

export async function sendCode(
  input: { callId: string; channel?: 'sms' | 'email'; callerEmail?: string },
  d: VerificationDeps,
): Promise<SendResult> {
  const current = await d.state.get(input.callId);
  const carrier = current?.carrier;
  if (!current || !carrier?.eligible) return { sent: false, reason: 'carrier_not_checked', next_step: tell.notChecked };
  if (current.verifiedAt && current.verifiedMc === carrier.mcNumber) return { sent: false, reason: 'already_verified', next_step: tell.already };
  if (current.locked) return { sent: false, reason: 'locked', next_step: tell.locked };

  // Destination: the contact on file only. A caller-given email is accepted for sandbox carriers alone.
  let channel: 'sms' | 'email';
  let to: string;
  const allowed = new Set(d.channels ?? ['sms', 'email']);
  if (carrier.sandbox) {
    if (!allowed.has('email')) return { sent: false, reason: 'channel_unavailable', next_step: tell.channel };
    if (!input.callerEmail) return { sent: false, reason: 'caller_email_required', next_step: tell.needEmail };
    const email = validEmail(input.callerEmail);
    if (!email) return { sent: false, reason: 'caller_email_invalid', next_step: tell.badEmail };
    channel = 'email'; to = email;
  } else {
    const usable = {
      sms: allowed.has('sms') ? carrier.phone : undefined,
      email: allowed.has('email') ? carrier.email : undefined,
    };
    if (!usable.sms && !usable.email) return { sent: false, reason: 'no_contact', next_step: tell.noContact };
    const wanted = input.channel ?? (usable.sms ? 'sms' : 'email'); // SMS first when it can be delivered (D-008)
    const target = usable[wanted];
    if (!target) return { sent: false, reason: 'channel_unavailable', next_step: tell.channel };
    channel = wanted; to = target;
  }

  // Per-call send limit, atomically. The code itself is created by deliverCode; any older code dies here.
  const masked = maskContact(to);
  const perCall = await d.state.update<PerCall>(input.callId, (s) => {
    const sends = (s.otp?.sends ?? 0) + 1;
    if (sends > MAX_SENDS_PER_CALL) return { state: s, result: { ok: false } };
    const otp = { expiresAt: 0, sends, channel, destinationMasked: masked, pendingTo: to };
    return { state: { ...s, otp }, result: { ok: true, sends } };
  });
  if (!perCall.ok) return { sent: false, reason: 'too_many_sends', next_step: tell.tooMany };

  // Per-carrier limit across calls. Counted after the per-call check so a refused send isn't counted twice.
  const recent = await d.state.bumpCarrierCounter(carrier.mcNumber, 'code_sends', 60 * 60 * 1000);
  if (recent > MAX_SENDS_PER_CARRIER_PER_HOUR) {
    await d.state.update(input.callId, (s) => ({ state: { ...s, otp: undefined }, result: null })); // no live code
    await safe(d, () => d.records.event(input.callId, 'error', { reason: 'carrier_code_rate_limited' }));
    return { sent: false, reason: 'carrier_rate_limited', next_step: tell.rateLimited };
  }

  await safe(d, () => Promise.all([
    d.records.event(input.callId, 'code_sent', { channel, destination: masked, send_number: perCall.sends }),
    d.records.updateCall(input.callId, { verification_status: 'code_sent', verification_channel: channel }),
  ]));
  return {
    sent: true, channel, destination_masked: masked, expires_in_seconds: CODE_TTL_MS / 1000,
    sends_left: MAX_SENDS_PER_CALL - perCall.sends, next_step: tell.sent(channel, masked),
  };
}

export type DeliverResult =
  | { ok: true; channel: 'sms' | 'email'; to: string; code: string }
  | { ok: false; reason: 'nothing_to_deliver' };

/**
 * Creates the code for the send that sendCode just approved, exactly once, and returns it with the full
 * destination for HappyRobot's email/SMS step. Called by a workflow step that is hidden from the model (D-024);
 * the model has no tool that reaches it. A second call for the same send gets nothing.
 */
export async function deliverCode(input: { callId: string }, d: VerificationDeps): Promise<DeliverResult> {
  const code = generateCode();
  const r = await d.state.update<DeliverResult>(input.callId, (s) => {
    const otp = s.otp;
    if (!otp?.pendingTo || s.verifiedAt || s.locked) return { state: s, result: { ok: false, reason: 'nothing_to_deliver' } };
    const next = { ...otp, codeHash: hashCode(d.hashKey, input.callId, code), expiresAt: Date.now() + CODE_TTL_MS, pendingTo: undefined };
    return { state: { ...s, otp: next }, result: { ok: true, channel: otp.channel, to: otp.pendingTo, code } };
  });
  if (!r.ok) d.log({ event: 'code_delivery_refused', reason: r.reason });
  return r;
}

export async function checkCode(input: { callId: string; codeSpoken: string }, d: VerificationDeps): Promise<CheckResult> {
  const candidate = normalizeSpokenCode(input.codeSpoken);
  const now = Date.now();

  const outcome = await d.state.update<Outcome>(input.callId, (s): { state: CallState; result: Outcome } => {
    const left = MAX_WRONG_ATTEMPTS - (s.wrongAttempts ?? 0);
    const canResend = (s.otp?.sends ?? 0) < MAX_SENDS_PER_CALL;
    if (s.verifiedAt && s.verifiedMc === s.carrier?.mcNumber) return { state: s, result: { kind: 'verified' as const, already: true } };
    if (s.locked) return { state: s, result: { kind: 'locked' as const, newlyLocked: false } };
    if (!s.otp?.codeHash) return { state: s, result: { kind: 'no_code' as const, left, canResend } }; // none, or not delivered yet
    if (candidate === null) return { state: s, result: { kind: 'unclear' as const, left, canResend } }; // not a guess
    if (s.otp.expiresAt <= now) return { state: s, result: { kind: 'expired' as const, left, canResend } };
    if (codeMatches(d.hashKey, input.callId, candidate, s.otp.codeHash)) {
      // Single use: the code is destroyed the moment it works.
      if (!s.carrier?.eligible) return { state: s, result: { kind: 'no_code' as const, left, canResend } };
      return {
        state: { ...s, otp: undefined, verifiedAt: now, verifiedMc: s.carrier.mcNumber, verified: true } as CallState,
        result: { kind: 'verified' as const, already: false },
      };
    }
    const wrong = (s.wrongAttempts ?? 0) + 1;
    const locked = wrong >= MAX_WRONG_ATTEMPTS;
    return {
      state: { ...s, wrongAttempts: wrong, locked, otp: locked ? undefined : s.otp, ...(locked ? { outcome: 'not_verified' } : {}) },
      result: locked ? { kind: 'locked' as const, newlyLocked: true } : { kind: 'wrong' as const, left: MAX_WRONG_ATTEMPTS - wrong, canResend },
    };
  });

  switch (outcome.kind) {
    case 'verified':
      if (!outcome.already) {
        await safe(d, () => Promise.all([
          d.records.event(input.callId, 'code_verified'),
          d.records.updateCall(input.callId, { verification_status: 'verified', verified_at: new Date(now) }),
        ]));
      }
      return { verified: true, next_step: tell.verified };
    case 'locked':
      if (outcome.newlyLocked) {
        await safe(d, () => Promise.all([
          d.records.event(input.callId, 'code_locked', { wrong_attempts: MAX_WRONG_ATTEMPTS }),
          d.records.updateCall(input.callId, { verification_status: 'failed', outcome: 'not_verified' }),
        ]));
      }
      return { verified: false, reason: 'locked', attempts_left: 0, can_resend: false, next_step: tell.locked };
    case 'wrong':
      await safe(d, () => d.records.event(input.callId, 'code_wrong', { attempts_left: outcome.left }));
      return { verified: false, reason: 'wrong_code', attempts_left: outcome.left, can_resend: outcome.canResend, next_step: tell.wrong(outcome.left) };
    case 'expired':
      return { verified: false, reason: 'expired', attempts_left: outcome.left, can_resend: outcome.canResend, next_step: outcome.canResend ? tell.expired : tell.expiredNoResend };
    case 'no_code':
      return { verified: false, reason: 'no_code_sent', attempts_left: outcome.left, can_resend: outcome.canResend, next_step: tell.noCode };
    case 'unclear':
      return { verified: false, reason: 'unclear', attempts_left: outcome.left, can_resend: outcome.canResend, next_step: tell.unclear };
  }
  throw new Error('unreachable');
}

/** The gate: true only if this call has passed the code check. Used by every load route (and booking). */
export async function isVerified(state: CallStateStore, callId: string): Promise<boolean> {
  const s = await state.get(callId);
  return !!s?.verifiedAt && !s.locked && !!s.carrier?.eligible && s.verifiedMc === s.carrier.mcNumber;
}

async function safe(d: VerificationDeps, write: () => Promise<unknown>) {
  try { await write(); } catch (e) { d.log({ event: 'audit_write_failed', error: (e as Error).message.slice(0, 200) }); }
}
