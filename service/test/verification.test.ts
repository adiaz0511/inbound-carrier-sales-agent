import { describe, expect, it } from 'vitest';
import { codeMatches, generateCode, hashCode, normalizeSpokenCode } from '../src/verification/otp.js';
import { checkCode, deliverCode, sendCode, type VerificationDeps } from '../src/verification/service.js';
import { MemoryCallStateStore, type CarrierState } from '../src/storage/call-state.js';
import { CallRecords, TwinWriter } from '../src/storage/twin.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { issueToken } from '../src/auth.js';

const KEY = 'h'.repeat(40);
const CALL = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';
const CARRIER: CarrierState = { mcNumber: '133655', dotNumber: 264184, legalName: 'SCHNEIDER', eligible: true, contactSource: 'broker_records', phone: '+13125550142', email: 'ops@acme.com' };

function setup(carrier: CarrierState | null = CARRIER) {
  const state = new MemoryCallStateStore();
  const twinWrites: string[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => { twinWrites.push(String(init.body)); return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
  const records = new CallRecords(new TwinWriter({ apiKey: 'k', environment: 'staging', fetchImpl, sleep: async () => {} }), 'staging');
  const d: VerificationDeps = { state, records, hashKey: KEY, log: () => {} };
  const seed = async (callId = CALL, c = carrier) => { if (c) await state.update(callId, (s) => ({ state: { ...s, mcNumber: c.mcNumber, carrier: c }, result: null })); };
  return { d, state, twinWrites, seed };
}

// Send (agent-facing) then deliver (hidden workflow step), as the workflow does; returns both, for assertions.
async function sendOk(d: VerificationDeps, callId = CALL, extra = {}) {
  const r = await sendCode({ callId, ...extra }, d);
  if (!r.sent) throw new Error(`expected sent, got ${r.reason}`);
  const del = await deliverCode({ callId }, d);
  if (!del.ok) throw new Error('expected delivery');
  return { ...r, deliver_code: del.code, deliver_to: del.to };
}

describe('code basics', () => {
  it('codes are 6 digits, and the stored hash is keyed and bound to the call', () => {
    const c = generateCode();
    expect(c).toMatch(/^\d{6}$/);
    const h = hashCode(KEY, CALL, c);
    expect(codeMatches(KEY, CALL, c, h)).toBe(true);
    expect(codeMatches(KEY, OTHER, c, h)).toBe(false);       // same code, another call: useless
    expect(codeMatches('x'.repeat(40), CALL, c, h)).toBe(false); // without the key: useless
  });

  it('reads spoken codes leniently but only accepts exactly 6 digits', () => {
    expect(normalizeSpokenCode('123 456')).toBe('123456');
    expect(normalizeSpokenCode('123-456')).toBe('123456');
    expect(normalizeSpokenCode('12345')).toBeNull();
    expect(normalizeSpokenCode('the code is 123456')).toBeNull();
  });
});

describe('sending', () => {
  it('sends only to the contact on file, SMS first, and tells the agent a masked destination', async () => {
    const { d, seed } = setup(); await seed();
    const r = await sendOk(d);
    expect(r).toMatchObject({ channel: 'sms', destination_masked: '+1••••••••42', deliver_to: '+13125550142', expires_in_seconds: 600, sends_left: 2 });
    expect(r.deliver_code).toMatch(/^\d{6}$/);
    expect(r.next_step).not.toContain(r.deliver_code);
  });

  it('the agent-facing send response never contains the code or the full destination (D-024)', async () => {
    const { d, seed } = setup(); await seed();
    const r = await sendCode({ callId: CALL }, d);
    expect(r).toMatchObject({ sent: true, channel: 'sms', destination_masked: '+1••••••••42' });
    expect(Object.keys(r).sort()).toEqual(['channel', 'destination_masked', 'expires_in_seconds', 'next_step', 'sends_left', 'sent']);
    expect(JSON.stringify(r)).not.toContain('+13125550142');
  });

  it('the hidden delivery step creates the code exactly once; nothing before send or after delivery', async () => {
    const { d, seed, state } = setup(); await seed();
    expect(await deliverCode({ callId: CALL }, d)).toEqual({ ok: false, reason: 'nothing_to_deliver' });
    await sendCode({ callId: CALL }, d);
    expect(await checkCode({ callId: CALL, codeSpoken: '123456' }, d)).toMatchObject({ reason: 'no_code_sent' }); // not delivered yet
    const del = await deliverCode({ callId: CALL }, d);
    expect(del).toMatchObject({ ok: true, channel: 'sms', to: '+13125550142' });
    expect(await deliverCode({ callId: CALL }, d)).toEqual({ ok: false, reason: 'nothing_to_deliver' });
    expect(JSON.stringify(await state.get(CALL))).not.toContain((del as { code: string }).code);
    expect(await checkCode({ callId: CALL, codeSpoken: (del as { code: string }).code }, d)).toMatchObject({ verified: true });
    expect(await deliverCode({ callId: CALL }, d)).toEqual({ ok: false, reason: 'nothing_to_deliver' }); // verified: nothing more
  });

  it('can switch to the other contact on file, never to a new one', async () => {
    const { d, seed } = setup(); await seed();
    expect(await sendOk(d, CALL, { channel: 'email' })).toMatchObject({ channel: 'email', deliver_to: 'ops@acme.com' });
    const { d: d2, seed: seed2 } = setup({ ...CARRIER, email: undefined }); await seed2();
    expect(await sendCode({ callId: CALL, channel: 'email' }, d2)).toMatchObject({ sent: false, reason: 'channel_unavailable' });
  });

  it('email only (CODE_CHANNELS=email): uses the email on file, never SMS, even when asked', async () => {
    const { d, seed } = setup(); await seed();
    const emailOnly = { ...d, channels: ['email'] as const };
    expect(await sendOk(emailOnly)).toMatchObject({ channel: 'email', deliver_to: 'ops@acme.com' });
    expect(await sendCode({ callId: CALL, channel: 'sms' }, emailOnly)).toMatchObject({ sent: false, reason: 'channel_unavailable' });
  });

  it('email only: a carrier with just a phone on file has no usable contact (polite end, no send)', async () => {
    const { d, seed } = setup({ ...CARRIER, email: undefined }); await seed();
    expect(await sendCode({ callId: CALL }, { ...d, channels: ['email'] })).toMatchObject({ sent: false, reason: 'no_contact' });
  });

  it('ignores a caller-given email for a real carrier (no redirecting the code)', async () => {
    const { d, seed } = setup(); await seed();
    const r = await sendOk(d, CALL, { callerEmail: 'attacker@evil.com' });
    expect(r.deliver_to).toBe('+13125550142');
  });

  it('a sandbox carrier is the only one that uses a caller-given email, and it must be valid', async () => {
    const { d, seed } = setup({ ...CARRIER, contactSource: 'sandbox_caller', sandbox: true, phone: undefined, email: undefined }); await seed();
    expect(await sendCode({ callId: CALL }, d)).toMatchObject({ sent: false, reason: 'caller_email_required' });
    expect(await sendCode({ callId: CALL, callerEmail: 'not an email' }, d)).toMatchObject({ sent: false, reason: 'caller_email_invalid' });
    expect(await sendOk(d, CALL, { callerEmail: 'Reviewer@Example.com' })).toMatchObject({ channel: 'email', deliver_to: 'reviewer@example.com' });
  });

  it('refuses to send before the carrier check', async () => {
    const { d } = setup(null);
    expect(await sendCode({ callId: CALL }, d)).toMatchObject({ sent: false, reason: 'carrier_not_checked' });
  });

  it('allows 3 sends per call (first + 2 resends), then stops', async () => {
    const { d, seed } = setup(); await seed();
    for (let i = 0; i < 3; i++) await sendOk(d);
    expect(await sendCode({ callId: CALL }, d)).toMatchObject({ sent: false, reason: 'too_many_sends' });
  });

  it('caps sends per carrier across calls (no text-bombing a real carrier)', async () => {
    const { d, seed } = setup(); await seed(CALL); await seed(OTHER);
    for (let i = 0; i < 3; i++) await sendOk(d, CALL);
    for (let i = 0; i < 2; i++) await sendOk(d, OTHER);
    expect(await sendCode({ callId: OTHER }, d)).toMatchObject({ sent: false, reason: 'carrier_rate_limited' });
  });

  it('never stores the code itself, and never writes it or the full contact to the audit trail', async () => {
    const { d, state, twinWrites, seed } = setup(); await seed();
    const r = await sendOk(d);
    expect(JSON.stringify(await state.get(CALL))).not.toContain(r.deliver_code);
    expect(twinWrites.join()).not.toContain(r.deliver_code);
    expect(twinWrites.join()).not.toContain('5550142');
  });
});

describe('checking', () => {
  it('the right code verifies the call, once; the code is destroyed', async () => {
    const { d, state, seed } = setup(); await seed();
    const { deliver_code } = await sendOk(d);
    expect(await checkCode({ callId: CALL, codeSpoken: deliver_code }, d)).toMatchObject({ verified: true });
    expect((await state.get(CALL))?.otp).toBeUndefined();
    expect(await sendCode({ callId: CALL }, d)).toMatchObject({ sent: false, reason: 'already_verified' });
  });

  it('3 wrong codes lock verification for the call; then even the right code fails and no code can be sent', async () => {
    const { d, seed } = setup(); await seed();
    const { deliver_code } = await sendOk(d);
    const wrong = deliver_code === '000000' ? '111111' : '000000';
    expect(await checkCode({ callId: CALL, codeSpoken: wrong }, d)).toMatchObject({ reason: 'wrong_code', attempts_left: 2 });
    expect(await checkCode({ callId: CALL, codeSpoken: wrong }, d)).toMatchObject({ reason: 'wrong_code', attempts_left: 1 });
    expect(await checkCode({ callId: CALL, codeSpoken: wrong }, d)).toMatchObject({ reason: 'locked' });
    expect(await checkCode({ callId: CALL, codeSpoken: deliver_code }, d)).toMatchObject({ verified: false, reason: 'locked' });
    expect(await sendCode({ callId: CALL }, d)).toMatchObject({ sent: false, reason: 'locked' });
  });

  it('a resend does not reset the wrong-code count (no extra guesses)', async () => {
    const { d, seed } = setup(); await seed();
    await sendOk(d);
    await checkCode({ callId: CALL, codeSpoken: '000001' }, d);
    await checkCode({ callId: CALL, codeSpoken: '000002' }, d);
    const { deliver_code } = await sendOk(d); // resend
    const wrong = deliver_code === '000003' ? '000004' : '000003';
    expect(await checkCode({ callId: CALL, codeSpoken: wrong }, d)).toMatchObject({ reason: 'locked' });
  });

  it('only the newest code works after a resend', async () => {
    const { d, seed } = setup(); await seed();
    const first = (await sendOk(d)).deliver_code;
    const second = (await sendOk(d)).deliver_code;
    if (first !== second) expect(await checkCode({ callId: CALL, codeSpoken: first }, d)).toMatchObject({ reason: 'wrong_code' });
    expect(await checkCode({ callId: CALL, codeSpoken: second }, d)).toMatchObject({ verified: true });
  });

  it('an expired code is refused and a resend is offered', async () => {
    const { d, state, seed } = setup(); await seed();
    const { deliver_code } = await sendOk(d);
    await state.update(CALL, (s) => ({ state: { ...s, otp: { ...s.otp!, expiresAt: Date.now() - 1 } }, result: null }));
    expect(await checkCode({ callId: CALL, codeSpoken: deliver_code }, d)).toMatchObject({ verified: false, reason: 'expired', can_resend: true });
  });

  it('garbled input asks again without spending an attempt', async () => {
    const { d, seed } = setup(); await seed();
    await sendOk(d);
    expect(await checkCode({ callId: CALL, codeSpoken: 'I did not get it' }, d)).toMatchObject({ reason: 'unclear', attempts_left: 3 });
  });

  it('a valid code from another call does not work here', async () => {
    const { d, seed } = setup(); await seed(CALL); await seed(OTHER);
    const other = (await sendOk(d, OTHER)).deliver_code;
    await sendOk(d, CALL);
    const r = await checkCode({ callId: CALL, codeSpoken: other }, d);
    expect(r.verified).toBe(false);
  });

  it('checking before any code was sent says so', async () => {
    const { d, seed } = setup(); await seed();
    expect(await checkCode({ callId: CALL, codeSpoken: '123456' }, d)).toMatchObject({ verified: false, reason: 'no_code_sent' });
  });
});

describe('verification routes', () => {
  const base = {
    ENVIRONMENT: 'staging', OAUTH_CLIENT_ID: 'happyrobot', OAUTH_CLIENT_SECRET: 's'.repeat(40), OAUTH_SIGNING_KEY: 'k'.repeat(40), OPS_CLIENT_SECRET: 'o'.repeat(40), TWIN_READER_API_KEY: 'r'.repeat(30),
    TWIN_WRITER_API_KEY: 'w'.repeat(30), FMCSA_WEB_KEY: 'f'.repeat(20), OTP_HASH_KEY: KEY, TMS_HOST: '127.0.0.1', TMS_PORT: '1', TMS_AUTH_TOKEN: 't',
  };
  const config = loadConfig(base);

  it('send then check, end to end over HTTP', async () => {
    const { d, seed } = setup(); await seed();
    const app = await buildApp(config, { state: d.state, records: d.records });
    const auth = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
    const sent = await app.inject({ method: 'POST', url: '/v1/verification/send', headers: auth, payload: { call_id: CALL, channel: '', caller_email: '' } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).not.toHaveProperty('deliver_code');
    const delivered = await app.inject({ method: 'POST', url: '/v1/verification/deliver', headers: auth, payload: { call_id: CALL } });
    const code = delivered.json().code as string;
    const checked = await app.inject({ method: 'POST', url: '/v1/verification/check', headers: auth, payload: { call_id: CALL, code: `${code.slice(0, 3)} ${code.slice(3)}` } });
    expect(checked.json()).toMatchObject({ verified: true });
  });

  it('CODE_CHANNELS defaults to email only and rejects unknown channels', () => {
    expect(config.CODE_CHANNELS).toEqual(['email']);
    expect(loadConfig({ ...base, CODE_CHANNELS: ' SMS; email ' }).CODE_CHANNELS).toEqual(['sms', 'email']);
    expect(() => loadConfig({ ...base, CODE_CHANNELS: 'whatsapp' })).toThrow(/CODE_CHANNELS/);
  });

  it('rejects unknown fields (nobody can smuggle in "verified": true)', async () => {
    const { d } = setup();
    const app = await buildApp(config, { state: d.state, records: d.records });
    const auth = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
    expect((await app.inject({ method: 'POST', url: '/v1/verification/check', headers: auth, payload: { call_id: CALL, code: '123456', verified: true } })).statusCode).toBe(400);
  });
});
