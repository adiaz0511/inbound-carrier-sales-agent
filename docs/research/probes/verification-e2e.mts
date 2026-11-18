// End-to-end check of Phase 4 on Cloud Run staging: carrier check, gate before verifying, send, wrong code,
// right code, search after verifying, unverified call refused. Never prints the code. Clean up test rows afterwards.
//   cd service && OAUTH_CLIENT_SECRET=... npx tsx ../docs/research/probes/verification-e2e.mts
import { randomUUID } from 'node:crypto';
const U = 'https://carrier-sales-staging-891703837363.us-central1.run.app';
const tok = (await (await fetch(`${U}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'happyrobot', client_secret: process.env.OAUTH_CLIENT_SECRET! }) })).json()).access_token;
const call = randomUUID(); console.log('call', call);
async function step(name: string, method: string, path: string, body?: unknown, show: (j: any) => unknown = (j) => j) {
  const t0 = performance.now();
  const r = await fetch(U + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); console.log(`${name.padEnd(34)} HTTP ${r.status} ${(performance.now() - t0).toFixed(0).padStart(4)} ms ->`, JSON.stringify(show(j)));
  return j;
}
await step('1. carrier check (MC 133655)', 'POST', '/v1/carrier/check', { call_id: call, mc_number: 'MC 133655' }, (j) => [j.result, j.verification?.channel, j.verification?.destination_masked]);
await step('2. search BEFORE verifying', 'POST', '/v1/loads/search', { call_id: call, equipment: 'reefer' }, (j) => j.error);
await step('3. send code', 'POST', '/v1/verification/send', { call_id: call }, (j) => ({ sent: j.sent, channel: j.channel, to: j.destination_masked, code_in_response: 'deliver_code' in j || 'code' in j }));
// The hidden workflow step (D-024): creates the code once and returns it for the email step. Never printed.
const sent = { deliver_code: (await step('3b. deliver (hidden step)', 'POST', '/v1/verification/deliver', { call_id: call }, (j) => ({ ok: j.ok, code: j.code ? '<6 digits, hidden>' : null }))).code as string };
const wrong = sent.deliver_code === '000000' ? '111111' : '000000';
await step('4. wrong code', 'POST', '/v1/verification/check', { call_id: call, code: wrong }, (j) => [j.verified, j.reason, j.attempts_left]);
await step('5. right code (spoken "123 456")', 'POST', '/v1/verification/check', { call_id: call, code: `${sent.deliver_code.slice(0, 3)} ${sent.deliver_code.slice(3)}` }, (j) => j.verified);
await step('6. same code again (single use)', 'POST', '/v1/verification/check', { call_id: call, code: sent.deliver_code }, (j) => j.verified);
await step('7. search AFTER verifying', 'POST', '/v1/loads/search', { call_id: call, equipment: 'reefer', limit: 2 }, (j) => j.loads?.map((l: any) => `${l.load_id} ${l.origin} -> ${l.destination}`));
await step('8. another call, not verified', 'POST', '/v1/loads/search', { call_id: randomUUID(), equipment: 'reefer' }, (j) => j.error);
