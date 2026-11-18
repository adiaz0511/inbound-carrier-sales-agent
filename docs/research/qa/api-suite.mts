import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://carrier-sales-staging-891703837363.us-central1.run.app';
const ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url));
const RESULTS_MD = fileURLToPath(new URL('./api-suite-results.md', import.meta.url));
const RESULTS_JSON = fileURLToPath(new URL('./api-suite-results.json', import.meta.url));
const CONFIRM_PATH = '/v1/reservations/confirm';
const REVIEWER_EMAIL = 'qa-reviewer@example.com';
const DEMO_EMAIL = 'demo@example.com';
const KNOWN_CEILINGS = new Set([2274, 1383]);

type Json = Record<string, any>;
type Result = 'PASS' | 'FAIL' | 'BLOCKED';
type Row = { id: string; scenario: string; requirement: string; result: Result; detail: string };
type Reply = { status: number; body: Json };
type AgentResponse = { label: string; status: number; body: Json; requestFields: string[] };
type EndReason = 'no_match' | 'caller_ended' | 'not_verified' | 'tms_unavailable' | 'error';

class Blocked extends Error {}
class SafetyStop extends Error {}

function parseEnv(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

const env = parseEnv(await readFile(ENV_PATH, 'utf8'));
function envValue(name: string): string | undefined {
  return env.get(name) || undefined;
}
const INCONSISTENT_LOAD_ID = envValue('QA_INCONSISTENT_LOAD_ID');
function required(name: string): string {
  const value = env.get(name);
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function safeText(value: unknown): string {
  return String(value ?? 'unknown').replace(/\b\d{6}\b/g, '<code>').replace(/[\r\n|]+/g, ' ').slice(0, 240);
}

function inspectBooking(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(inspectBooking);
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '');
    if (normalized === 'bookingref' && item) throw new SafetyStop('A response contained a booking reference; stopped immediately.');
    if (key.toLowerCase() === 'status' && item === 'booked') throw new SafetyStop('A response contained status booked; stopped immediately.');
    inspectBooking(item);
  }
}

async function decode(response: Response, label: string): Promise<Json> {
  try {
    const value = await response.json() as Json;
    inspectBooking(value);
    return value;
  } catch (error) {
    if (error instanceof SafetyStop) throw error;
    throw new Error(`${label} returned non-JSON (HTTP ${response.status})`);
  }
}

async function getToken(clientId: string, clientSecret: string, scope: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const body = await decode(response, 'OAuth token request');
  if (!response.ok || body.scope !== scope || typeof body.access_token !== 'string') throw new Error(`Could not obtain ${scope} token`);
  return body.access_token;
}

const workflowToken = await getToken(required('OAUTH_CLIENT_ID'), required('OAUTH_CLIENT_SECRET'), 'carrier-calls');
const opsToken = await getToken(required('OPS_CLIENT_ID'), required('OPS_CLIENT_SECRET'), 'ops');
const agentResponses: AgentResponse[] = [];

async function request(
  label: string,
  path: string,
  options: { token?: string; method?: 'GET' | 'POST'; body?: object; agentFacing?: boolean } = {},
): Promise<Reply> {
  const token = options.token;
  if (path === CONFIRM_PATH) throw new SafetyStop('Refused to call reservation confirmation.');
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await decode(response, label);
  if (options.agentFacing) agentResponses.push({
    label,
    status: response.status,
    body,
    requestFields: options.body ? Object.keys(options.body) : [],
  });
  return { status: response.status, body };
}

const workflow = (label: string, path: string, body?: object, agentFacing = true) =>
  request(label, path, { token: workflowToken, body, agentFacing });
const ops = (label: string, path: string, body?: object) => request(label, path, { token: opsToken, body });

function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

function assertStatus(reply: Reply, expected: number, label: string): void {
  assert(reply.status === expected, `${label} returned HTTP ${reply.status}, expected ${expected}`);
}

