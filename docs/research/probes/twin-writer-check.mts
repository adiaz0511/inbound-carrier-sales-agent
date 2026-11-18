// Live check of the least-privilege Twin writer key (D-018, D-019) against Twin STAGING.
// Writes one test call with every kind of row the service writes, then confirms the key can NOT
// delete rows or reach other parts of the platform. Never prints the key.
// Afterwards, remove the test rows with an account that may delete (the writer key can't, by design).
//   cd service && npx tsx --env-file=../.env ../docs/research/probes/twin-writer-check.mts
import { randomUUID } from 'node:crypto';
import { CallRecords, TwinWriter } from '../../../service/src/storage/twin.ts';

const key = process.env.TWIN_WRITER_API_KEY!;
const writer = new TwinWriter({ apiKey: key, environment: 'staging' });
const rec = new CallRecords(writer, 'staging');
const callId = randomUUID();
const step = async (name: string, fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  try { await fn(); console.log(`ok    ${name} (${(performance.now() - t0).toFixed(0)} ms)`); }
  catch (e) { console.log(`FAIL  ${name}: ${(e as Error).message.slice(0, 160)}`); }
};
console.log('test call_id:', callId);
await step('insert calls', () => rec.startCall(callId, 'https://example.invalid/run'));
await step('insert calls again (idempotent)', () => rec.startCall(callId));
await step('insert call_events', () => rec.event(callId, 'call_started', { note: 'twin-writer-check' }));
await step('insert offers', () => rec.offer(callId, 'LD01075', 1, 2300, 'counter', 2150));
await step('insert load_pricing', () => rec.pricing(callId, 'LD01075', 2037, 2274, 2150));
await step('insert onboarding_requests', () => rec.onboardingRequest(callId, '999999', 'Test Carrier', 'no_contact_on_file'));
await step('update calls', () => rec.updateCall(callId, { outcome: 'no_deal', counter_rounds: 1, notes: 'twin-writer-check' }));
await step('bad value is rejected by the schema (expect FAIL)', () => rec.updateCall(callId, { outcome: 'made_up' }));

const api = 'https://platform.happyrobot.ai/api/v2';
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-twin-environment': 'staging' };
const eventId = await rec.event(callId, 'call_ended', { note: 'delete-check' });
const del = await fetch(`${api}/twin/tables/call_events/rows`, { method: 'DELETE', headers: H, body: JSON.stringify({ rowKeys: [{ event_id: eventId }] }) });
console.log(`delete rows (expect 403): HTTP ${del.status} ${(await del.text()).slice(0, 120)}`);
const wf = await fetch(`${api}/workflows/`, { headers: H });
console.log(`list workflows (expect 403): HTTP ${wf.status}`);
