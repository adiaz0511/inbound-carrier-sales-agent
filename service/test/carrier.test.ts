import { describe, expect, it } from 'vitest';
import { checkCarrier, type CheckDeps } from '../src/carriers/check.js';
import { CensusClient, FmcsaClient, normalizeMc, toE164 } from '../src/carriers/fmcsa.js';
import { MemoryCallStateStore } from '../src/storage/call-state.js';
import { CallRecords, TwinWriter } from '../src/storage/twin.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { issueToken } from '../src/auth.js';
import { checkCode, deliverCode, sendCode } from '../src/verification/service.js';

// --- fakes -------------------------------------------------------------------------------------

type Carrier = { dot: number; name: string; allowed?: 'Y' | 'N'; common?: string; contract?: string };
type CensusRow = { dot: number; phone?: string; email?: string };

function fakeExternal(fm: Record<string, Carrier | 'down'>, census: Record<string, CensusRow[] | 'down'>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    if (u.hostname === 'mobile.fmcsa.dot.gov') {
      const mc = u.pathname.split('/').pop()!;
      seen.push(`fmcsa:${mc}`);
      const c = fm[mc];
      if (c === 'down') return new Response('oops', { status: 500 });
      const content = c ? [{ carrier: { dotNumber: c.dot, legalName: c.name, allowedToOperate: c.allowed ?? 'Y', commonAuthorityStatus: c.common ?? 'A', contractAuthorityStatus: c.contract ?? 'A' } }] : [];
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    const mc = u.searchParams.get('docket1')!;
    seen.push(`census:${mc}`);
    const rows = census[mc];
    if (rows === 'down') return new Response('<html>busy</html>', { status: 200 });
    return new Response(JSON.stringify((rows ?? []).map((r) => ({ dot_number: String(r.dot), legal_name: 'X', phone: r.phone, email_address: r.email }))), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function fakeTwin(fail = false) {
  const writes: { table: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    writes.push({ table: url.split('/tables/')[1]!.split('/')[0]!, method: String(init.method), body: JSON.parse(String(init.body)) });
    return fail ? new Response('down', { status: 503 }) : new Response('{}', { status: 201 });
  }) as unknown as typeof fetch;
  return { records: new CallRecords(new TwinWriter({ apiKey: 'k', environment: 'staging', fetchImpl, sleep: async () => {} }), 'staging'), writes };
}

const SCHNEIDER: Carrier = { dot: 264184, name: 'SCHNEIDER NATIONAL CARRIERS INC' };
const MC1: Carrier = { dot: 38110, name: 'PREFERRED DEVELOPMENT CORPORATION', common: 'I', contract: 'I' }; // allowed=Y, inactive (R-19)

function deps(fm: Record<string, Carrier | 'down'>, census: Record<string, CensusRow[] | 'down'> = {}, twinFail = false) {
  const ext = fakeExternal(fm, census);
  const twin = fakeTwin(twinFail);
  const logs: Record<string, unknown>[] = [];
  const opts = { fetchImpl: ext.fetchImpl, sleep: async () => {} };
  const d: CheckDeps = { fmcsa: new FmcsaClient('key', opts), census: new CensusClient(opts), state: new MemoryCallStateStore(), records: twin.records, log: (e) => logs.push(e) };
  return { d, ext, twin, logs };
}
const CALL = '00000000-0000-4000-8000-0000000000aa';

// --- tests -------------------------------------------------------------------------------------

describe('MC normalization', () => {
  it.each([['MC-133655', '133655'], ['mc 133 655', '133655'], ['133655', '133655'], ['MC#1', '1'], ['0133655', '133655']])('%s -> %s', (a, b) => expect(normalizeMc(a)).toBe(b));
  it.each(['', 'abc', '123456789', 'MC', '12a4'])('rejects %j', (a) => expect(normalizeMc(a)).toBeNull());
  it('phones become E.164 only when they are real US numbers', () => {
    expect(toE164('9205922000')).toBe('+19205922000');
    expect(toE164('(920) 592-2000')).toBe('+19205922000');
    expect(toE164('1234')).toBeUndefined();
  });
});

describe('FMCSA eligibility rule (allowed to operate AND active authority)', () => {
  it('an active carrier is eligible', async () => {
    const { d } = deps({ '133655': SCHNEIDER }, { '133655': [{ dot: 264184, phone: '9205922000' }] });
    expect((await checkCarrier({ callId: CALL, mcSpoken: 'MC 133655' }, d)).result).toBe('eligible');
  });

  it('allowed to operate but inactive authority is NOT eligible (the MC 1 trap)', async () => {
    const { d, twin } = deps({ '1': MC1 });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '1' }, d);
    expect(r).toMatchObject({ result: 'not_eligible', reason: 'inactive_authority' });
    expect(twin.writes.some((w) => w.method === 'PATCH' && (w.body.updates as Record<string, string>).outcome === 'not_eligible')).toBe(true);
  });

  it('not allowed to operate is not eligible even with active authority', async () => {
    const { d } = deps({ '5': { dot: 5, name: 'X', allowed: 'N' } });
    expect(await checkCarrier({ callId: CALL, mcSpoken: '5' }, d)).toMatchObject({ result: 'not_eligible', reason: 'not_allowed_to_operate' });
  });

  it('an unknown MC is "not found", and a broken lookup is "unavailable" (never guessed)', async () => {
    expect((await checkCarrier({ callId: CALL, mcSpoken: '999' }, deps({}).d)).result).toBe('not_found');
    expect((await checkCarrier({ callId: CALL, mcSpoken: '7' }, deps({ '7': 'down' }).d)).result).toBe('fmcsa_unavailable');
  });

  it('gibberish never reaches FMCSA', async () => {
    const { d, ext } = deps({});
    expect((await checkCarrier({ callId: CALL, mcSpoken: 'my mc is blue' }, d)).result).toBe('invalid_mc');
    expect(ext.seen).toHaveLength(0);
  });
});

