import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { issueToken } from '../src/auth.js';
import { TmsClient } from '../src/tms/client.js';
import { MemoryCallStateStore, type CarrierState } from '../src/storage/call-state.js';
import { CallRecords, TwinWriter } from '../src/storage/twin.js';
import { detailLine, err, ok, startFakeTms, type Behavior, type FakeRequest } from './fake-tms.js';

const config = loadConfig({
  ENVIRONMENT: 'staging', OAUTH_CLIENT_ID: 'happyrobot', OAUTH_CLIENT_SECRET: 's'.repeat(40), OAUTH_SIGNING_KEY: 'k'.repeat(40), OPS_CLIENT_SECRET: 'o'.repeat(40), TWIN_READER_API_KEY: 'r'.repeat(30),
  TWIN_WRITER_API_KEY: 'w'.repeat(30), FMCSA_WEB_KEY: 'f'.repeat(20), OTP_HASH_KEY: 'h'.repeat(40), TMS_HOST: '127.0.0.1', TMS_PORT: '1', TMS_AUTH_TOKEN: 't',
});
const CALL = '00000000-0000-4000-8000-0000000000e1';
const CALL2 = '00000000-0000-4000-8000-0000000000e2';
const CARRIER: CarrierState = { mcNumber: '133655', dotNumber: 264184, legalName: 'SCHNEIDER', eligible: true, contactSource: 'broker_records', phone: '+13125550142' };
const ts = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const CONFIRMED = ok('LOAD_ID:LD01075|BOOKING_REF:BR00000000091277|STATUS:BOOKED  |TIMESTAMP:20261109193122');