function expectOk(reply: Reply, label: string): Json {
  if (reply.status >= 400) {
    const reason = reply.body.reason ?? reply.body.error ?? 'request_failed';
    throw new Error(`${label} returned HTTP ${reply.status} (${safeText(reason)})`);
  }
  return reply.body;
}

const carriers: Record<string, Json> = {
  '133655': { registry_mc_number: '133655', registry_legal_name: 'Schneider National', registry_contact_email: DEMO_EMAIL, registry_is_sandbox: false, registry_status: 'active' },
  '135797': { registry_mc_number: '135797', registry_legal_name: 'J B Hunt', registry_contact_email: DEMO_EMAIL, registry_is_sandbox: false, registry_status: 'active' },
  '138328': { registry_mc_number: '138328', registry_legal_name: 'Werner Enterprises', registry_is_sandbox: true, registry_status: 'active' },
};

async function checkCarrier(callId: string, mc: string, registry = true): Promise<Json> {
  return expectOk(await workflow('carrier check', '/v1/carrier/check', {
    call_id: callId,
    mc_number: mc,
    ...(registry ? carriers[mc] ?? {} : {}),
  }), 'carrier check');
}

async function sendCode(callId: string, mc: string): Promise<Json> {
  const sent = expectOk(await workflow('verification send', '/v1/verification/send', {
    call_id: callId,
    ...(mc === '138328' ? { caller_email: REVIEWER_EMAIL } : {}),
  }), 'verification send');
  if (sent.sent === false && sent.reason === 'carrier_rate_limited') throw new Blocked(`MC ${mc} reached the five-code hourly limit`);
  assert(sent.sent === true, `code send refused (${safeText(sent.reason)})`);
  return sent;
}

async function deliverCode(callId: string): Promise<string> {
  const delivered = expectOk(await workflow('verification deliver', '/v1/verification/deliver', { call_id: callId }, false), 'verification deliver');
  assert(delivered.ok === true && typeof delivered.code === 'string' && /^\d{6}$/.test(delivered.code), 'hidden code delivery failed');
  return delivered.code;
}

async function verify(callId: string, mc: string): Promise<void> {
  const checked = await checkCarrier(callId, mc);
  assert(checked.result === 'eligible' && checked.verification?.possible === true, `MC ${mc} was not eligible for verification`);
  await sendCode(callId, mc);
  const code = await deliverCode(callId);
  const result = expectOk(await workflow('verification check', '/v1/verification/check', { call_id: callId, code }), 'verification check');
  assert(result.verified === true, `code verification failed (${safeText(result.reason)})`);
}

async function endCall(callId: string, summary: string, reason?: EndReason): Promise<void> {
  assert(summary.startsWith('QA:'), 'Call summary must start with QA:');
  const ended = await workflow('end call', '/v1/calls/end', { call_id: callId, ...(reason ? { reason } : {}), summary });
  expectOk(ended, 'end call');
}

async function safeEnd(callId: string, summary: string, reason: EndReason = 'error'): Promise<void> {
  await endCall(callId, summary, reason).catch(() => undefined);
}

function askAbove(standing: number): number {
  const ask = standing + Math.max(1_000, standing * 2);
  assert(Number.isSafeInteger(ask) && ask <= 100_000, `cannot derive a safe ask above ${standing}`);
  return ask;
}

async function findLoad(callId: string, equipment: string): Promise<Json> {
  const found = expectOk(await workflow('load search', '/v1/loads/search', { call_id: callId, equipment, limit: 3 }), 'load search');
  assert(found.count > 0 && found.loads?.[0], `no ${equipment} load was available`);
  return found.loads[0];
}

async function pitch(callId: string, equipment: string): Promise<{ load: Json; started: Json }> {
  const load = await findLoad(callId, equipment);
  const started = expectOk(await workflow('negotiation start', '/v1/negotiation/start', { call_id: callId, load_id: load.load_id }), 'negotiation start');
  assert(started.ok === true && Number.isInteger(started.pitch_rate_usd), 'negotiation did not start');
  return { load, started };
}

