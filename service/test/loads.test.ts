import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { issueToken } from '../src/auth.js';
import { TmsClient } from '../src/tms/client.js';
import { MemoryCallStateStore } from '../src/storage/call-state.js';
import { detailLine, err, ok, startFakeTms, summaryLine, type Behavior, type FakeRequest } from './fake-tms.js';

const config = loadConfig({
  ENVIRONMENT: 'staging', OAUTH_CLIENT_ID: 'happyrobot', OAUTH_CLIENT_SECRET: 's'.repeat(40), OAUTH_SIGNING_KEY: 'k'.repeat(40), OPS_CLIENT_SECRET: 'o'.repeat(40), TWIN_READER_API_KEY: 'r'.repeat(30),
  TWIN_WRITER_API_KEY: 'w'.repeat(30), FMCSA_WEB_KEY: 'f'.repeat(20), OTP_HASH_KEY: 'h'.repeat(40), TMS_HOST: '127.0.0.1', TMS_PORT: '1', TMS_AUTH_TOKEN: 't', TMS_TIMEOUT_MS: '150',
});

// TMS timestamps relative to now, so the tests don't expire.
const ts = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3_600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);

let fake: Awaited<ReturnType<typeof startFakeTms>> | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function setup(handler: (req: FakeRequest, n: number) => Behavior) {
  fake = await startFakeTms(handler);
  const tms = new TmsClient({ host: '127.0.0.1', port: fake.port, token: 't', timeoutMs: 150, backoffMs: 1, budgetMs: 1000 });
  const state = new MemoryCallStateStore();
  await state.update(CALL, (s) => ({ state: { ...s, carrier: { mcNumber: '133655', dotNumber: 1, legalName: 'Test', eligible: true }, verifiedAt: Date.now(), verifiedMc: '133655' }, result: null })); // a verified call
  const app = await buildApp(config, { tms, state });
  const auth = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
  return { app, auth, state };
}

const CALL = '00000000-0000-4000-8000-0000000000bb';
const UNVERIFIED = '00000000-0000-4000-8000-0000000000cc';

describe('POST /v1/loads/search', () => {
  it('turns spoken input into exact TMS codes', async () => {
    const { app, auth } = await setup(() => ok(summaryLine({ PICKUP_DT: ts(24) })));
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth,
      payload: { call_id: CALL, origin_state: 'Georgia', destination_state: 'texas', equipment: 'refrigerated', origin_city: 'atlanta' } });
    expect(res.statusCode).toBe(200);
    expect(fake!.requests[0]!.fields).toMatchObject({ ORIG_STATE: 'GA', DEST_STATE: 'TX', EQTYPE: 'REEFER', ORIG_CITY: 'Atlanta' });
  });

  it('returns at most `limit` open loads, soonest pickup first, skipping past pickups', async () => {
    const { app, auth } = await setup(() => ok(
      summaryLine({ LOAD_ID: 'LD00001', PICKUP_DT: ts(48) }),
      summaryLine({ LOAD_ID: 'LD00002', PICKUP_DT: ts(-2) }),             // pickup already passed
      summaryLine({ LOAD_ID: 'LD00003', PICKUP_DT: ts(5) }),
      summaryLine({ LOAD_ID: 'LD00004', PICKUP_DT: ts(10), STATUS: 'BOOKED' }),
      summaryLine({ LOAD_ID: 'LD00005', PICKUP_DT: ts(20) }),
    ));
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: CALL, equipment: 'flatbed', limit: 2 } });
    expect(res.json().loads.map((l: { load_id: string }) => l.load_id)).toEqual(['LD00003', 'LD00005']);
  });

  it('asks the agent to clarify input it can not map, instead of searching blindly', async () => {
    const { app, auth } = await setup(() => ok());
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: CALL, origin_state: 'Gorgia', equipment: 'spaceship' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().fields).toEqual(['origin_state', 'equipment']);
    expect(fake!.requests).toHaveLength(0);
  });

  it('requires at least one filter', async () => {
    const { app, auth } = await setup(() => ok());
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: CALL } });
    expect(res.statusCode).toBe(422);
  });

  it('rejects unexpected fields (no smuggling raw TMS filters)', async () => {
    const { app, auth } = await setup(() => ok());
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: CALL, equipment: 'reefer', MAX_BUY: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it('says the board is unavailable (503, retryable) when the TMS keeps failing', async () => {
    const { app, auth } = await setup(() => ({ timeout: true }));
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: CALL, equipment: 'reefer' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'tms_unavailable', retryable: true });
  });

  it('requires a token', async () => {
    const { app } = await setup(() => ok());
    expect((await app.inject({ method: 'POST', url: '/v1/loads/search', payload: { call_id: CALL, equipment: 'reefer' } })).statusCode).toBe(401);
  });
});

describe('GET /v1/loads/:id', () => {
  it('returns the details the agent pitches, and never the ceiling', async () => {
    const { app, auth } = await setup(() => ok(detailLine({ PICKUP_DT: ts(24), MAX_BUY: 2274, NOTES: 'Tarps required' })));
    const res = await app.inject({ method: 'GET', url: `/v1/loads/LD01075?call_id=${CALL}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ load_id: 'LD01075', commodity: 'Steel Coils', notes: 'Tarps required', posted_rate_usd: 2037 });
    expect(res.body).not.toMatch(/max/i);
    expect(res.body).not.toContain('2274');
  });

  it('404 for an unknown load', async () => {
    const { app, auth } = await setup(() => err('NOT_FOUND'));
    expect((await app.inject({ method: 'GET', url: `/v1/loads/LD99999?call_id=${CALL}`, headers: auth })).statusCode).toBe(404);
  });

  it('400 for an id that is not a load id (never reaches the TMS)', async () => {
    const { app, auth } = await setup(() => ok());
    expect((await app.inject({ method: 'GET', url: `/v1/loads/LD1%7CCMD:LOAD_BOOK?call_id=${CALL}`, headers: auth })).statusCode).toBe(400);
    expect(fake!.requests).toHaveLength(0);
  });
});

describe('verification gate (no loads before the one-time code)', () => {
  it('search refuses an unverified call, and never touches the TMS', async () => {
    const { app, auth } = await setup(() => ok(summaryLine({ PICKUP_DT: ts(24) })));
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: UNVERIFIED, equipment: 'reefer' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_verified');
    expect(fake!.requests).toHaveLength(0);
  });

  it('details refuse an unverified call, and a missing call id', async () => {
    const { app, auth } = await setup(() => ok(detailLine({ PICKUP_DT: ts(24) })));
    expect((await app.inject({ method: 'GET', url: `/v1/loads/LD01075?call_id=${UNVERIFIED}`, headers: auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/loads/LD01075', headers: auth })).statusCode).toBe(400);
    expect(fake!.requests).toHaveLength(0);
  });

  it('a call locked after wrong codes gets no loads even if it was marked verified', async () => {
    const { app, auth, state } = await setup(() => ok(summaryLine({ PICKUP_DT: ts(24) })));
    await state.update(CALL, (s) => ({ state: { ...s, locked: true }, result: null }));
    expect((await app.inject({ method: 'POST', url: '/v1/loads/search', headers: auth, payload: { call_id: CALL, equipment: 'reefer' } })).statusCode).toBe(403);
  });
});