let fake: Awaited<ReturnType<typeof startFakeTms>> | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function setup(opts: { status?: string; statusAfterFirst?: string; book?: (n: number) => Behavior; verified?: boolean; maxBuy?: number | null } = {}) {
  let books = 0;
  let loadGets = 0;
  fake = await startFakeTms((req: FakeRequest) => {
    if (req.cmd === 'LOAD_GET') {
      loadGets++;
      const status = loadGets > 1 && opts.statusAfterFirst ? opts.statusAfterFirst : (opts.status ?? 'OPEN');
      return ok(detailLine({ PICKUP_DT: ts(24), STATUS: status, ...(opts.maxBuy ? { MAX_BUY: opts.maxBuy } : {}) }, opts.maxBuy !== null));
    }
    return (opts.book ?? (() => CONFIRMED))(++books);
  });
  const tms = new TmsClient({ host: '127.0.0.1', port: fake.port, token: 't', timeoutMs: 150, backoffMs: 1, budgetMs: 1000 });
  const state = new MemoryCallStateStore();
  const twin: { table: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (u: string, init: RequestInit) => { twin.push({ table: u.split('/tables/')[1]!.split('/')[0]!, body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
  const records = new CallRecords(new TwinWriter({ apiKey: 'k', environment: 'staging', fetchImpl, sleep: async () => {} }), 'staging');
  for (const c of [CALL, CALL2]) {
    await state.update(c, (s) => ({ state: { ...s, mcNumber: CARRIER.mcNumber, carrier: CARRIER, ...(opts.verified === false ? {} : { verifiedAt: Date.now(), verifiedMc: CARRIER.mcNumber }) }, result: null }));
  }
  const app = await buildApp(config, { tms, state, records });
  const auth = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
  // Senior-rep actions (confirm, release) need the ops client's token (D-027).
  const opsAuth = { authorization: `Bearer ${await issueToken(config, config.OPS_CLIENT_ID)}` };
  const post = async (url: string, payload: object) =>
    (await app.inject({ method: 'POST', url, headers: /\/v1\/reservations\/(confirm|release)$/.test(url) ? opsAuth : auth, payload })).json();
  return { post, state, twin, responses: [] as string[] };
}

const loadBooks = () => fake!.requests.filter((q) => q.cmd === 'LOAD_BOOK');
const lastCallUpdate = (twin: { table: string; body: Record<string, unknown> }[]) =>
  (twin.filter((w) => w.table === 'calls').pop()!.body as { updates: Record<string, string> }).updates;

describe('negotiation, end to end over HTTP (LD01075: posted $2,037, ceiling $2,274)', () => {
  it('the worked example: pitch, three counters, final offer, accepted, reserved, then confirmed by a rep', async () => {
    const { post, twin } = await setup();
    const all: unknown[] = [];
    const start = await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' }); all.push(start);
    expect(start).toMatchObject({ ok: true, pitch_rate_usd: 2037 });
    for (const [ask, want] of [[2400, ['counter', 2100]], ['$2,300', ['counter', 2175]], [2280, ['final_offer', 2250]], [2250, ['accept', 2250]]] as const) {
      const r = await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: ask }); all.push(r);
      expect([r.decision, r.price_usd]).toEqual(want);
    }
    const reserved = await post('/v1/reservations', { call_id: CALL }); all.push(reserved);
    expect(reserved).toMatchObject({ ok: true, status: 'reserved', price_usd: 2250 });
    expect(loadBooks()).toHaveLength(0); // the agent's reserve never books in the TMS

    const confirmed = await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' }); all.push(confirmed);
    expect(confirmed).toMatchObject({ ok: true, status: 'booked', booking_ref: 'BR00000000091277' });
    expect(loadBooks()).toHaveLength(1);
    expect(loadBooks()[0]!.fields).toMatchObject({ MC_NUM: '133655', AGREED_RATE: '2250', LOAD_ID: 'LD01075' });

    // The ceiling never reaches the agent, in any response (reserve and confirm included).
    expect(JSON.stringify(all)).not.toContain('2274');
    expect(JSON.stringify(all)).not.toMatch(/max_?buy|ceiling/i);

    // Audit trail: three offer rows (rounds 1-3), pricing with margin kept, a reserved event, outcome booked.
    expect(twin.filter((w) => w.table === 'offers').map((w) => (w.body.values as Record<string, string>).round)).toEqual(['1', '2', '3']);
    const pricing = twin.find((w) => w.table === 'load_pricing')!.body.values as Record<string, string>;
    expect(pricing).toMatchObject({ ceiling_usd: '2274', agreed_rate_usd: '2250', margin_vs_ceiling_usd: '24' });
    expect(twin.some((w) => w.table === 'call_events' && (w.body.values as Record<string, string>).type === 'reserved')).toBe(true);
    expect(lastCallUpdate(twin).outcome).toBe('booked');
  });

  it('holding out past the final offer ends with no deal; no reservation or booking is possible afterwards', async () => {
    const { post } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    for (const ask of [2400, 2300, 2280]) await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: ask });
    expect(await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2270 })).toMatchObject({ decision: 'no_deal' });
    expect(await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2000 })).toMatchObject({ ok: false, reason: 'closed' });
    expect(await post('/v1/reservations', { call_id: CALL })).toMatchObject({ ok: false, reason: 'no_agreed_price' });
    expect(loadBooks()).toHaveLength(0);
  });

  it('with no ceiling from the TMS, only the posted rate is offered', async () => {
    const { post } = await setup({ maxBuy: null });
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    expect(await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2400 })).toMatchObject({ decision: 'counter', price_usd: 2037 });
  });

  it('a defined ceiling below the posted rate is not pitchable', async () => {
    const { post, state, twin } = await setup({ maxBuy: 2000 });
    expect(await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' })).toMatchObject({ ok: false, reason: 'not_available' });
    expect((await state.get(CALL))?.negotiation).toBeUndefined();
    expect(twin.some((w) => w.table === 'call_events' && (w.body.values as Record<string, string>).type === 'pitch')).toBe(false);
  });

  it('three counter rounds are a call-wide limit that a new start cannot reset', async () => {
    const { post, twin } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    for (const ask of [2400, 2300, 2280]) await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: ask });
    expect(await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' })).toMatchObject({ ok: false, reason: 'closed' });
    expect(await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2270 })).toMatchObject({ decision: 'no_deal' });
    expect(await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' })).toMatchObject({ ok: false, reason: 'closed' });
    expect(twin.filter((w) => w.table === 'offers')).toHaveLength(3);
  });

  it('accepting the posted rate right away: the next_step says to reserve now', async () => {
    const { post } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    const r = await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    expect(r).toMatchObject({ decision: 'accept', price_usd: 2037 });
    expect(r.next_step).toContain('Call reserve_load now');
  });

  it('accepting our counter ($2,100): the next_step says to reserve now', async () => {
    const { post } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    expect(await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2400 })).toMatchObject({ decision: 'counter', price_usd: 2100 });
    const r = await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2100 });
    expect(r).toMatchObject({ decision: 'accept', price_usd: 2100 });
    expect(r.next_step).toContain('Call reserve_load now');
  });

  it('a carrier-proposed number under our counter ($2,090): accepted, but not as "our offer", so the agent repeats the deal back', async () => {
    const { post } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2400 }); // counter $2,100
    const r = await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2090 });
    expect(r).toMatchObject({ decision: 'accept', price_usd: 2090 });
    expect(r.next_step).not.toContain('Call reserve_load now');
    expect(r.next_step).toContain('repeat the deal back');
  });
});

