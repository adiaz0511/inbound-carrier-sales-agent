// Counter-offer strategy (decision D-020). Pure: same inputs, same answer, every call.
//
// With P = posted rate, C = ceiling (MAX_BUY), room R = C - P:
//   our counter after the carrier's 1st, 2nd, 3rd counter = P + 35%, 65%, 90% of R, rounded DOWN to $25,
//   never below P, never above C, never lower than our previous counter. The 3rd is our final offer.
// Rules for each carrier ask:
//   - at or below P                      -> accept their ask
//   - at or below our standing counter   -> accept their ask (they took our offer, or came under it)
//   - after our final offer, anything higher -> no deal (polite close, no transfer)
//   - at or below this round's counter   -> accept their ask (we never counter above what they asked)
//   - otherwise                          -> counter (rounds 1-2) or final offer (round 3)
// The final offer stops short of C by 10% of R (then rounded down), so no counter ever equals the ceiling.

export const CONCESSION = [0.35, 0.65, 0.9] as const;
export const MAX_ROUNDS = CONCESSION.length;
const STEP = 25;

export interface NegotiationState {
  postedUsd: number;
  ceilingUsd: number;          // = postedUsd when the TMS gives no MAX_BUY: we can only offer the posted rate
  rounds: number;              // carrier counter-offers so far (0..3)
  standingCounterUsd?: number; // our latest counter / final offer
  finalOffered: boolean;
}

export type Decision =
  | { action: 'accept'; priceUsd: number; consumedRound: boolean }
  | { action: 'counter'; priceUsd: number; round: number }
  | { action: 'final_offer'; priceUsd: number; round: number }
  | { action: 'no_deal' };

export function counterFor(round: number, postedUsd: number, ceilingUsd: number): number {
  const room = Math.max(0, ceilingUsd - postedUsd);
  const raw = postedUsd + CONCESSION[round - 1]! * room;
  const rounded = Math.floor(raw / STEP) * STEP;
  return Math.min(ceilingUsd, Math.max(postedUsd, rounded));
}

export function decide(s: NegotiationState, askUsd: number): Decision {
  if (!Number.isInteger(askUsd) || askUsd <= 0) throw new RangeError('ask must be a positive whole number of dollars');
  if (askUsd <= s.postedUsd) return { action: 'accept', priceUsd: askUsd, consumedRound: false };
  if (s.standingCounterUsd !== undefined && askUsd <= s.standingCounterUsd) return { action: 'accept', priceUsd: askUsd, consumedRound: false };
  if (s.finalOffered || s.rounds >= MAX_ROUNDS) return { action: 'no_deal' };

  const round = s.rounds + 1;
  const counter = Math.max(counterFor(round, s.postedUsd, s.ceilingUsd), s.standingCounterUsd ?? s.postedUsd);
  if (askUsd <= counter) return { action: 'accept', priceUsd: askUsd, consumedRound: true };
  return round < MAX_ROUNDS ? { action: 'counter', priceUsd: counter, round } : { action: 'final_offer', priceUsd: counter, round };
}