describe('contact on file, in trust order', () => {
  it('broker records come first; the census is not even asked', async () => {
    const { d, ext } = deps({ '133655': SCHNEIDER }, { '133655': [{ dot: 264184, phone: '9205550000' }] });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655', registry: { mcNumber: '133655', contactPhone: '+13125550142', contactEmail: 'ops@acme.com' } }, d);
    expect(r).toMatchObject({ result: 'eligible', verification: { possible: true, channel: 'sms', destination_masked: '+1••••••••42', other_channel_available: true } });
    expect(ext.seen).not.toContain('census:133655');
    expect((await d.state.get(CALL))?.carrier).toMatchObject({ contactSource: 'broker_records', phone: '+13125550142' });
  });

  it('without broker records, the census contact is used (looked up in parallel with FMCSA)', async () => {
    const { d, ext } = deps({ '133655': SCHNEIDER }, { '133655': [{ dot: 264184, email: 'dispatch@schneider.com' }] });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655' }, d);
    expect(r).toMatchObject({ verification: { channel: 'email', destination_masked: 'd•••@schneider.com' } });
    expect(ext.seen).toEqual(expect.arrayContaining(['fmcsa:133655', 'census:133655']));
  });

  it('a census record whose DOT does not match FMCSA is not trusted -> no contact -> onboarding request', async () => {
    const { d, twin } = deps({ '133655': SCHNEIDER }, { '133655': [{ dot: 111, phone: '9205550000' }] });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655' }, d);
    expect(r).toMatchObject({ result: 'eligible', verification: { possible: false, reason: 'no_contact_on_file' } });
    expect(twin.writes.some((w) => w.table === 'onboarding_requests')).toBe(true);
  });

  it('a census outage is "try later", not an onboarding request (not the carrier\'s fault)', async () => {
    const { d, twin } = deps({ '133655': SCHNEIDER }, { '133655': 'down' });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655' }, d);
    expect(r).toMatchObject({ verification: { possible: false, reason: 'contact_lookup_unavailable' } });
    expect(twin.writes.some((w) => w.table === 'onboarding_requests')).toBe(false);
  });

  it('a registry row for a different MC is ignored (never trust a mismatched record)', async () => {
    const { d } = deps({ '133655': SCHNEIDER }, { '133655': [] });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655', registry: { mcNumber: '999', contactPhone: '+13125550142' } }, d);
    expect(r).toMatchObject({ verification: { possible: false, reason: 'no_contact_on_file' } });
  });

  it('a sandbox carrier is the only case that asks the caller for an email', async () => {
    const { d } = deps({ '133655': SCHNEIDER });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655', registry: { mcNumber: '133655', isSandbox: true } }, d);
    expect(r).toMatchObject({ verification: { needs_caller_email: true } });
  });

  it('a carrier blocked in broker records is refused', async () => {
    const { d } = deps({ '133655': SCHNEIDER });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655', registry: { mcNumber: '133655', status: 'blocked', contactPhone: '+13125550142' } }, d);
    expect(r).toMatchObject({ result: 'not_eligible', reason: 'blocked' });
  });

  it('never returns a full phone or email to the agent', async () => {
    const { d } = deps({ '133655': SCHNEIDER });
    const r = await checkCarrier({ callId: CALL, mcSpoken: '133655', registry: { mcNumber: '133655', contactPhone: '+13125550142', contactEmail: 'ops@acme.com' } }, d);
    const json = JSON.stringify(r);
    expect(json).not.toContain('5550142');
    expect(json).not.toContain('ops@');
  });
});

