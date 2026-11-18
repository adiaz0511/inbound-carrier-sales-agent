import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { issueToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { MemoryCallStateStore } from '../src/storage/call-state.js';
import { TmsClient, type TmsFaultMode } from '../src/tms/client.js';
import { detailLine, ok, startFakeTms, summaryLine } from './fake-tms.js';

const base = {
  ENVIRONMENT: 'staging',
  OAUTH_CLIENT_ID: 'happyrobot',
  OAUTH_CLIENT_SECRET: 's'.repeat(40),
  OPS_CLIENT_SECRET: 'o'.repeat(40),
  OAUTH_SIGNING_KEY: 'k'.repeat(40),
  TWIN_WRITER_API_KEY: 'w'.repeat(30),
  TWIN_READER_API_KEY: 'r'.repeat(30),
  FMCSA_WEB_KEY: 'f'.repeat(20),
  OTP_HASH_KEY: 'h'.repeat(40),
  TMS_HOST: '127.0.0.1',
  TMS_PORT: '1',
  TMS_AUTH_TOKEN: 't',
  TMS_TIMEOUT_MS: '1',
  TMS_MAX_ATTEMPTS: '2',
};

const expectedFailures: Record<Exclude<TmsFaultMode, 'off'>, object> = {
  down: { ok: false, error: { kind: 'unavailable', reason: 'socket_error' } },
  timeout: { ok: false, error: { kind: 'unavailable', reason: 'timeout' } },
  garbage: { ok: false, error: { kind: 'unavailable', reason: 'malformed' } },
};

let fake: Awaited<ReturnType<typeof startFakeTms>> | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await fake?.close();
  fake = undefined;
});

describe('TMS fault switch configuration', () => {
  it('refuses a non-off mode in production', () => {
    expect(() => loadConfig({ ...base, ENVIRONMENT: 'production', TMS_FAULT_MODE: 'down' }))
      .toThrow(/TMS_FAULT_MODE must be off in production/);
  });

  it('defaults to off', () => {
    expect(loadConfig(base).TMS_FAULT_MODE).toBe('off');
  });
});

describe.each(Object.entries(expectedFailures) as [Exclude<TmsFaultMode, 'off'>, object][])(
  'staging mode %s',
  (mode, expected) => {
    it('uses the normal adapter failure path for search, get, and book without touching the TMS', async () => {
      fake = await startFakeTms((req) => req.cmd === 'LOAD_GET' ? ok(detailLine()) : ok(summaryLine()));
      const events: Record<string, unknown>[] = [];
      const client = new TmsClient({
        host: '127.0.0.1', port: fake.port, token: 't', timeoutMs: 1,
        maxAttempts: 2, backoffMs: 0, budgetMs: 100, faultMode: mode,
        log: (event) => events.push(event),
      });

      expect(await client.searchLoads({ EQTYPE: 'FLATBED' })).toEqual(expected);
      expect(await client.getLoad('LD01075')).toEqual(expected);
      expect(await client.bookLoad('LD01075', '133655', 2100)).toEqual(expected);
      expect(fake.requests).toHaveLength(0);
      expect(events.filter((event) => event.event === 'tms_fault_injected')).toEqual([
        { event: 'tms_fault_injected', mode, operation: 'search' },
        { event: 'tms_fault_injected', mode, operation: 'get' },
        { event: 'tms_fault_injected', mode, operation: 'book' },
      ]);
    });
  },
);

describe('staging mode off', () => {
  it('keeps normal search and get behavior', async () => {
    fake = await startFakeTms((req) => req.cmd === 'LOAD_GET' ? ok(detailLine()) : ok(summaryLine()));
    const client = new TmsClient({
      host: '127.0.0.1', port: fake.port, token: 't', timeoutMs: 150,
      maxAttempts: 1, faultMode: 'off',
    });

    expect((await client.searchLoads({ EQTYPE: 'FLATBED' })).ok).toBe(true);
    expect((await client.getLoad('LD01075')).ok).toBe(true);
    expect(fake.requests).toHaveLength(2);
  });
});

describe('HTTP failure mapping', () => {
  it('returns the real-outage 503 body for an injected down mode', async () => {
    fake = await startFakeTms(() => ok(summaryLine()));
    const config = loadConfig({ ...base, TMS_PORT: String(fake.port), TMS_FAULT_MODE: 'down' });
    const state = new MemoryCallStateStore();
    const callId = '00000000-0000-4000-8000-0000000000dd';
    await state.update(callId, (current) => ({ state: { ...current, carrier: { mcNumber: '133655', dotNumber: 1, legalName: 'Test', eligible: true }, verifiedAt: Date.now(), verifiedMc: '133655' }, result: null }));
    app = await buildApp(config, { state });
    const authorization = `Bearer ${await issueToken(config, 'happyrobot')}`;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/loads/search',
      headers: { authorization },
      payload: { call_id: callId, equipment: 'flatbed' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'tms_unavailable',
      retryable: true,
      message: 'The load board is not responding right now.',
    });
    expect(fake.requests).toHaveLength(0);
  });
});
