import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://carrier-sales-staging-891703837363.us-central1.run.app';
const ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url));
const FORBIDDEN_PATH = '/v1/reservations/confirm';
const REVIEWER_EMAIL = 'seed-reviewer@example.com';
const DEMO_EMAIL = 'demo@example.com';

type Json = Record<string, any>;
type EndReason = 'no_match' | 'caller_ended' | 'not_verified' | 'tms_unavailable' | 'error';
type Row = {
  callId: string;
  scenario: string;
  mc: string;
  outcome: string;
  load: string;
  price: string;
  notes: string;
};

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

const env = parseEnv(await readFile(ENV_PATH, 'utf8'));
function required(name: string): string {
  const value = env.get(name);
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function inspectForBooking(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) inspectForBooking(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '');
    if (normalized === 'bookingref' && item) {
      throw new SafetyStop('A response contained a booking reference; stopped immediately.');
    }
    if (key.toLowerCase() === 'status' && item === 'booked') {
      throw new SafetyStop('A response contained status booked; stopped immediately.');
    }
    inspectForBooking(item);
  }
}

async function decode(response: Response, label: string): Promise<Json> {
  let value: Json;
  try {
    value = await response.json() as Json;
  } catch {
    throw new Error(`${label} returned a non-JSON response (HTTP ${response.status})`);
  }
  inspectForBooking(value);
  if (!response.ok) {
    const reason = typeof value.error === 'string' ? value.error : typeof value.reason === 'string' ? value.reason : 'request_failed';
    throw new Error(`${label} failed (HTTP ${response.status}, ${reason})`);
  }
  return value;
}

async function token(clientId: string, clientSecret: string, expectedScope: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const value = await decode(response, 'OAuth token request');
  if (value.scope !== expectedScope || typeof value.access_token !== 'string') {
    throw new Error(`OAuth token request returned the wrong scope for ${expectedScope}`);
  }
  return value.access_token;
}

const workflowToken = await token(required('OAUTH_CLIENT_ID'), required('OAUTH_CLIENT_SECRET'), 'carrier-calls');
const opsToken = await token(required('OPS_CLIENT_ID'), required('OPS_CLIENT_SECRET'), 'ops');

