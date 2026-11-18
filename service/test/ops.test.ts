import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { issueToken } from '../src/auth.js';
import { MemoryCallStateStore, type Reservation } from '../src/storage/call-state.js';
import { CallRecords, TwinWriter } from '../src/storage/twin.js';
import { TwinReader } from '../src/storage/twin-reader.js';
import type { FastifyInstance } from 'fastify';

const config = loadConfig({
  ENVIRONMENT: 'staging', OAUTH_CLIENT_ID: 'happyrobot', OAUTH_CLIENT_SECRET: 's'.repeat(40), OAUTH_SIGNING_KEY: 'k'.repeat(40), OPS_CLIENT_SECRET: 'o'.repeat(40),
  TWIN_READER_API_KEY: 'r'.repeat(30), TWIN_WRITER_API_KEY: 'w'.repeat(30), FMCSA_WEB_KEY: 'f'.repeat(20), OTP_HASH_KEY: 'h'.repeat(40),
  TMS_HOST: '127.0.0.1', TMS_PORT: '1', TMS_AUTH_TOKEN: 't',
});
const CALL = '00000000-0000-4000-8000-0000000000c1';
const REQ = '00000000-0000-4000-8000-0000000000a1';

type Route = (sql: string) => Row[] | 'fail';
type Row = Record<string, unknown>;

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

