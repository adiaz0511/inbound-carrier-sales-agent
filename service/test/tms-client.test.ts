import { afterEach, describe, expect, it } from 'vitest';
import { TmsClient } from '../src/tms/client.js';
import { MalformedRecord, parseDetail, parseSummary } from '../src/tms/records.js';
import { detailLine, err, ok, startFakeTms, summaryLine, type Behavior, type FakeRequest } from './fake-tms.js';

let fake: Awaited<ReturnType<typeof startFakeTms>> | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function client(handler: (req: FakeRequest, n: number) => Behavior, extra: Partial<ConstructorParameters<typeof TmsClient>[0]> = {}) {
  fake = await startFakeTms(handler);
  const events: Record<string, unknown>[] = [];
  const c = new TmsClient({ host: '127.0.0.1', port: fake.port, token: 'tok', timeoutMs: 150, backoffMs: 1, budgetMs: 2000, log: (e) => events.push(e), ...extra });
  return { c, events };
}

describe('record parsing (by name, fixed widths, strict types)', () => {
  it('parses a live-format summary and trims padding', () => {
    const s = parseSummary(summaryLine());
    expect(s).toMatchObject({ loadId: 'LD01075', equipment: 'FLATBED', postedRate: 2037, miles: 968, status: 'OPEN' });
    expect(s.origin).toEqual({ city: 'El Paso', state: 'TX', zip: '79901' });
    expect(s.pickupAt.toISOString()).toBe('2026-11-11T05:41:00.000Z');
  });

  it('reads fields by name even if their order changes', () => {
    const shuffled = summaryLine().split('|').reverse().join('|');
    expect(parseSummary(shuffled).loadId).toBe('LD01075');
  });

  it('keeps MAX_BUY internal and tolerates its absence', () => {
    expect(parseDetail(detailLine()).maxBuy).toBe(2274);
    expect(parseDetail(detailLine({}, false)).maxBuy).toBeUndefined();
    expect(parseDetail(detailLine()).notes).toBe('');
  });

  it.each([
    ['a corrupted field name (seen live: XXOMMODITY)', detailLine().replace('COMMODITY:', 'XXOMMODITY:')],
    ['an extra delimiter (empty part)', summaryLine().replace('|MILES', '||MILES')],
    ['a value longer than its width', summaryLine().replace('RATE:2037    ', 'RATE:2037     ')],
    ['a value shorter than its width (cut off)', summaryLine().replace('STATUS:OPEN    ', 'STATUS:OPEN')],
    ['a duplicate field', summaryLine() + '|RATE:2037    '],
    ['a missing field', summaryLine().replace('|MILES:968   ', '')],
    ['a non-number rate', summaryLine().replace('RATE:2037    ', 'RATE:20x7    ')],
    ['an impossible date', summaryLine().replace('PICKUP_DT:20261111054100', 'PICKUP_DT:20261341054100')],
    ['an unknown equipment type', summaryLine().replace('EQTYPE:FLATBED   ', 'EQTYPE:SPACESHIP ')],
  ])('rejects %s', (_name, line) => {
    expect(() => (line.includes('DELIVERY_DT') ? parseDetail(line) : parseSummary(line))).toThrow(MalformedRecord);
  });
});

describe('reads survive each injected fault by retrying', () => {
  const faults: [string, Behavior][] = [
    ['timeout (no reply)', { timeout: true }],
    ['partial reply, closed before END', { partial: summaryLine().slice(0, 90) }],
    ['malformed reply', ok(summaryLine().replace('COMMODITY', 'X').replace('|MILES', '||MILES'))],
    ['connection closed with nothing sent', { closeEmpty: true }],
  ];
  it.each(faults)('%s on the first attempt, then success', async (_n, fault) => {
    const { c, events } = await client((_r, n) => (n === 1 ? fault : ok(summaryLine())));
    const r = await c.searchLoads({ EQTYPE: 'FLATBED' });
    expect(r.ok && r.value.length).toBe(1);
    expect(fake!.requests).toHaveLength(2);
    expect(events.some((e) => e.event === 'tms_fault')).toBe(true);
  });

  it('a reply held open after END is accepted at once (delayed termination)', async () => {
    const { c } = await client(() => ({ holdOpen: summaryLine() + '\r\nEND\r\n' }));
    const started = Date.now();
    const r = await c.searchLoads({ EQTYPE: 'FLATBED' });
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(140); // didn't wait for the timeout
  });

  it('gives up as "unavailable" after the attempt limit', async () => {
    const { c } = await client(() => ({ timeout: true }));
    const r = await c.searchLoads({ EQTYPE: 'FLATBED' });
    expect(r).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'timeout' } });
    expect(fake!.requests).toHaveLength(3);
  });

  it('returns an empty list for a search with no matches', async () => {
    const { c } = await client(() => ({ reply: 'END\r\n' }));
    expect(await c.searchLoads({ ORIG_CITY: 'Boise' })).toEqual({ ok: true, value: [] });
  });
});

