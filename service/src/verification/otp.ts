// One-time codes (decision D-008).
//
// - 6 digits from a cryptographically secure generator (crypto.randomInt), uniform over 000000-999999.
// - Only a keyed hash is stored: HMAC-SHA256(OTP_HASH_KEY, callId | code). A plain hash of a 6-digit code
//   could be reversed by trying all million values; without the key that's impossible. Binding the call id
//   into the hash means a code is useless on any other call.
// - Comparison is constant-time, so response timing reveals nothing about how close a guess was.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_MS = 10 * 60 * 1000;       // NIST SP 800-63B: out-of-band secrets valid <= 10 minutes
export const MAX_WRONG_ATTEMPTS = 3;
export const MAX_SENDS_PER_CALL = 3;              // first send + 2 resends
export const MAX_SENDS_PER_CARRIER_PER_HOUR = 5;  // across calls: stops text-bombing a real carrier

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashCode(key: string, callId: string, code: string): string {
  return createHmac('sha256', key).update(`${callId}|${code}`).digest('hex');
}

export function codeMatches(key: string, callId: string, candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(key, callId, candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Digits the carrier read out. Accepts "123 456", "123-456"; anything that isn't exactly 6 digits is null. */
export function normalizeSpokenCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}