describe('guards', () => {
  it('nothing works for an unverified call', async () => {
    const { post } = await setup({ verified: false });
    expect(await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' })).toMatchObject({ ok: false, reason: 'not_verified' });
    expect(await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2000 })).toMatchObject({ ok: false, reason: 'not_verified' });
    expect(await post('/v1/reservations', { call_id: CALL })).toMatchObject({ ok: false, reason: 'not_verified' });
  });

  it('a load already taken or with a past pickup is not pitched', async () => {
    const { post } = await setup({ status: 'BOOKED' });
    expect(await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' })).toMatchObject({ ok: false, reason: 'not_available' });
  });

  it('the agent can not pass a price, MC, ceiling or a non-numeric offer (unknown fields rejected)', async () => {
    const { post } = await setup();
    expect(await post('/v1/reservations', { call_id: CALL, agreed_rate_usd: 1 })).toMatchObject({ error: 'invalid_request' });
    expect(await post('/v1/reservations/confirm', { load_id: 'LD01075', mc_number: '999999' })).toMatchObject({ error: 'invalid_request' });
    expect(await post('/v1/reservations/confirm', { load_id: 'LD01075' })).toMatchObject({ error: 'invalid_request' }); // initials required
    expect(await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075', ceiling_usd: 9999 })).toMatchObject({ error: 'invalid_request' });
    expect(await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 'twenty-three hundred' })).toMatchObject({ error: 'invalid_request' });
  });

  it('reserving twice gives the same answer, with no booking', async () => {
    const { post } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    const a = await post('/v1/reservations', { call_id: CALL });
    const b = await post('/v1/reservations', { call_id: CALL });
    expect([b.ok, b.status, b.price_usd]).toEqual([a.ok, a.status, a.price_usd]);
    expect(a).toMatchObject({ status: 'reserved', price_usd: 2037 });
    expect(loadBooks()).toHaveLength(0);
  });

  it('confirming twice sends one booking and gives the same answer', async () => {
    const { post } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    const a = await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' });
    const b = await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' });
    expect(b).toEqual(a);
    expect(a).toMatchObject({ ok: true, status: 'booked' });
    expect(loadBooks()).toHaveLength(1);
  });

  it('two simultaneous confirmations claim the reservation atomically and send one booking', async () => {
    const { post, state } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    const results = await Promise.all([
      post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' }),
      post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'BC' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.some((r) => r.reason === 'in_progress')).toBe(true);
    expect(loadBooks()).toHaveLength(1);
    expect((await state.getReservation('LD01075'))?.status).toBe('confirmed');
  });

  it('confirm and release cannot both claim the same reservation', async () => {
    const { post, state } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    const [confirmed, released] = await Promise.all([
      post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' }),
      post('/v1/reservations/release', { load_id: 'LD01075', reason: 'carrier backed out', initials: 'BC' }),
    ]);
    expect(Number(confirmed.ok) + Number(released.ok)).toBe(1);
    const final = await state.getReservation('LD01075');
    expect(final?.status === 'confirmed' || final?.status === 'released').toBe(true);
    expect(final?.status === 'confirmed' ? loadBooks().length : 0).toBe(loadBooks().length);
  });

  it('a timeout then ALREADY_BOOKED is reported as booked with the reference pending', async () => {
    const { post } = await setup({ book: (n) => (n === 1 ? { timeout: true } : err('ALREADY_BOOKED')) });
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    expect(await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' })).toMatchObject({ ok: true, status: 'booked_ref_pending', booking_ref: null });
  });

  it('an ambiguous booking becomes a manual-check state and is never retried or released', async () => {
    const { post, state } = await setup({ book: () => ({ timeout: true }) });
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    expect(await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' })).toMatchObject({ ok: false, reason: 'booking_unresolved', retryable: false });
    const sent = loadBooks().length;
    expect((await state.getReservation('LD01075'))?.status).toBe('booking_unresolved');
    expect(await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'BC' })).toMatchObject({ ok: false, reason: 'booking_unresolved' });
    expect(await post('/v1/reservations/release', { load_id: 'LD01075', reason: 'release', initials: 'BC' })).toMatchObject({ ok: false, reason: 'booking_unresolved' });
    expect(loadBooks()).toHaveLength(sent);
  });

  it('a load taken on the board between the pitch and the reserve is not held', async () => {
    const { post, twin } = await setup({ statusAfterFirst: 'BOOKED' });
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    expect(await post('/v1/reservations', { call_id: CALL })).toMatchObject({ ok: false, reason: 'not_available' });
    expect(loadBooks()).toHaveLength(0);
    expect(twin.some((w) => w.table === 'call_events' && (w.body.values as Record<string, string>).type === 'reserved')).toBe(false);
  });
});