describe('TMS refusals are not retried', () => {
  it('an invalid filter is a rejection, sent once', async () => {
    const { c } = await client(() => err('MISSING_FIELD', 'Invalid EQTYPE'));
    expect(await c.searchLoads({ EQTYPE: 'VAN' })).toEqual({ ok: false, error: { kind: 'rejected', code: 'MISSING_FIELD', message: 'Invalid EQTYPE' } });
    expect(fake!.requests).toHaveLength(1);
  });

  it('an unknown load is "null", with either live or spec error code', async () => {
    for (const code of ['NOT_FOUND', 'UNKNOWN_LOAD']) {
      const { c } = await client(() => err(code));
      expect(await c.getLoad('LD99999')).toEqual({ ok: true, value: null });
      await fake!.close(); fake = undefined;
    }
  });

  it('an unknown error code is a safe generic failure, not a crash', async () => {
    const { c } = await client(() => err('SOMETHING_NEW'));
    const r = await c.getLoad('LD01075');
    expect(r.ok).toBe(false);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failed operations and answers instantly while open', async () => {
    const { c, events } = await client(() => ({ closeEmpty: true }), { breakerThreshold: 2, maxAttempts: 1 });
    await c.searchLoads({ EQTYPE: 'REEFER' });
    await c.searchLoads({ EQTYPE: 'REEFER' });
    expect(c.breakerOpen).toBe(true);
    const sent = fake!.requests.length;
    expect(await c.searchLoads({ EQTYPE: 'REEFER' })).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'breaker_open' } });
    expect(fake!.requests.length).toBe(sent); // didn't touch the TMS
    expect(events.some((e) => e.event === 'tms_breaker_open')).toBe(true);
  });
});

describe('booking never double-books and never guesses', () => {
  const confirmed = ok('LOAD_ID:LD01075|BOOKING_REF:BR00000000091277|STATUS:BOOKED  |TIMESTAMP:20261109193122');
  const route = (book: (n: number) => Behavior, status = 'OPEN') => {
    let books = 0;
    return (req: FakeRequest) => (req.cmd === 'LOAD_GET' ? ok(detailLine({ STATUS: status })) : book(++books));
  };

  it('books and returns the reference', async () => {
    const { c } = await client(route(() => confirmed));
    expect(await c.bookLoad('LD01075', '133655', 2100)).toEqual({ ok: true, value: { status: 'booked', bookingRef: 'BR00000000091277', confirmed: true } });
  });

  it('a load already gone before we try is "not available", without sending a booking', async () => {
    const { c } = await client(route(() => confirmed, 'BOOKED'));
    expect(await c.bookLoad('LD01075', '133655', 2100)).toEqual({ ok: true, value: { status: 'not_available' } });
    expect(fake!.requests.filter((r) => r.cmd === 'LOAD_BOOK')).toHaveLength(0);
  });

  it('a timeout then ALREADY_BOOKED means our first attempt landed (token-scoped, monotonic)', async () => {
    const { c } = await client(route((n) => (n === 1 ? { timeout: true } : err('ALREADY_BOOKED'))));
    expect(await c.bookLoad('LD01075', '133655', 2100)).toEqual({ ok: true, value: { status: 'booked', bookingRef: null, confirmed: false } });
  });

  it('ALREADY_BOOKED on a first, clean attempt means someone else got it', async () => {
    const { c } = await client(route(() => err('ALREADY_BOOKED')));
    expect(await c.bookLoad('LD01075', '133655', 2100)).toEqual({ ok: true, value: { status: 'not_available' } });
  });

  it('a garbled success is treated as ambiguous and resolved by one resend', async () => {
    const { c } = await client(route((n) => (n === 1 ? ok('LOAD_ID:LD01075|BOOKING_REF') : err('ALREADY_BOOKED'))));
    expect(await c.bookLoad('LD01075', '133655', 2100)).toEqual({ ok: true, value: { status: 'booked', bookingRef: null, confirmed: false } });
  });

  it('sends at most two bookings, then reports it could not confirm', async () => {
    const { c } = await client(route(() => ({ timeout: true })));
    const r = await c.bookLoad('LD01075', '133655', 2100);
    expect(r).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'booking_unconfirmed' } });
    expect(fake!.requests.filter((q) => q.cmd === 'LOAD_BOOK')).toHaveLength(2);
  });

  it('a rejected rate is reported, not retried', async () => {
    const { c } = await client(route(() => err('INVALID_RATE')));
    expect(await c.bookLoad('LD01075', '133655', 2100)).toEqual({ ok: true, value: { status: 'invalid_rate' } });
    expect(fake!.requests.filter((q) => q.cmd === 'LOAD_BOOK')).toHaveLength(1);
  });

  it('refuses obviously bad input before calling the TMS', async () => {
    const { c } = await client(route(() => confirmed));
    expect((await c.bookLoad('LD01075', '133655', 0)).ok && true).toBe(true);
    expect((await c.bookLoad('LD01075', 'MC|1', 2100)).ok).toBe(false);
    expect(fake!.requests).toHaveLength(0);
  });
});
