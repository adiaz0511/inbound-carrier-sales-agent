import { describe, expect, it } from 'vitest';
import { counterFor, decide, MAX_ROUNDS, type NegotiationState } from '../src/negotiation/strategy.js';

const LD01075 = { postedUsd: 2037, ceilingUsd: 2274 }; // real live load (R-17)
const fresh = (o: Partial<NegotiationState> = {}): NegotiationState => ({ ...LD01075, rounds: 0, finalOffered: false, ...o });

// Plays a whole negotiation against a carrier who asks the given prices in order.
function play(asks: number[], base = LD01075) {
  let s: NegotiationState = { ...base, rounds: 0, finalOffered: false };
  const log: string[] = [];
  for (const ask of asks) {
    const d = decide(s, ask);
    log.push(d.action === 'no_deal' ? 'no_deal' : `${d.action}:${d.priceUsd}`);
    if (d.action === 'accept' || d.action === 'no_deal') return log;
    s = { ...s, rounds: d.round, standingCounterUsd: d.priceUsd, finalOffered: d.action === 'final_offer' };
  }
  return log;
}

describe('the D-020 counters for a real load (LD01075: posted $2,037, ceiling $2,274)', () => {
  it('counters $2,100, $2,175, then a final $2,250; the $2,274 ceiling is never offered', () => {
    expect([1, 2, 3].map((r) => counterFor(r, 2037, 2274))).toEqual([2100, 2175, 2250]);
    expect(play([2400, 2300, 2280])).toEqual(['counter:2100', 'counter:2175', 'final_offer:2250']);
  });

  it('the worked example: carrier takes the final offer', () => {
    expect(play([2400, 2300, 2280, 2250])).toEqual(['counter:2100', 'counter:2175', 'final_offer:2250', 'accept:2250']);
  });

  it('an ask under this round\'s counter is accepted as asked (we never pay more than they asked)', () => {
    expect(play([2400, 2150])).toEqual(['counter:2100', 'accept:2150']);
  });

  it('a carrier taking our standing counter is accepted without spending a round', () => {
    expect(decide(fresh({ rounds: 1, standingCounterUsd: 2100 }), 2100)).toEqual({ action: 'accept', priceUsd: 2100, consumedRound: false });
  });

  it('asking at or below the posted rate is accepted at once', () => {
    expect(play([2037])).toEqual(['accept:2037']);
    expect(play([1900])).toEqual(['accept:1900']);
  });

  it('after the final offer, holding out means no deal (no 4th round)', () => {
    expect(play([2400, 2300, 2280, 2270])).toEqual(['counter:2100', 'counter:2175', 'final_offer:2250', 'no_deal']);
  });
});

describe('safety properties, over many loads and carrier behaviors', () => {
  // Every posted/ceiling pair from 500 to 6,000 in steps, and many ask patterns.
  const loads: { postedUsd: number; ceilingUsd: number }[] = [];
  for (let p = 500; p <= 6000; p += 137) for (const pct of [0, 0.03, 0.08, 0.1, 0.12, 0.2]) loads.push({ postedUsd: p, ceilingUsd: Math.round(p * (1 + pct)) });
  const patterns = (P: number, C: number) => [
    [C + 500, C + 400, C + 300, C + 200], [C, C, C, C], [C + 1, C + 1, C + 1, C + 1],
    [Math.round(P * 1.3), Math.round(P * 1.2), Math.round(P * 1.15), Math.round(P * 1.1)],
    [C - 1, C - 1, C - 1], [P + 1], [Math.round((P + C) / 2), Math.round((P + C) / 2)],
  ];

  it('never accepts or offers anything above the ceiling', () => {
    for (const l of loads) for (const asks of patterns(l.postedUsd, l.ceilingUsd)) {
      for (const step of play(asks, l)) {
        const price = Number(step.split(':')[1]);
        if (!Number.isNaN(price)) expect(price).toBeLessThanOrEqual(l.ceilingUsd);
      }
    }
  });

  it('never offers the ceiling itself when there is room to stay under it (no leak by pattern)', () => {
    for (const l of loads) {
      if (l.ceilingUsd - l.postedUsd < 50) continue; // too little room to stay a $25 step below
      for (const asks of patterns(l.postedUsd, l.ceilingUsd)) {
        for (const step of play(asks, l)) {
          if (step.startsWith('counter') || step.startsWith('final_offer')) expect(Number(step.split(':')[1])).toBeLessThan(l.ceilingUsd);
        }
      }
    }
  });

  it('our counters never go down, and stop after 3 rounds', () => {
    for (const l of loads) {
      const log = play([l.ceilingUsd + 900, l.ceilingUsd + 800, l.ceilingUsd + 700, l.ceilingUsd + 600, l.ceilingUsd + 500], l);
      const prices = log.filter((x) => x.includes(':')).map((x) => Number(x.split(':')[1]));
      expect([...prices].sort((a, b) => a - b)).toEqual(prices);
      expect(log.filter((x) => x.startsWith('counter') || x.startsWith('final')).length).toBeLessThanOrEqual(MAX_ROUNDS);
    }
  });

  it('with no ceiling from the TMS, only the posted rate is ever offered', () => {
    expect(play([2400, 2300, 2280], { postedUsd: 2037, ceilingUsd: 2037 })).toEqual(['counter:2037', 'counter:2037', 'final_offer:2037']);
  });

  it('is deterministic: the same load and asks always give the same answers', () => {
    expect(play([2400, 2300, 2280])).toEqual(play([2400, 2300, 2280]));
  });

  it('refuses nonsense asks', () => {
    expect(() => decide(fresh(), 0)).toThrow();
    expect(() => decide(fresh(), 2100.5)).toThrow();
  });
});