describe('two calls, one load', () => {
  it('a load held by one call can not be reserved or pitched to another', async () => {
    const { post } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/negotiation/start', { call_id: CALL2, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL2, carrier_offer_usd: 2037 });
    expect(await post('/v1/reservations', { call_id: CALL })).toMatchObject({ ok: true, status: 'reserved' });
    expect(await post('/v1/reservations', { call_id: CALL2 })).toMatchObject({ ok: false, reason: 'not_available' });
    expect(await post('/v1/negotiation/start', { call_id: CALL2, load_id: 'LD01075' })).toMatchObject({ ok: false, reason: 'not_available' });
    expect(loadBooks()).toHaveLength(0);
  });

  it('an expired hold no longer blocks: the next call can start, offer and reserve the load', async () => {
    const { post, state } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    await state.updateReservation('LD01075', (r) => ({ reservation: { ...r!, expiresAt: Date.now() - 1 }, result: null }));
    expect(await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' })).toMatchObject({ ok: false, reason: 'expired' });
    expect(await post('/v1/negotiation/start', { call_id: CALL2, load_id: 'LD01075' })).toMatchObject({ ok: true });
    expect(await post('/v1/negotiation/offer', { call_id: CALL2, carrier_offer_usd: 2037 })).toMatchObject({ ok: true, decision: 'accept' });
    expect(await post('/v1/reservations', { call_id: CALL2 })).toMatchObject({ ok: true, status: 'reserved', price_usd: 2037 });
    expect(loadBooks()).toHaveLength(0);
  });

  it('a rep releases a reserved load: the carrier is told, and a later confirm is refused', async () => {
    const { post, twin } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    expect(await post('/v1/reservations/release', { load_id: 'LD01075', reason: 'carrier backed out', initials: 'AD' })).toMatchObject({ ok: true, status: 'released', call_id: CALL });
    expect(await post('/v1/reservations/confirm', { load_id: 'LD01075', initials: 'AD' })).toMatchObject({ ok: false, reason: 'released' });
    expect(loadBooks()).toHaveLength(0);
    expect(twin.some((w) => w.table === 'call_events' && (w.body.values as Record<string, string>).type === 'reservation_released')).toBe(true);
  });
});

describe('transfer (mocked) and end of call', () => {
  it('only a reserved call is transferred, and the transfer is marked as mocked', async () => {
    const { post, twin } = await setup();
    expect(await post('/v1/calls/transfer', { call_id: CALL })).toMatchObject({ ok: false, reason: 'not_reserved' });
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    expect(await post('/v1/calls/transfer', { call_id: CALL })).toMatchObject({ ok: true, transferred: true, mocked: true });
    expect(twin.some((w) => w.table === 'call_events' && (w.body.values as Record<string, string>).type === 'transfer')).toBe(true);
    // The rep's handoff record: detail is stored as a JSON string in Twin.
    const transfer = twin.find((w) => w.table === 'call_events' && (w.body.values as Record<string, string>).type === 'transfer')!;
    const detailText = (transfer.body.values as Record<string, string>).detail;
    const detail = JSON.parse(detailText);
    expect(detail).toMatchObject({ mocked: true, to: 'senior_rep_queue', mc_number: '133655', load_id: 'LD01075', agreed_rate_usd: 2037, equipment: expect.any(String), lane: expect.any(String), reservation_expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(detailText).not.toContain('ceiling');
    expect(detailText).not.toContain('2274');
  });

  it('ending a reserved call records "reserved" whatever the agent says, and clears live state', async () => {
    const { post, state, twin } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    await post('/v1/calls/end', { call_id: CALL, reason: 'caller_ended', summary: 'Reserved LD01075 at posted rate.' });
    expect(lastCallUpdate(twin).outcome).toBe('reserved');
    const left = await state.get(CALL);
    expect(left).toMatchObject({ outcome: 'reserved' });
    expect(left).not.toHaveProperty('carrier'); // contact and deal data are dropped; only a tombstone stays
    expect(left).not.toHaveProperty('negotiation');
  });

  it('the after-call step after end_call changes nothing: a reserved call stays reserved (idempotent end)', async () => {
    const { post, twin } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    await post('/v1/reservations', { call_id: CALL });
    await post('/v1/calls/end', { call_id: CALL, summary: 'Reserved.' });        // agent's end_call
    const before = twin.length;
    expect(await post('/v1/calls/end', { call_id: CALL })).toMatchObject({ ok: true }); // after-call step
    expect(twin.slice(before)).toEqual([]);                                         // no outcome rewrite, no 2nd event
    expect(twin.filter((w) => w.table === 'call_events' && (w.body.values as Record<string, string>).type === 'call_ended')).toHaveLength(1);
  });

  it('a carrier who walks away mid-negotiation is a no_deal, whatever reason the agent gives', async () => {
    const { post, twin } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2400 });
    await post('/v1/calls/end', { call_id: CALL, reason: 'caller_ended' });
    expect(lastCallUpdate(twin).outcome).toBe('no_deal');
  });

  it('ending a call never fails: not_verified is accepted, an unknown reason is ignored', async () => {
    const { post, twin } = await setup({ verified: false });
    expect(await post('/v1/calls/end', { call_id: CALL, reason: 'not_verified', summary: 'Code never arrived.' })).toMatchObject({ ok: true });
    expect(lastCallUpdate(twin).outcome).toBe('not_verified');
    expect(await post('/v1/calls/end', { call_id: CALL2, reason: 'carrier_was_rude' })).toMatchObject({ ok: true });
    expect(lastCallUpdate(twin).outcome).toBe('caller_ended');
  });

  it('the agent\'s reason fills the gap only when nothing else decided the outcome', async () => {
    const { post, twin } = await setup();
    await post('/v1/calls/end', { call_id: CALL, reason: 'no_match' });
    const calls = twin.filter((w) => w.table === 'calls');
    expect((calls[0]!.body as { values: Record<string, string> }).values.call_id).toBe(CALL); // record created if missing
    expect(lastCallUpdate(twin).outcome).toBe('no_match');
  });

describe('a hold released by a rep while the call is still live', () => {
  it('blocks the transfer and the call ends as released, not reserved', async () => {
    const { post, twin } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2037 });
    expect(await post('/v1/reservations', { call_id: CALL })).toMatchObject({ ok: true, status: 'reserved' });
    expect(await post('/v1/reservations/release', { load_id: 'LD01075', reason: 'rep released it', initials: 'AD' })).toMatchObject({ ok: true });
    expect(await post('/v1/calls/transfer', { call_id: CALL })).toMatchObject({ ok: false, reason: 'not_reserved' });
    await post('/v1/calls/end', { call_id: CALL, reason: 'caller_ended' });
    expect((twin.filter((w) => w.table === 'calls').pop()!.body as { updates: Record<string, string> }).updates.outcome).toBe('released');
  });
});

describe('the carrier says yes to our offer, but the agent skips carrier_offer', () => {
  it('reserving is refused with a next_step that names the price on the table, and nothing is held', async () => {
    const { post, state } = await setup();
    await post('/v1/negotiation/start', { call_id: CALL, load_id: 'LD01075' });
    const pitched = await post('/v1/reservations', { call_id: CALL });
    expect(pitched).toMatchObject({ ok: false, reason: 'no_agreed_price' });
    expect(pitched.next_step).toContain('carrier_offer with 2037');
    await post('/v1/negotiation/offer', { call_id: CALL, carrier_offer_usd: 2400 }); // counter $2,100
    const countered = await post('/v1/reservations', { call_id: CALL });
    expect(countered.next_step).toContain('carrier_offer with 2100');
    expect(await state.getReservation('LD01075')).toBeNull();
  });
});
});
