import { describe, expect, it } from 'vitest';
import { CallRecords, InvalidRecord, TwinWriteError, TwinWriter, maskContact } from '../src/storage/twin.js';
import { FirestoreCallStateStore, MemoryCallStateStore, type CallStateStore } from '../src/storage/call-state.js';

// --- Twin writer --------------------------------------------------------------------------------

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = responses.shift() ?? new Response('{}', { status: 201 });
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const writer = (fetchImpl: typeof fetch) =>
  new TwinWriter({ apiKey: 'key', environment: 'staging', fetchImpl, sleep: async () => {}, timeoutMs: 200 });

describe('Twin writer', () => {
  it('sends every value as text, targets the right environment, and fills a UUID key', async () => {
    const f = fakeFetch([]);
    const id = await writer(f.fn).insert('offers', { call_id: 'c', round: 2, carrier_offer_usd: 2100, decision: 'counter' }, 'offer_id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.calls[0]!.url).toBe('https://platform.happyrobot.ai/api/v2/twin/tables/offers/rows');
    expect((f.calls[0]!.init.headers as Record<string, string>)['x-twin-environment']).toBe('staging');
    expect(f.calls[0]!.body).toEqual({ values: { call_id: 'c', round: '2', carrier_offer_usd: '2100', decision: 'counter', offer_id: id } });
  });

  it('writes objects as JSON text, dates as UTC, and leaves out empty values', async () => {
    const f = fakeFetch([]);
    await writer(f.fn).insert('call_events', { call_id: 'c', occurred_at: new Date('2026-11-09T10:00:00Z'), type: 'search', detail: { n: 2 }, x: undefined, y: null }, 'event_id');
    const v = (f.calls[0]!.body as { values: Record<string, string> }).values;
    expect(v.occurred_at).toBe('2026-11-09T10:00:00.000');
    expect(v.detail).toBe('{"n":2}');
    expect('x' in v || 'y' in v).toBe(false);
  });

  it('retries server errors and timeouts, then succeeds', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const f = fakeFetch([new Response('boom', { status: 503 }), abort, new Response('{}', { status: 201 })]);
    await writer(f.fn).insert('calls', { call_id: 'c' });
    expect(f.calls).toHaveLength(3);
  });

  it('does not retry a request the API rejects (4xx)', async () => {
    const f = fakeFetch([new Response('violates check constraint', { status: 400 })]);
    await expect(writer(f.fn).insert('calls', { call_id: 'c', outcome: 'bogus' })).rejects.toBeInstanceOf(TwinWriteError);
    expect(f.calls).toHaveLength(1);
  });

  it('treats "duplicate key" on a retry as success (the first attempt landed)', async () => {
    const f = fakeFetch([new Response('', { status: 502 }), new Response('duplicate key value violates unique constraint', { status: 400 })]);
    await expect(writer(f.fn).insert('offers', { call_id: 'c' }, 'offer_id')).resolves.toBeTruthy();
  });

  it('starting the same call twice is harmless (the workflow may repeat a step)', async () => {
    const f = fakeFetch([new Response('duplicate key value violates unique constraint "calls_pkey"', { status: 400 })]);
    await expect(new CallRecords(writer(f.fn), 'staging').startCall('00000000-0000-4000-8000-000000000001')).resolves.toBeUndefined();
  });

  it('gives up after the attempt limit with a clear error', async () => {
    const f = fakeFetch([new Response('', { status: 500 }), new Response('', { status: 500 }), new Response('', { status: 500 })]);
    await expect(writer(f.fn).update('calls', { call_id: 'c' }, { outcome: 'booked' })).rejects.toThrow(/calls/);
  });

  it('refuses table names that could alter the URL', async () => {
    const f = fakeFetch([]);
    await expect(writer(f.fn).insert('calls/../x', {})).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it('records margin as ceiling minus agreed rate', async () => {
    const f = fakeFetch([]);
    await new CallRecords(writer(f.fn), 'staging').pricing('c', 'LD1', 2037, 2274, 2150);
    expect((f.calls[0]!.body as { values: Record<string, string> }).values.margin_vs_ceiling_usd).toBe('124');
  });

  it('rejects values the schema would refuse before sending anything (Twin answers those with a generic 500)', async () => {
    const f = fakeFetch([]);
    const rec = new CallRecords(writer(f.fn), 'staging');
    await expect(rec.updateCall('c', { outcome: 'made_up' as never })).rejects.toBeInstanceOf(InvalidRecord);
    await expect(rec.updateCall('c', { counter_rounds: 4 })).rejects.toBeInstanceOf(InvalidRecord);
    await expect(rec.updateCall('c', { extra_column: 1 } as never)).rejects.toBeInstanceOf(InvalidRecord);
    await expect(rec.offer('c', 'LD1', 4, 2000, 'counter')).rejects.toBeInstanceOf(InvalidRecord);
    expect(f.calls).toHaveLength(0);
  });

  it('masks contact details for the audit trail', () => {
    expect(maskContact('+13125550142')).toBe('+1••••••••42');
    expect(maskContact('jane@acme.com')).toBe('j•••@acme.com');
  });
});

// --- Call-state store contract: same tests for every implementation ---------------------------

function contract(name: string, make: () => CallStateStore, timeoutMs = 5000) {
  describe(`call-state store contract: ${name}`, () => {
    const id = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    it('starts empty and returns what was written', async () => {
      const s = make(); const c = id();
      expect(await s.get(c)).toBeNull();
      await s.update(c, (st) => ({ state: { ...st, mcNumber: '133655' }, result: null }));
      expect((await s.get(c))?.mcNumber).toBe('133655');
      await s.delete(c);
    });

    it('keeps a counter exact under 20 concurrent updates', async () => {
      const s = make(); const c = id();
      await Promise.all(Array.from({ length: 20 }, () =>
        s.update(c, (st) => ({ state: { ...st, negotiation: { loadId: 'LD1', rounds: (st.negotiation?.rounds ?? 0) + 1 } }, result: null }))));
      expect((await s.get(c))?.negotiation?.rounds).toBe(20);
      await s.delete(c);
    }, timeoutMs * 6); // heavy contention on one record: transactions retry, which takes round trips

    it('ignores state past its expiry', async () => {
      const s = make(); const c = id();
      await s.update(c, (st) => ({ state: { ...st, verified: true, expiresAt: Date.now() - 1 }, result: null }));
      expect(await s.get(c)).toBeNull();
      expect(await s.update(c, (st) => ({ state: st, result: st.verified }))).toBe(false); // starts fresh
      await s.delete(c);
    });

    it('a lock is exclusive, re-entrant for its owner, released by its owner only, and expires', async () => {
      const s = make(); const name = `lock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      expect(await s.tryLock(name, 'a', 60_000)).toBe(true);
      expect(await s.tryLock(name, 'b', 60_000)).toBe(false);
      expect(await s.tryLock(name, 'a', 60_000)).toBe(true);
      await s.releaseLock(name, 'b'); // not the owner: no effect
      expect(await s.tryLock(name, 'b', 60_000)).toBe(false);
      await s.releaseLock(name, 'a');
      expect(await s.tryLock(name, 'b', 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(await s.tryLock(name, 'c', 60_000)).toBe(true); // b's lock expired
      await s.releaseLock(name, 'c');
    }, timeoutMs * 2);

    it('counts per-carrier events inside a rolling window', async () => {
      const s = make(); const mc = `9${Date.now() % 1_000_000}`;
      expect(await s.bumpCarrierCounter(mc, 'code_sends', 60_000)).toBe(1);
      expect(await s.bumpCarrierCounter(mc, 'code_sends', 60_000)).toBe(2);
    });
  });
}

contract('memory', () => new MemoryCallStateStore());

// Runs against real Firestore only when asked (needs Google application-default credentials):
//   FIRESTORE_IT=1 GCP_PROJECT_ID=hr-carrier-sales-ad npx vitest run test/storage.test.ts
if (process.env.FIRESTORE_IT === '1') {
  contract('firestore (live)', () => new FirestoreCallStateStore('it_test', process.env.GCP_PROJECT_ID), 10_000);
}