/** Builds the app with a real TwinReader and TwinWriter over fake fetches; every SQL and write is recorded. */
async function setup(route: Route = () => [], opts: { state?: MemoryCallStateStore } = {}) {
  const sqls: string[] = [];
  const writes: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const readerFetch = (async (_url: string, init: RequestInit) => {
    const sql = (JSON.parse(String(init.body)) as { sql: string }).sql;
    sqls.push(sql);
    const rows = route(sql);
    if (rows === 'fail') return new Response('boom: internal details', { status: 500 });
    return new Response(JSON.stringify({ rows }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const writerFetch = (async (url: string, init: RequestInit) => {
    writes.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const reader = new TwinReader({ apiKey: config.TWIN_READER_API_KEY, environment: 'staging', fetchImpl: readerFetch });
  const records = new CallRecords(new TwinWriter({ apiKey: config.TWIN_WRITER_API_KEY, environment: 'staging', fetchImpl: writerFetch, sleep: async () => {} }), 'staging');
  const state = opts.state ?? new MemoryCallStateStore();
  app = await buildApp(config, { state, reader, records });
  const ops = { authorization: `Bearer ${await issueToken(config, config.OPS_CLIENT_ID)}` };
  const workflow = { authorization: `Bearer ${await issueToken(config, 'happyrobot')}` };
  return { app, state, sqls, writes, ops, workflow };
}

describe('ops KPIs', () => {
  it('maps Twin rows to numbers and computes the rates', async () => {
    const { app, ops, sqls } = await setup((sql) => {
      if (sql.includes('FROM load_pricing')) return [{ deals: '2', total_margin: '150', avg_margin: 75, avg_pct: 0.5 }];
      if (sql.includes('FROM call_events')) return [{ day: '2026-11-09', count: '3' }];
      if (sql.includes('COALESCE(outcome')) return [{ outcome: 'booked', n: '2' }, { outcome: 'reserved', n: '1' }, { outcome: 'released', n: '1' }, { outcome: null, n: '1' }];
      if (sql.includes('count(*) AS total')) return [{ total: '10', eligible: '8', code_sent: '6', verified: '4', lockouts: '1', avg_verify_s: 120.5, median_verify_s: '100', avg_counter_rounds: '1.5' }];
      return [];
    });
    const res = await app.inject({ method: 'GET', url: '/v1/ops/kpis?days=7', headers: ops });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.total).toBe(10);
    expect(b.funnel).toEqual({ calls: 10, eligible: 8, code_sent: 6, verified: 4, lockouts: 1 });
    expect(b.time_to_verify_seconds).toEqual({ avg: 120.5, median: 100 });
    expect(b.by_outcome).toMatchObject({ booked: 2, reserved: 1, released: 1, in_progress: 1 });
    expect(b.reservations).toEqual({ reserved_total: 4, reservation_rate: 1, confirmed: 2, confirmed_rate: 0.5 });
    expect(b.negotiation.avg_counter_rounds).toBe(1.5);
    expect(b.margin).toEqual({ deals: 2, total_margin_usd: 150, avg_margin_usd: 75, avg_pct_of_room: 0.5 });
    expect(b.tms.error_events_by_day).toEqual([{ day: '2026-11-09', count: 3 }]);
    expect(sqls.every((s) => s.includes("interval '7 days'"))).toBe(true);
  });

  it('days outside 1..90 or not a number is a 400 and sends no SQL', async () => {
    const { app, ops, sqls } = await setup();
    for (const q of ['days=0', 'days=abc', 'days=91', 'days=1;DROP']) {
      const res = await app.inject({ method: 'GET', url: `/v1/ops/kpis?${q}`, headers: ops });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
    }
    expect(sqls).toHaveLength(0);
  });

  it('a Twin failure is a 503 that leaks no details', async () => {
    const { app, ops } = await setup(() => 'fail');
    const res = await app.inject({ method: 'GET', url: '/v1/ops/kpis', headers: ops });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'twin_unavailable' });
    expect(res.body).not.toContain('boom');
  });
});

describe('ops call detail and list', () => {
  it('a callId that is not a UUID is a 400 with no SQL sent', async () => {
    const { app, ops, sqls } = await setup();
    const res = await app.inject({ method: 'GET', url: `/v1/ops/calls/${encodeURIComponent('1; DROP TABLE calls')}`, headers: ops });
    expect(res.statusCode).toBe(400);
    expect(sqls).toHaveLength(0);
  });

  it('an unknown call is a 404', async () => {
    const { app, ops } = await setup(() => []);
    const res = await app.inject({ method: 'GET', url: `/v1/ops/calls/${CALL}`, headers: ops });
    expect(res.statusCode).toBe(404);
  });

  it('returns the call with its events and offers', async () => {
    const { app, ops, sqls } = await setup((sql) => {
      if (sql.includes('FROM calls')) return [{
        call_id: CALL, outcome: 'booked', ceiling_usd: '2274', margin_kept_usd: '58', margin_kept_pct: '0.2447257384',
      }];
      if (sql.includes('FROM call_events')) return [{ type: 'offer', occurred_at: '2026-11-10 10:00:00', detail: {} }];
      if (sql.includes('FROM offers')) return [{ round: 1, carrier_offer_usd: 2400 }];
      return [];
    });
    const res = await app.inject({ method: 'GET', url: `/v1/ops/calls/${CALL}`, headers: ops });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      call: { outcome: 'booked', ceiling_usd: 2274, margin_kept_usd: 58, margin_kept_pct: 0.2447257384 },
      events: [{ type: 'offer' }],
      offers: [{ round: 1 }],
    });
    expect(sqls.every((s) => s.includes(`'${CALL}'`))).toBe(true);
    expect(sqls[0]).toContain('LEFT JOIN load_pricing p ON p.call_id = c.call_id');
  });

  it('calls list is newest first and maps pricing numbers', async () => {
    const { app, ops, sqls } = await setup(() => [{
      call_id: CALL, posted_rate_usd: '2037', agreed_rate_usd: '2216', ceiling_usd: '2274',
      margin_kept_usd: '58', margin_kept_pct: '0.2447257384', counter_rounds: '2', transferred: 'false',
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/ops/calls?limit=5', headers: ops });
    expect(res.json().calls[0]).toMatchObject({
      posted_rate_usd: 2037, agreed_rate_usd: 2216, ceiling_usd: 2274,
      margin_kept_usd: 58, margin_kept_pct: 0.2447257384, counter_rounds: 2, transferred: false,
    });
    expect(sqls[0]).toContain('LIMIT 5');
    expect(sqls[0]).toContain('ORDER BY c.started_at DESC');
    expect(sqls[0]).toContain('LEFT JOIN load_pricing p ON p.call_id = c.call_id');
  });

  it('returns null pricing fields when a call has no pricing row', async () => {
    const { app, ops } = await setup((sql) => {
      if (sql.includes('FROM calls')) return [{ call_id: CALL }];
      return [];
    });
    const [list, detail] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/ops/calls', headers: ops }),
      app.inject({ method: 'GET', url: `/v1/ops/calls/${CALL}`, headers: ops }),
    ]);
    const missing = { ceiling_usd: null, margin_kept_usd: null, margin_kept_pct: null };
    expect(list.json().calls[0]).toMatchObject(missing);
    expect(detail.json().call).toMatchObject(missing);
  });
});

describe('ops holds', () => {
  it('lists active holds first, never exposes ceiling or posted rate', async () => {
    const state = new MemoryCallStateStore();
    const now = Date.now();
    const base = { callId: CALL, mcNumber: '133655', carrierName: 'SCHNEIDER', lane: 'Atlanta, GA -> Dallas, TX', equipment: 'Dry Van', postedUsd: 2037, ceilingUsd: 2274, createdAt: now };
    const holds: Reservation[] = [
      { ...base, reservationId: 'r1', loadId: 'LD01075', priceUsd: 2250, expiresAt: now + 30 * 60_000, status: 'reserved' },
      { ...base, reservationId: 'r2', loadId: 'LD01076', priceUsd: 2100, expiresAt: now - 1000, status: 'reserved' },
      { ...base, reservationId: 'r3', loadId: 'LD01077', priceUsd: 2000, expiresAt: now + 60 * 60_000, status: 'confirmed', bookingRef: 'BR1', closedAt: now - 3600_000 },
      { ...base, reservationId: 'r4', loadId: 'LD01078', priceUsd: 1900, expiresAt: now + 60 * 60_000, status: 'released', closedAt: now - 3 * 24 * 3600_000, closedReason: 'old' },
      { ...base, reservationId: 'r5', loadId: 'LD01079', priceUsd: 2200, expiresAt: now - 60_000, status: 'booking_unresolved', confirmationStartedAt: now - 120_000 },
    ];
    for (const r of holds) await state.updateReservation(r.loadId, () => ({ reservation: r, result: undefined }));
    const { app, ops } = await setup(() => [], { state });
    const res = await app.inject({ method: 'GET', url: '/v1/ops/holds', headers: ops });
    expect(res.statusCode).toBe(200);
    const list = res.json().holds as Row[];
    expect(list.map((h) => h.loadId)).toEqual(['LD01079', 'LD01075', 'LD01077']); // unresolved stays visible; expired and older-than-24h are left out
    expect(list[0]).toMatchObject({ status: 'booking_unresolved', priceUsd: 2200, bookingRef: null, minutesLeft: null });
    expect(list[1]).toMatchObject({ status: 'reserved', priceUsd: 2250, bookingRef: null });
    expect(list[1]!.minutesLeft).toBeGreaterThan(25);
    expect(list[2]).toMatchObject({ status: 'confirmed', bookingRef: 'BR1', minutesLeft: null });
    expect(res.body).not.toMatch(/ceiling|posted/i);
  });
});

describe('ops access and writes', () => {
  it('a workflow token gets 403 on the ops API', async () => {
    const { app, workflow } = await setup();
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/ops/kpis', headers: workflow }),
      app.inject({ method: 'GET', url: '/v1/ops/calls', headers: workflow }),
      app.inject({ method: 'GET', url: `/v1/ops/calls/${CALL}`, headers: workflow }),
    ]);
    expect(responses.map((res) => res.statusCode)).toEqual([403, 403, 403]);
  });

  it('marking an onboarding request contacted writes through the writer API, not SQL', async () => {
    const { app, ops, sqls, writes } = await setup((sql) => (sql.includes('SELECT status') ? [{ status: 'open' }] : []));
    const res = await app.inject({ method: 'POST', url: `/v1/ops/onboarding/${REQ}/contacted`, headers: ops, payload: { initials: 'ad', note: "left voicemail; ' DROP TABLE x" } });
    expect(res.statusCode).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toContain('/twin/tables/onboarding_requests/rows');
    expect(writes[0]!.method).toBe('PATCH');
    expect(writes[0]!.body.primaryKey).toEqual({ request_id: REQ });
    expect(JSON.stringify(writes[0]!.body)).toContain("left voicemail; ' DROP TABLE x");
    expect(sqls.every((s) => s.startsWith('SELECT'))).toBe(true);
  });

  it('contacting an unknown or closed onboarding request is a 404', async () => {
    const { app, ops, writes } = await setup(() => []);
    const res = await app.inject({ method: 'POST', url: `/v1/ops/onboarding/${REQ}/contacted`, headers: ops, payload: { initials: 'AD' } });
    expect(res.statusCode).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it('carrier contact rejects a bad phone with no SQL or write', async () => {
    const { app, ops, sqls, writes } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/ops/carriers/133655/contact', headers: ops, payload: { initials: 'AD', phone: '312-555-0142' } });
    expect(res.statusCode).toBe(400);
    expect(sqls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('carrier contact needs at least one valid field, and an unknown carrier is a 404', async () => {
    const { app, ops } = await setup(() => []);
    const none = await app.inject({ method: 'POST', url: '/v1/ops/carriers/133655/contact', headers: ops, payload: { initials: 'AD' } });
    expect(none.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/v1/ops/carriers/133655/contact', headers: ops, payload: { initials: 'AD', email: 'ops@acme.com' } });
    expect(unknown.json()).toEqual({ error: 'unknown_carrier' });
    expect(unknown.statusCode).toBe(404);
  });

  it('carrier contact updates a known carrier by primary key, email lower-cased', async () => {
    const { app, ops, writes } = await setup((sql) => (sql.includes('FROM carriers') ? [{ mc_number: '133655' }] : []));
    const res = await app.inject({ method: 'POST', url: '/v1/ops/carriers/133655/contact', headers: ops, payload: { initials: 'AD', email: 'Dispatch@Schneider.com', phone: '+13125550142' } });
    expect(res.statusCode).toBe(200);
    expect(writes[0]!.method).toBe('PATCH');
    expect(writes[0]!.url).toContain('/twin/tables/carriers/rows');
    expect(writes[0]!.body).toMatchObject({ primaryKey: { mc_number: '133655' }, updates: { contact_email: 'dispatch@schneider.com', contact_phone: '+13125550142' } });
  });
});