async function request(path: string, authToken: string, body?: object): Promise<Json> {
  if (path === FORBIDDEN_PATH || path.startsWith(`${FORBIDDEN_PATH}?`)) {
    throw new SafetyStop('The forbidden reservation confirmation path was requested; stopped before sending it.');
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return decode(response, path);
}

const post = (path: string, body: object) => request(path, workflowToken, body);
const opsPost = (path: string, body: object) => request(path, opsToken, body);
const opsGet = (path: string) => request(path, opsToken);
const pause = () => new Promise((resolve) => setTimeout(resolve, 1_000));

const carriers: Record<string, Json> = {
  '133655': {
    registry_mc_number: '133655',
    registry_legal_name: 'Schneider National',
    registry_contact_email: DEMO_EMAIL,
    registry_is_sandbox: false,
    registry_status: 'active',
  },
  '135797': {
    registry_mc_number: '135797',
    registry_legal_name: 'J B Hunt',
    registry_contact_email: DEMO_EMAIL,
    registry_is_sandbox: false,
    registry_status: 'active',
  },
  '138328': {
    registry_mc_number: '138328',
    registry_legal_name: 'Werner Enterprises',
    registry_is_sandbox: true,
    registry_status: 'active',
  },
};

async function checkCarrier(callId: string, mc: string, registry = true): Promise<Json> {
  const result = await post('/v1/carrier/check', {
    call_id: callId,
    mc_number: mc,
    ...(registry ? carriers[mc] ?? {} : {}),
  });
  return result;
}

async function verify(callId: string, mc: string): Promise<void> {
  const checked = await checkCarrier(callId, mc);
  if (checked.result !== 'eligible' || checked.verification?.possible !== true) {
    throw new Error(`Carrier ${mc} was not eligible for verification`);
  }
  const sent = await post('/v1/verification/send', {
    call_id: callId,
    ...(mc === '138328' ? { caller_email: REVIEWER_EMAIL } : {}),
  });
  if (sent.sent !== true) throw new Error(`Code send for carrier ${mc} was refused (${sent.reason ?? 'unknown'})`);
  const delivered = await post('/v1/verification/deliver', { call_id: callId });
  if (delivered.ok !== true || typeof delivered.code !== 'string' || !/^\d{6}$/.test(delivered.code)) {
    throw new Error(`Hidden code delivery for carrier ${mc} failed`);
  }
  const checkedCode = await post('/v1/verification/check', { call_id: callId, code: delivered.code });
  delivered.code = '<code>';
  if (checkedCode.verified !== true) throw new Error(`Code check for carrier ${mc} failed`);
}

async function end(callId: string, summary: string, reason?: EndReason): Promise<void> {
  if (!summary.startsWith('SEED:')) throw new Error('Seed call summaries must start with SEED:');
  await post('/v1/calls/end', { call_id: callId, ...(reason ? { reason } : {}), summary });
}

function askAbove(standing: number): number {
  const ask = standing + Math.max(1_000, standing * 2);
  if (!Number.isSafeInteger(ask) || ask > 100_000) {
    throw new Error(`Cannot derive a safe offer above the standing counter of ${standing}`);
  }
  return ask;
}

async function findLoad(callId: string, preferred: string[]): Promise<Json> {
  for (const equipment of preferred) {
    const found = await post('/v1/loads/search', { call_id: callId, equipment, limit: 3 });
    if (found.count > 0 && found.loads?.[0]) return found.loads[0];
  }
  throw new Error(`No open load found for ${preferred.join(', ')}`);
}

async function pitch(callId: string, equipment: string): Promise<{ load: Json; started: Json }> {
  const fallback = ['dry van', 'reefer', 'flatbed', 'step deck'].filter((item) => item !== equipment);
  const load = await findLoad(callId, [equipment, ...fallback]);
  const started = await post('/v1/negotiation/start', { call_id: callId, load_id: load.load_id });
  if (started.ok !== true || !Number.isInteger(started.pitch_rate_usd)) throw new Error('Negotiation did not start');
  return { load, started };
}

async function counter(callId: string, standing: number, expected: 'counter' | 'final_offer'): Promise<Json> {
  const result = await post('/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: askAbove(standing) });
  if (result.decision === 'accept') throw new SafetyStop('An offer was unexpectedly accepted; stopped immediately.');
  if (result.decision !== expected || !Number.isInteger(result.price_usd)) {
    throw new Error(`Expected ${expected}, received ${result.decision ?? 'no decision'}`);
  }
  return result;
}

const rows: Row[] = [];
async function runCall(
  scenario: string,
  mc: string,
  work: (callId: string) => Promise<Omit<Row, 'callId' | 'scenario' | 'mc'>>,
): Promise<void> {
  const callId = randomUUID();
  try {
    rows.push({ callId, scenario, mc, ...await work(callId) });
  } catch (error) {
    if (!(error instanceof SafetyStop)) {
      await end(callId, `SEED: ${scenario} stopped because a staging request failed.`, 'error').catch(() => undefined);
    }
    throw error;
  }
  await pause();
}

async function deal(callId: string, mc: string, equipment: string, rounds: number, keep: boolean, releaseReason: string) {
  await verify(callId, mc);
  const { load, started } = await pitch(callId, equipment);
  let standing = started.pitch_rate_usd as number;
  for (let round = 0; round < rounds; round += 1) {
    const response = await counter(callId, standing, 'counter');
    standing = response.price_usd;
  }
  const accepted = await post('/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: standing });
  if (accepted.decision !== 'accept' || accepted.price_usd !== standing) {
    throw new Error('The standing counter was not accepted at its exact value');
  }
  const reserved = await post('/v1/reservations', { call_id: callId });
  if (reserved.status !== 'reserved') throw new Error(`Reservation failed (${reserved.reason ?? 'unknown'})`);
  const transferred = await post('/v1/calls/transfer', { call_id: callId });
  if (transferred.transferred !== true) throw new Error('Transfer failed');
  await end(callId, `SEED: Deal reached after ${rounds} counter round${rounds === 1 ? '' : 's'}; the load was held and transferred.`);
  let outcome = 'reserved';
  if (!keep) {
    const released = await opsPost('/v1/reservations/release', { load_id: load.load_id, reason: releaseReason, initials: 'SEED' });
    if (released.status !== 'released') throw new Error(`Release failed (${released.reason ?? 'unknown'})`);
    outcome = released.status;
  }
  return {
    outcome,
    load: String(load.load_id),
    price: `$${standing}`,
    notes: keep ? `${rounds} counter; hold active` : `${rounds} counter; ${releaseReason}`,
  };
}

async function noDeal(callId: string, mc: string, equipment: string, label: string) {
  await verify(callId, mc);
  const { load, started } = await pitch(callId, equipment);
  let standing = started.pitch_rate_usd as number;
  for (const expected of ['counter', 'counter', 'final_offer'] as const) {
    const response = await counter(callId, standing, expected);
    standing = response.price_usd;
  }
  const refused = await post('/v1/negotiation/offer', { call_id: callId, carrier_offer_usd: askAbove(standing) });
  if (refused.decision === 'accept') throw new SafetyStop('A final hold-out offer was unexpectedly accepted; stopped immediately.');
  if (refused.decision !== 'no_deal') throw new Error(`Expected no_deal, received ${refused.decision ?? 'no decision'}`);
  await end(callId, `SEED: ${label} held above every standing counter and declined the final offer.`);
  return { outcome: refused.decision, load: String(load.load_id), price: `$${standing}`, notes: '3 rounds; held out' };
}

try {
  await runCall('1 deal', '133655', (id) => deal(id, '133655', 'dry van', 1, false, 'carrier backed out'));
  await runCall('2 deal', '133655', (id) => deal(id, '133655', 'reefer', 2, false, 'duplicate hold'));
  await runCall('3 deal', '135797', (id) => deal(id, '135797', 'flatbed', 1, true, ''));

  await runCall('4 no deal', '135797', (id) => noDeal(id, '135797', 'step deck', 'Carrier'));
  await runCall('5 no deal', '138328', (id) => noDeal(id, '138328', 'dry van', 'Sandbox carrier'));

  await runCall('6 walk-away', '135797', async (callId) => {
    await verify(callId, '135797');
    const { load, started } = await pitch(callId, 'reefer');
    await end(callId, 'SEED: Caller ended the conversation immediately after hearing the initial load pitch.', 'caller_ended');
    return { outcome: 'no_deal', load: String(load.load_id), price: `$${started.pitch_rate_usd}`, notes: 'walked after pitch' };
  });

  await runCall('7 no match', '138328', async (callId) => {
    await verify(callId, '138328');
    const found = await post('/v1/loads/search', { call_id: callId, equipment: 'power only', origin_state: 'HI' });
    if (found.count !== 0) throw new Error(`Expected no match, received ${found.count} load(s)`);
    await end(callId, 'SEED: No power-only loads were available for a Hawaii origin search.', 'no_match');
    return { outcome: 'no_match', load: '-', price: '-', notes: 'power only from HI' };
  });

  await runCall('8 not eligible', '1', async (callId) => {
    const checked = await checkCarrier(callId, '1', false);
    if (checked.result !== 'not_eligible') throw new Error(`Expected not_eligible, received ${checked.result}`);
    await end(callId, 'SEED: MC 1 was rejected because it did not meet the active-authority rule.');
    return { outcome: checked.result, load: '-', price: '-', notes: String(checked.reason ?? 'inactive') };
  });

  await runCall('9 not found', '99999999', async (callId) => {
    const checked = await checkCarrier(callId, '99999999', false);
    if (checked.result !== 'not_found') throw new Error(`Expected not_found, received ${checked.result}`);
    await end(callId, 'SEED: The supplied MC number was not found in FMCSA records.', 'caller_ended');
    return { outcome: 'caller_ended', load: '-', price: '-', notes: checked.result };
  });

  await runCall('10 lockout', '133655', async (callId) => {
    const checked = await checkCarrier(callId, '133655');
    if (checked.result !== 'eligible' || checked.verification?.possible !== true) throw new Error('Lockout carrier was not eligible');
    const sent = await post('/v1/verification/send', { call_id: callId });
    if (sent.sent !== true) throw new Error(`Lockout code send was refused (${sent.reason ?? 'unknown'})`);
    const delivered = await post('/v1/verification/deliver', { call_id: callId });
    if (delivered.ok !== true || typeof delivered.code !== 'string') throw new Error('Lockout code delivery failed');
    const wrong = ['000000', '111111', '222222'].filter((candidate) => candidate !== delivered.code);
    while (wrong.length < 3) wrong.push('333333');
    delivered.code = '<code>';
    let last: Json = {};
    for (const candidate of wrong.slice(0, 3)) {
      last = await post('/v1/verification/check', { call_id: callId, code: candidate });
    }
    if (last.reason !== 'locked' || last.attempts_left !== 0) throw new Error('Three wrong codes did not lock verification');
    await end(callId, 'SEED: Verification was locked after three incorrect code attempts.', 'not_verified');
    return { outcome: 'not_verified', load: '-', price: '-', notes: '3 wrong codes' };
  });

  await runCall('11 reviewer', '138328', (id) => noDeal(id, '138328', 'flatbed', 'Sandbox reviewer'));

  await runCall('12 contact probe', '3 MCs', async (callId) => {
    const candidates = ['138430', '107478', '19600'];
    let last = 'none found';
    for (const mc of candidates) {
      const checked = await checkCarrier(callId, mc, false);
      last = `${mc}: ${checked.result}`;
      if (checked.result === 'eligible' && checked.verification?.possible === false && checked.verification.reason === 'no_contact_on_file') {
        await end(callId, `SEED: Optional contact probe found active MC ${mc} without a usable contact.`);
        return { outcome: 'no_contact', load: '-', price: '-', notes: `found MC ${mc}` };
      }
      if (checked.result === 'eligible' && checked.verification?.possible === true && checked.verification.channel === 'sms' && !checked.verification.other_channel_available) {
        const send = await post('/v1/verification/send', { call_id: callId });
        if (send.sent === false && send.reason === 'no_contact') {
          await end(callId, `SEED: Optional contact probe found active phone-only MC ${mc}; staging has no usable email channel.`);
          return { outcome: 'no_contact', load: '-', price: '-', notes: `phone-only MC ${mc}` };
        }
        throw new Error(`Phone-only contact probe returned ${send.reason ?? 'an unexpected send result'}`);
      }
    }
    await end(callId, 'SEED: Optional contact probe checked three active-carrier candidates and found no phone-only case.', 'caller_ended');
    return { outcome: 'caller_ended', load: '-', price: '-', notes: `optional skipped; ${last}` };
  });

  const calls = await opsGet('/v1/ops/calls?limit=50');
  const outcomes = new Map<string, string>((calls.calls ?? []).map((call: Json) => [String(call.call_id), String(call.outcome ?? 'in_progress')]));
  for (const row of rows) row.outcome = outcomes.get(row.callId) ?? row.outcome;

  const kpis = await opsGet('/v1/ops/kpis?days=1');
  const holds = await opsGet('/v1/ops/holds');
  const activeHolds = (holds.holds ?? []).filter((hold: Json) => hold.status === 'reserved' && hold.minutesLeft !== null).length;

  console.log('scenario | mc | outcome returned | load | final price | notes');
  for (const row of rows) {
    console.log(`${row.scenario} | ${row.mc} | ${row.outcome} | ${row.load} | ${row.price} | ${row.notes}`);
  }
  const funnel = kpis.funnel ?? {};
  console.log(`funnel | calls ${funnel.calls ?? 0} | eligible ${funnel.eligible ?? 0} | code_sent ${funnel.code_sent ?? 0} | verified ${funnel.verified ?? 0} | lockouts ${funnel.lockouts ?? 0}`);
  const outcomeText = Object.entries(kpis.by_outcome ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(', ');
  console.log(`outcomes | ${outcomeText} | active holds ${activeHolds}`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown staging seed failure';
  console.error(`SEED STOPPED: ${message.replace(/\b\d{6}\b/g, '<code>')}`);
  process.exitCode = 1;
}