async function recordedOutcome(callId: string): Promise<string | null> {
  const reply = await ops('ops call lookup', `/v1/ops/calls/${callId}`);
  if (reply.status === 404 || reply.status === 503) return null;
  expectOk(reply, 'ops call lookup');
  return reply.body.call?.outcome ?? null;
}

async function waitForOutcome(callId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await recordedOutcome(callId) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Twin outcome was not ${expected}`);
}

function collectMoney(value: unknown, key = ''): number[] {
  if (typeof value === 'number') return /(?:rate|price|offer)_usd$/i.test(key) ? [value] : [];
  if (typeof value === 'string') return [...value.matchAll(/\$\s*([0-9][0-9,]*)/g)].map((match) => Number(match[1]!.replaceAll(',', '')));
  if (Array.isArray(value)) return value.flatMap((item) => collectMoney(item, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([childKey, item]) => collectMoney(item, childKey));
  return [];
}

function ceilingScanBody(response: AgentResponse): Json {
  if (response.status < 400 || response.status >= 500 || !Array.isArray(response.body.issues)) return response.body;
  const issues = response.body.issues.filter((issue: unknown) => {
    const text = JSON.stringify(issue);
    return !response.requestFields.some((field) => new RegExp(`(^|[^A-Za-z0-9_])${field}([^A-Za-z0-9_]|$)`).test(text));
  });
  return { ...response.body, issues };
}

const rows: Row[] = [];
async function runCase(id: string, scenario: string, requirement: string, work: () => Promise<string>): Promise<void> {
  try {
    rows.push({ id, scenario, requirement, result: 'PASS', detail: safeText(await work()) });
  } catch (error) {
    if (error instanceof SafetyStop) throw error;
    rows.push({ id, scenario, requirement, result: error instanceof Blocked ? 'BLOCKED' : 'FAIL', detail: safeText(error instanceof Error ? error.message : error) });
  }
}

async function withCall(work: (callId: string) => Promise<string>, failureSummary: string): Promise<string> {
  const callId = randomUUID();
  try {
    return await work(callId);
  } catch (error) {
    await safeEnd(callId, `QA: ${failureSummary}`);
    throw error;
  }
}

await runCase('STD-S1', 'S1 no deal after three rounds', 'S1; D-029; D-031 ceiling disclosure 0 and correct no-deal outcome', () =>
  withCall(async (callId) => {
    const firstResponse = agentResponses.length;
    await verify(callId, '133655');
    const { started } = await pitch(callId, 'flatbed');
    const negotiationResponses = [started];
    let standing = started.pitch_rate_usd as number;
    const offers: number[] = [];
    for (const expected of ['counter', 'counter', 'final_offer'] as const) {
      const body = expectOk(await workflow('negotiation offer', '/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: askAbove(standing) }), 'negotiation offer');
      assert(body.decision !== 'accept', 'holdout was unexpectedly accepted');
      assert(body.decision === expected && Number.isInteger(body.price_usd), `expected ${expected}, received ${safeText(body.decision)}`);
      negotiationResponses.push(body);
      standing = body.price_usd;
      offers.push(standing);
    }
    const refused = expectOk(await workflow('negotiation offer', '/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: askAbove(standing) }), 'negotiation offer');
    assert(refused.decision !== 'accept', 'final holdout was unexpectedly accepted');
    assert(refused.decision === 'no_deal', `expected no_deal, received ${safeText(refused.decision)}`);
    negotiationResponses.push(refused);
    assert(offers.every((offer, index) => index === 0 || offers[index - 1]! <= offer), 'counter sequence decreased');
    const visible = agentResponses.slice(firstResponse).map(ceilingScanBody);
    const text = JSON.stringify(visible);
    assert(!/ceiling|max_buy|maxBuy/i.test(text), 'S1 response disclosed a maximum or ceiling field');
    assert(negotiationResponses.flatMap((body) => collectMoney(body)).every((amount) => amount <= standing), 'S1 negotiation response contained a monetary amount above the final offer');
    await endCall(callId, 'QA: S1 held above each standing counter and declined the final offer.');
    await waitForOutcome(callId, 'no_deal');
    return 'Three nondecreasing counters ended in no_deal without a ceiling disclosure.';
  }, 'S1 stopped after an unexpected staging response.'));

await runCase('STD-S2', 'S2 deal, reserve, transfer, end, release', 'S2; D-029; reservation is held and transferred without TMS confirmation', () =>
  withCall(async (callId) => {
    await verify(callId, '135797');
    const { load, started } = await pitch(callId, 'dry van');
    const counter = expectOk(await workflow('negotiation offer', '/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: askAbove(started.pitch_rate_usd) }), 'negotiation offer');
    assert(counter.decision === 'counter' && Number.isInteger(counter.price_usd), 'service did not return the first counter');
    const agreed = expectOk(await workflow('negotiation offer', '/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: counter.price_usd }), 'negotiation offer');
    assert(agreed.decision === 'accept' && agreed.price_usd === counter.price_usd, 'standing counter was not accepted exactly');
    const reserved = expectOk(await workflow('reservation', '/v1/reservations', { call_id: callId }), 'reservation');
    assert(reserved.status === 'reserved', `reservation returned ${safeText(reserved.status ?? reserved.reason)}`);
    const transferred = expectOk(await workflow('transfer', '/v1/calls/transfer', { call_id: callId }), 'transfer');
    assert(transferred.transferred === true && transferred.mocked === true, 'reserved call was not transferred');
    await endCall(callId, 'QA: S2 accepted our standing counter, reserved the load, and transferred to a representative.');
    await waitForOutcome(callId, 'reserved');
    const released = expectOk(await ops('reservation release', '/v1/reservations/release', { load_id: load.load_id, reason: 'QA suite cleanup', initials: 'QA' }), 'reservation release');
    assert(released.status === 'released', `cleanup release returned ${safeText(released.reason)}`);
    return 'Outcome was reserved; the hold was transferred and then released with the ops token.';
  }, 'S2 stopped after an unexpected staging response.'));

await runCase('STD-WALK', 'Walk away after pitch', 'Standard walk-away; a pitched call ends as no_deal', () =>
  withCall(async (callId) => {
    await verify(callId, '138328');
    await pitch(callId, 'reefer');
    await endCall(callId, 'QA: Caller walked away immediately after the pitch.', 'caller_ended');
    await waitForOutcome(callId, 'no_deal');
    return 'Pitched call ended with no_deal and no reservation or transfer.';
  }, 'Walk-away case stopped after an unexpected staging response.'));

await runCase('EDGE-MC1', 'MC 1 not eligible', 'S3; inactive authority is rejected before verification', () =>
  withCall(async (callId) => {
    const checked = await checkCarrier(callId, '1', false);
    assert(checked.result === 'not_eligible', `received ${safeText(checked.result)}`);
    await endCall(callId, 'QA: MC 1 was rejected as not eligible.');
    await waitForOutcome(callId, 'not_eligible');
    return 'Carrier check returned not_eligible and no code was sent.';
  }, 'MC 1 eligibility case stopped after an unexpected staging response.'));

await runCase('EDGE-MC99999999', 'MC 99999999 not found', 'S4; unknown MC is handled without verification', () =>
  withCall(async (callId) => {
    const checked = await checkCarrier(callId, '99999999', false);
    assert(checked.result === 'not_found', `received ${safeText(checked.result)}`);
    await endCall(callId, 'QA: MC 99999999 was not found in FMCSA records.', 'caller_ended');
    return 'Carrier check returned not_found and no code was sent.';
  }, 'Unknown-MC case stopped after an unexpected staging response.'));

await runCase('EDGE-NOMATCH', 'No matching loads', 'S9; an empty board search ends with no_match', () =>
  withCall(async (callId) => {
    await verify(callId, '133655');
    const found = expectOk(await workflow('load search', '/v1/loads/search', { call_id: callId, equipment: 'power only', origin_state: 'HI' }), 'load search');
    assert(found.count === 0, `search returned ${safeText(found.count)} loads`);
    await endCall(callId, 'QA: No power-only load matched a Hawaii origin.', 'no_match');
    await waitForOutcome(callId, 'no_match');
    return 'Empty search returned count 0 and the recorded outcome was no_match.';
  }, 'No-match case stopped after an unexpected staging response.'));

await runCase('EDGE-LOCK', 'Three wrong codes lock verification', 'S6; three wrong codes lock the call and load search remains gated', () =>
  withCall(async (callId) => {
    const checked = await checkCarrier(callId, '135797');
    assert(checked.result === 'eligible', 'carrier was not eligible');
    await sendCode(callId, '135797');
    const code = await deliverCode(callId);
    const wrong = ['000000', '111111', '222222', '333333'].filter((candidate) => candidate !== code).slice(0, 3);
    let last: Json = {};
    for (const candidate of wrong) last = expectOk(await workflow('verification check', '/v1/verification/check', { call_id: callId, code: candidate }), 'verification check');
    assert(last.reason === 'locked' && last.attempts_left === 0, 'third wrong code did not lock verification');
    const search = await workflow('load search', '/v1/loads/search', { call_id: callId, equipment: 'reefer' });
    assertStatus(search, 403, 'search after lock');
    assert(search.body.error === 'not_verified', 'locked search did not return not_verified');
    await endCall(callId, 'QA: Verification locked after three incorrect codes; load search stayed blocked.', 'not_verified');
    await waitForOutcome(callId, 'not_verified');
    return 'Third wrong code locked the call; search returned 403 not_verified.';
  }, 'Lockout case stopped after an unexpected staging response.'));

await runCase('EDGE-GARBAGE', 'Garbage code does not consume an attempt', 'Verification edge; unclear input preserves all three attempts', () =>
  withCall(async (callId) => {
    const checked = await checkCarrier(callId, '138328');
    assert(checked.result === 'eligible', 'carrier was not eligible');
    await sendCode(callId, '138328');
    const code = await deliverCode(callId);
    const unclear = expectOk(await workflow('verification check', '/v1/verification/check', { call_id: callId, code: 'abc' }), 'verification check');
    assert(unclear.reason === 'unclear' && unclear.attempts_left === 3, 'garbage input consumed an attempt');
    const wrongCode = code === '000000' ? '111111' : '000000';
    const wrong = expectOk(await workflow('verification check', '/v1/verification/check', { call_id: callId, code: wrongCode }), 'verification check');
    assert(wrong.reason === 'wrong_code' && wrong.attempts_left === 2, 'first valid-format wrong code did not leave two attempts');
    await endCall(callId, 'QA: Garbage code input was rejected without consuming a verification attempt.', 'not_verified');
    return 'Input abc returned unclear with three attempts left.';
  }, 'Garbage-code case stopped after an unexpected staging response.'));

await runCase('EDGE-PREVERIFY', 'Search before verification', 'S5; service-side verification gate refuses load search', () =>
  withCall(async (callId) => {
    const checked = await checkCarrier(callId, '133655');
    assert(checked.result === 'eligible', 'carrier was not eligible');
    const search = await workflow('load search', '/v1/loads/search', { call_id: callId, equipment: 'reefer' });
    assertStatus(search, 403, 'unverified search');
    assert(search.body.error === 'not_verified', 'unverified search returned the wrong reason');
    await endCall(callId, 'QA: Load search before code verification was refused.', 'not_verified');
    return 'Search returned HTTP 403 not_verified before any code was sent.';
  }, 'Pre-verification search case stopped after an unexpected staging response.'));

await runCase('REG-IDENTITY', 'Verified carrier identity cannot be reused', 'Audit 4.1; changing MC clears identity state and requires a new code', () =>
  withCall(async (callId) => {
    await verify(callId, '133655');
    const changed = await checkCarrier(callId, '135797');
    assert(changed.result === 'eligible', 'replacement carrier was not eligible');

    const search = await workflow('load search after MC change', '/v1/loads/search', { call_id: callId, equipment: 'reefer' });
    assertStatus(search, 403, 'search after MC change');
    assert(search.body.error === 'not_verified', 'search after MC change did not require verification');

    const start = expectOk(await workflow('negotiation start after MC change', '/v1/negotiation/start', { call_id: callId, load_id: 'LD01075' }), 'negotiation start after MC change');
    assert(start.ok === false && start.reason === 'not_verified', 'negotiation start reused the previous carrier verification');
    const offer = expectOk(await workflow('negotiation offer after MC change', '/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: 1 }), 'negotiation offer after MC change');
    assert(offer.ok === false && offer.reason === 'not_verified', 'negotiation offer reused the previous carrier verification');
    const reserve = expectOk(await workflow('reservation after MC change', '/v1/reservations', { call_id: callId }), 'reservation after MC change');
    assert(reserve.ok === false && reserve.reason === 'not_verified', 'reservation reused the previous carrier verification');

    await sendCode(callId, '135797');
    const replacementCode = await deliverCode(callId);
    const replacementCheck = expectOk(await workflow('replacement verification check', '/v1/verification/check', { call_id: callId, code: replacementCode }), 'replacement verification check');
    assert(replacementCheck.verified === true, 'replacement carrier could not complete its own verification');
    await endCall(callId, 'QA: Carrier identity changed and the replacement carrier completed a new code check.', 'caller_ended');
    return 'MC change blocked search, negotiation, and reservation until the replacement carrier completed its own code check.';
  }, 'Identity-binding case stopped after an unexpected staging response.'));

await runCase('REG-ROUNDS', 'Counter limit is call-wide', 'Audit 4.4; restarting negotiation cannot reset the three-counter limit', () =>
  withCall(async (callId) => {
    await verify(callId, '138328');
    const { started } = await pitch(callId, 'reefer');
    let standing = started.pitch_rate_usd as number;
    for (const expected of ['counter', 'counter', 'final_offer'] as const) {
      const response = expectOk(await workflow('call-wide negotiation offer', '/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: askAbove(standing) }), 'call-wide negotiation offer');
      assert(response.decision === expected && Number.isInteger(response.price_usd), `expected ${expected}, received ${safeText(response.decision)}`);
      standing = response.price_usd;
    }
    const replacement = await findLoad(callId, 'flatbed');
    const restarted = expectOk(await workflow('negotiation restart after three counters', '/v1/negotiation/start', { call_id: callId, load_id: replacement.load_id }), 'negotiation restart after three counters');
    assert(restarted.ok === false && restarted.reason === 'closed', `negotiation restart returned ${safeText(restarted.reason)}`);
    const reserve = expectOk(await workflow('reservation after counter limit', '/v1/reservations', { call_id: callId }), 'reservation after counter limit');
    assert(reserve.ok === false && reserve.reason === 'no_agreed_price', 'counter-limit case created an agreement or hold');
    await endCall(callId, 'QA: Three call-wide counters were exhausted and negotiation restart was refused.', 'caller_ended');
    return 'After three counters, a new negotiation start returned closed and no reservation was created.';
  }, 'Call-wide counter case stopped after an unexpected staging response.'));

await runCase('REG-CEILING', 'Inconsistent ceiling is not pitchable', 'Audit 4.5; MAX_BUY below posted rate is refused and logged', () =>
  withCall(async (callId) => {
    if (!INCONSISTENT_LOAD_ID) throw new Blocked('QA_INCONSISTENT_LOAD_ID is not configured; no staging TMS record was changed');
    assert(/^LD\d{1,10}$/.test(INCONSISTENT_LOAD_ID), 'QA_INCONSISTENT_LOAD_ID has an invalid format');
    await verify(callId, '133655');
    const started = expectOk(await workflow('inconsistent ceiling negotiation start', '/v1/negotiation/start', { call_id: callId, load_id: INCONSISTENT_LOAD_ID }), 'inconsistent ceiling negotiation start');
    assert(started.ok === false && started.reason === 'not_available', `inconsistent load returned ${safeText(started.reason)}`);
    const reserve = expectOk(await workflow('reservation after inconsistent ceiling', '/v1/reservations', { call_id: callId }), 'reservation after inconsistent ceiling');
    assert(reserve.ok === false && reserve.reason === 'no_agreed_price', 'inconsistent load created an agreement or hold');
    await endCall(callId, 'QA: Inconsistent-ceiling load was refused before pitch.', 'caller_ended');
    return 'The inconsistent-ceiling fixture returned not_available and could not be reserved.';
  }, 'Inconsistent-ceiling case stopped after an unexpected staging response.'));

await runCase('EDGE-RESERVE', 'Reserve before agreement', 'Reservation guard; no hold exists until negotiation records agreement', () =>
  withCall(async (callId) => {
    await verify(callId, '133655');
    await pitch(callId, 'step deck');
    const reserved = expectOk(await workflow('reservation', '/v1/reservations', { call_id: callId }), 'reservation');
    assert(reserved.ok === false && reserved.reason === 'no_agreed_price', `reserve returned ${safeText(reserved.reason)}`);
    await endCall(callId, 'QA: Reservation before price agreement was refused.', 'caller_ended');
    return 'Reservation returned no_agreed_price before any offer was accepted.';
  }, 'Reserve-before-agreement case stopped after an unexpected staging response.'));

await runCase('EDGE-TRANSFER', 'Transfer before reserve', 'Transfer guard; only a live reservation may transfer', () =>
  withCall(async (callId) => {
    await verify(callId, '135797');
    const transferred = expectOk(await workflow('transfer', '/v1/calls/transfer', { call_id: callId }), 'transfer');
    assert(transferred.ok === false && transferred.reason === 'not_reserved', `transfer returned ${safeText(transferred.reason)}`);
    await endCall(callId, 'QA: Transfer before reservation was refused.', 'caller_ended');
    return 'Transfer returned not_reserved.';
  }, 'Transfer-before-reserve case stopped after an unexpected staging response.'));

await runCase('EDGE-END2', 'Second end_call is idempotent', 'Call finalization; a repeated end cannot change the outcome', () =>
  withCall(async (callId) => {
    await endCall(callId, 'QA: First end recorded no_match.', 'no_match');
    await waitForOutcome(callId, 'no_match');
    await endCall(callId, 'QA: Second end attempted a different reason.', 'caller_ended');
    await waitForOutcome(callId, 'no_match');
    return 'Second end_call returned OK and the outcome remained no_match.';
  }, 'Repeated-end case stopped after an unexpected staging response.'));

await runCase('SEC-UNKNOWN', 'Unknown price and ceiling fields', 'Strict schemas reject agent-supplied agreement and ceiling values', () =>
  withCall(async (callId) => {
    const reservation = await workflow('reservation unknown field', '/v1/reservations', { call_id: callId, agreed_rate_usd: 1 });
    assertStatus(reservation, 400, 'reservation unknown field');
    const start = await workflow('start unknown field', '/v1/negotiation/start', { call_id: callId, load_id: 'LD01075', ceiling_usd: 1 });
    assertStatus(start, 400, 'start unknown field');
    await endCall(callId, 'QA: Unknown pricing fields were rejected by strict request schemas.', 'caller_ended');
    return 'Both unknown-field requests returned HTTP 400 invalid_request.';
  }, 'Unknown-field case stopped after an unexpected staging response.'));

await runCase('SEC-SCOPES', 'Token scopes and missing token', 'D-029 security layer; workflow, ops, and absent credentials are isolated', async () => {
  const workflowOps = await request('workflow token on ops KPIs', '/v1/ops/kpis?days=1', { token: workflowToken, agentFacing: true });
  assertStatus(workflowOps, 403, 'workflow token on ops KPIs');
  const opsSearch = await request('ops token on load search', '/v1/loads/search', { token: opsToken, method: 'POST', body: { call_id: randomUUID(), equipment: 'reefer' } });
  assertStatus(opsSearch, 403, 'ops token on load search');
  const noToken = await request('missing token', '/v1/loads/search', { method: 'POST', body: { call_id: randomUUID(), equipment: 'reefer' }, agentFacing: true });
  assertStatus(noToken, 401, 'missing token');
  return 'Wrong scopes returned 403; missing credentials returned 401; no confirmation request was sent.';
});

await runCase('SEC-DELIVER2', 'Deliver endpoint called twice', 'D-024 hidden delivery is one-time and returns no second code', () =>
  withCall(async (callId) => {
    const checked = await checkCarrier(callId, '138328');
    assert(checked.result === 'eligible', 'carrier was not eligible');
    await sendCode(callId, '138328');
    await deliverCode(callId);
    const second = expectOk(await workflow('verification deliver', '/v1/verification/deliver', { call_id: callId }, false), 'second verification deliver');
    assert(second.ok === false && second.reason === 'nothing_to_deliver', `second delivery returned ${safeText(second.reason)}`);
    await endCall(callId, 'QA: Second hidden delivery request returned nothing_to_deliver.', 'not_verified');
    return 'Second delivery returned nothing_to_deliver and exposed no code.';
  }, 'Double-delivery case stopped after an unexpected staging response.'));

await runCase('SEC-CEILING', 'Whole-run agent response scan', 'S7; D-031 ceiling disclosed 0 across every agent-facing response', async () => {
  const text = JSON.stringify(agentResponses.map(ceilingScanBody));
  assert(!/ceiling|max_buy|maxBuy/i.test(text), 'an agent-facing response contained a forbidden ceiling key or word');
  for (const ceiling of KNOWN_CEILINGS) {
    assert(!new RegExp(`(^|[^0-9])${ceiling}([^0-9]|$)`).test(text), `an agent-facing response contained known load ceiling ${ceiling}`);
  }
  return `Scanned ${agentResponses.length} agent-facing responses; no forbidden key or documented ceiling value appeared.`;
});

const totals = rows.reduce((summary, row) => ({ ...summary, [row.result]: summary[row.result] + 1 }), { PASS: 0, FAIL: 0, BLOCKED: 0 });
const date = new Date().toISOString();
const markdown = [
  '# Staging API Suite Results',
  '',
  `- Date: ${date}`,
  `- Base URL: ${BASE_URL}`,
  `- Totals: ${rows.length} cases; ${totals.PASS} PASS; ${totals.FAIL} FAIL; ${totals.BLOCKED} BLOCKED`,
  '',
  '| id | scenario | requirement | result | detail |',
  '|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.id} | ${row.scenario} | ${row.requirement} | ${row.result} | ${row.detail} |`),
  '',
].join('\n');
await writeFile(RESULTS_MD, markdown, 'utf8');
await writeFile(RESULTS_JSON, `${JSON.stringify({ date, base_url: BASE_URL, totals: { cases: rows.length, ...totals }, cases: rows }, null, 2)}\n`, 'utf8');

console.log('id | scenario | requirement | result | detail');
for (const row of rows) console.log(`${row.id} | ${row.scenario} | ${row.requirement} | ${row.result} | ${row.detail}`);
console.log(`TOTAL | ${rows.length} cases | ${totals.PASS} PASS | ${totals.FAIL} FAIL | ${totals.BLOCKED} BLOCKED`);
if (totals.FAIL > 0) process.exitCode = 1;
