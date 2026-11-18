// End-to-end call on Cloud Run staging, ending with NO booking: carrier check, code, search, pitch,
// three counters, final offer, carrier holds out -> no deal, end of call. Prints only what the agent sees.
//   cd service && OAUTH_CLIENT_SECRET=... npx tsx ../docs/research/probes/negotiation-e2e.mts
import { randomUUID } from 'node:crypto';

const U = 'https://carrier-sales-staging-891703837363.us-central1.run.app';
const tokRes = await fetch(`${U}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'happyrobot', client_secret: process.env.OAUTH_CLIENT_SECRET! }),
});
const tok = (await tokRes.json()).access_token;
const call = randomUUID();
console.log('call', call);
const seen: string[] = [];

async function step(name: string, path: string, body: object, show: (j: any) => unknown) {
  const t0 = performance.now();
  const r = await fetch(U + path, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!path.endsWith('/deliver')) seen.push(JSON.stringify(j)); // what the model would see (deliver is hidden)
  console.log(`${name.padEnd(30)} ${(performance.now() - t0).toFixed(0).padStart(4)} ms ->`, JSON.stringify(show(j)));
  return j;
}

await step('carrier check', '/v1/carrier/check', { call_id: call, mc_number: '133655' }, (j) => j.result);
await step('send code', '/v1/verification/send', { call_id: call }, (j) => j.sent);
const sent = { deliver_code: (await step('deliver code (hidden step)', '/v1/verification/deliver', { call_id: call }, (j) => j.ok)).code as string };
await step('check code', '/v1/verification/check', { call_id: call, code: sent.deliver_code }, (j) => j.verified);
const found = await step('search flatbed', '/v1/loads/search', { call_id: call, equipment: 'flatbed', limit: 1 },
  (j) => j.loads?.[0] && `${j.loads[0].load_id} ${j.loads[0].origin} -> ${j.loads[0].destination} $${j.loads[0].posted_rate_usd}`);
const load = found.loads[0];
const start = await step('start negotiation', '/v1/negotiation/start', { call_id: call, load_id: load.load_id }, (j) => ({ pitch: j.pitch_rate_usd }));
const P = start.pitch_rate_usd as number;
// The carrier always asks well above our standing offer, so this can never reach a deal (and never book).
// (Lesson from 2026-11-09: computing asks as fixed % of the posted rate once landed exactly on the final
// offer, which is an acceptance; a booking followed. Asks are now derived from our last counter instead.)
let standing = P;
for (let i = 0; i < 4; i++) {
  const ask = standing + 300;
  const r = await step(`carrier asks $${ask}`, '/v1/negotiation/offer', { call_id: call, carrier_offer_usd: ask }, (j) => [j.decision, j.price_usd ?? null, j.rounds_left ?? null]);
  if (r.decision === 'accept') throw new Error('unexpected acceptance: stopping before any booking');
  if (r.decision === 'no_deal') break;
  standing = r.price_usd;
}
await step('try to reserve anyway (must refuse)', '/v1/reservations', { call_id: call }, (j) => [j.ok, j.reason]);
await step('end call', '/v1/calls/end', { call_id: call, reason: 'caller_ended' }, (j) => j.ok);
console.log('agent-visible responses mention a ceiling or max buy:', /max_?buy|ceiling/i.test(seen.join(' ')));