describe('abuse and resilience', () => {
  it('caps distinct MCs per call at 3; repeating the same MC does not count', async () => {
    const { d } = deps({ '1': MC1, '2': MC1, '3': MC1, '4': MC1 });
    for (const mc of ['1', '1', '2', '3']) expect((await checkCarrier({ callId: CALL, mcSpoken: mc }, d)).result).not.toBe('too_many_attempts');
    expect((await checkCarrier({ callId: CALL, mcSpoken: '4' }, d)).result).toBe('too_many_attempts');
  });

  it('a Twin outage never breaks the call; the failure is logged for repair', async () => {
    const { d, logs } = deps({ '133655': SCHNEIDER }, { '133655': [{ dot: 264184, phone: '9205922000' }] }, true);
    expect((await checkCarrier({ callId: CALL, mcSpoken: '133655' }, d)).result).toBe('eligible');
    expect(logs.some((l) => l.event === 'audit_write_failed')).toBe(true);
  });

  it('writes an audit trail: call row, FMCSA result, contact resolution (masked)', async () => {
    const { d, twin } = deps({ '133655': SCHNEIDER }, { '133655': [{ dot: 264184, phone: '9205922000' }] });
    await checkCarrier({ callId: CALL, mcSpoken: '133655' }, d);
    const events = twin.writes.filter((w) => w.table === 'call_events').map((w) => (w.body.values as Record<string, string>).type);
    expect(twin.writes[0]!.table).toBe('calls');
    expect(events).toEqual(['fmcsa_checked', 'contact_resolved']);
    expect(JSON.stringify(twin.writes)).not.toContain('9205922000');
  });
});

