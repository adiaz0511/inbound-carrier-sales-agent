// Pre-recording check for the walkthrough video. READ-ONLY: LOAD_GET only. Never books. Never prints the token.
//
//   npx tsx --env-file=../.env scripts/demo-check.ts [LOAD_ID=LD01157]
//
// Prints the load's status, posted rate, ceiling and the service's three counters,
// so the video script's numbers can be checked against the live TMS before recording.
import { TmsClient } from '../src/tms/client.js';
import { counterFor } from '../src/negotiation/strategy.js';

const id = process.argv[2] ?? 'LD01157';
const c = new TmsClient({
  host: process.env.TMS_HOST!, port: Number(process.env.TMS_PORT), token: process.env.TMS_AUTH_TOKEN!,
  timeoutMs: 2000, maxAttempts: 4, log: () => {},
});
const r = await c.getLoad(id);
if (!r.ok || !r.value) { console.log(`${id}: not found or TMS unavailable`); process.exit(1); }
const l = r.value;
console.log(`${l.loadId} ${l.status} ${l.equipment} ${l.origin.city}, ${l.origin.state} -> ${l.destination.city}, ${l.destination.state}`);
console.log(`pickup ${l.pickupAt.toISOString()}  miles ${l.miles}  weight ${l.weightLbs} lb  ${l.commodity}`);
console.log(`posted $${l.postedRate}  ceiling $${l.maxBuy ?? '-'}`);
if (l.maxBuy !== undefined) {
  console.log(`counters: round 1 $${counterFor(1, l.postedRate, l.maxBuy)}, round 2 $${counterFor(2, l.postedRate, l.maxBuy)}, final $${counterFor(3, l.postedRate, l.maxBuy)}`);
}