describe('POST /v1/carrier/check', () => {
  const config = loadConfig({
    ENVIRONMENT: 'staging', OAUTH_CLIENT_ID: 'happyrobot', OAUTH_CLIENT_SECRET: 's'.repeat(40), OAUTH_SIGNING_KEY: 'k'.repeat(40), OPS_CLIENT_SECRET: 'o'.repeat(40), TWIN_READER_API_KEY: 'r'.repeat(30),
    TWIN_WRITER_API_KEY: 'w'.repeat(30), FMCSA_WEB_KEY: 'f'.repeat(20), OTP_HASH_KEY: 'h'.repeat(40), TMS_HOST: '127.0.0.1', TMS_PORT: '1', TMS_AUTH_TOKEN: 't',
  });

  it('accepts the workflow\'s text values (empty registry fields, "true"/"false") and answers', async () => {
    const { d } = deps({ '133655': SCHNEIDER });
    const app = await buildApp(config, d);
    const auth = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
    const res = await app.inject({ method: 'POST', url: '/v1/carrier/check', headers: auth, payload: {
      call_id: CALL, run_url: '', mc_number: 'MC 133655',
      registry_mc_number: '133655', registry_legal_name: '', registry_contact_phone: '+13125550142', registry_contact_email: '', registry_is_sandbox: 'false', registry_status: 'active',
    } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: 'eligible', verification: { channel: 'sms' } });
  });

  it('rejects a body with unknown fields or a bad call id', async () => {
    const app = await buildApp(config, deps({}).d);
    const auth = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
    expect((await app.inject({ method: 'POST', url: '/v1/carrier/check', headers: auth, payload: { call_id: 'x', mc_number: '1' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/carrier/check', headers: auth, payload: { call_id: CALL, mc_number: '1', registry_contact_phone_override: '+1' } })).statusCode).toBe(400);
  });

  it('changing MC invalidates carrier-bound verification and deal state, releases the hold, and requires a new code', async () => {
    const OTHER_CARRIER: Carrier = { dot: 999002, name: 'SECOND CARRIER LLC' };
    const { d } = deps({ '133655': SCHNEIDER, '135797': OTHER_CARRIER });
    await checkCarrier({ callId: CALL, mcSpoken: '133655', registry: { mcNumber: '133655', contactPhone: '+13125550142' } }, d);
    const sent = await sendCode({ callId: CALL }, { ...d, hashKey: config.OTP_HASH_KEY });
    expect(sent.sent).toBe(true);
    const delivered = await deliverCode({ callId: CALL }, { ...d, hashKey: config.OTP_HASH_KEY });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) throw new Error('expected a delivered code');
    expect(await checkCode({ callId: CALL, codeSpoken: delivered.code }, { ...d, hashKey: config.OTP_HASH_KEY })).toMatchObject({ verified: true });

    const now = Date.now();
    await d.state.update(CALL, (s) => ({
      state: {
        ...s,
        negotiation: { loadId: 'LD01075', lane: 'A -> B', equipment: 'FLATBED', postedUsd: 1000, ceilingUsd: 1100, rounds: 1, finalOffered: false, status: 'agreed', agreedUsd: 1050 },
        reservation: { loadId: 'LD01075', priceUsd: 1050, expiresAt: now + 60_000 },
        transferred: true,
      },
      result: null,
    }));
    await d.state.updateReservation('LD01075', () => ({
      reservation: {
        reservationId: 'identity-test', loadId: 'LD01075', callId: CALL, mcNumber: '133655', priceUsd: 1050,
        postedUsd: 1000, ceilingUsd: 1100, lane: 'A -> B', equipment: 'FLATBED', createdAt: now,
        expiresAt: now + 60_000, status: 'reserved',
      },
      result: null,
    }));

    await checkCarrier({ callId: CALL, mcSpoken: '135797', registry: { mcNumber: '135797', contactPhone: '+14155550199' } }, d);
    const switched = await d.state.get(CALL);
    expect(switched).toMatchObject({ mcNumber: '135797', carrier: { mcNumber: '135797' }, verified: false });
    expect(switched).not.toHaveProperty('verifiedAt');
    expect(switched).not.toHaveProperty('verifiedMc');
    expect(switched).not.toHaveProperty('otp');
    expect(switched).not.toHaveProperty('negotiation');
    expect(switched).not.toHaveProperty('reservation');
    expect(switched).not.toHaveProperty('transferred');
    expect((await d.state.getReservation('LD01075'))?.status).toBe('released');

    const app = await buildApp(config, { fmcsa: d.fmcsa, census: d.census, state: d.state, records: d.records });
    const auth = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
    expect((await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: CALL, equipment: 'flatbed' } })).statusCode).toBe(403);
    for (const [url, payload] of [
      ['/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' }],
      ['/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 1000 }],
      ['/v1/reservations', { call_id: CALL }],
    ] as const) {
      expect((await app.inject({ method: 'POST', url, headers: auth, payload })).json()).toMatchObject({ ok: false, reason: 'not_verified' });
    }

    const sentForB = await sendCode({ callId: CALL }, { ...d, hashKey: config.OTP_HASH_KEY });
    expect(sentForB).toMatchObject({ sent: true, destination_masked: '+1••••••••99' });
    const deliveredForB = await deliverCode({ callId: CALL }, { ...d, hashKey: config.OTP_HASH_KEY });
    expect(deliveredForB).toMatchObject({ ok: true, to: '+14155550199' });
  });
});
