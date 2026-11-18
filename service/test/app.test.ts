import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { issueToken, verifyToken } from '../src/auth.js';
import { buildLine } from '../src/tms/wire.js';

const base = {
  ENVIRONMENT: 'staging',
  OAUTH_CLIENT_ID: 'happyrobot',
  OAUTH_CLIENT_SECRET: 's'.repeat(40),
  OAUTH_SIGNING_KEY: 'k'.repeat(40), OPS_CLIENT_SECRET: 'o'.repeat(40), TWIN_READER_API_KEY: 'r'.repeat(30),
  TWIN_WRITER_API_KEY: 'w'.repeat(30), FMCSA_WEB_KEY: 'f'.repeat(20), OTP_HASH_KEY: 'h'.repeat(40), TMS_HOST: '127.0.0.1',
  TMS_PORT: '1',
  TMS_AUTH_TOKEN: 't',
  TMS_TIMEOUT_MS: '200',
};
const config = loadConfig(base);
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const basic = (id: string, secret: string) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

async function getToken(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
    payload: form({ grant_type: 'client_credentials', client_id: 'happyrobot', client_secret: base.OAUTH_CLIENT_SECRET }) });
  return res.json().access_token as string;
}

describe('token endpoint (OAuth2 client credentials)', () => {
  it('issues a short-lived bearer token for valid credentials sent in the body', async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'client_credentials', client_id: 'happyrobot', client_secret: base.OAUTH_CLIENT_SECRET }) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts credentials sent with HTTP Basic too', async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: 'POST', url: '/oauth/token',
      headers: { ...FORM, authorization: basic('happyrobot', base.OAUTH_CLIENT_SECRET) },
      payload: form({ grant_type: 'client_credentials' }) });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong secret and an unknown client', async () => {
    const app = await buildApp(config);
    for (const [id, secret] of [['happyrobot', 'wrong'], ['someone-else', base.OAUTH_CLIENT_SECRET]]) {
      const res = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
        payload: form({ grant_type: 'client_credentials', client_id: id!, client_secret: secret! }) });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_client' });
    }
  });

  it('rejects other grant types', async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'password', client_id: 'happyrobot', client_secret: base.OAUTH_CLIENT_SECRET }) });
    expect(res.statusCode).toBe(400);
  });

  it('rate-limits guessing: the 11th attempt in a minute is refused', async () => {
    const app = await buildApp(config);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
        payload: form({ grant_type: 'client_credentials', client_id: 'happyrobot', client_secret: 'guess' + i }) });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('protected routes', () => {
  it('reject requests with no token, including /health and unknown routes', async () => {
    const app = await buildApp(config);
    for (const url of ['/health', '/v1/diagnostics/tms', '/does-not-exist']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('accept a valid token', async () => {
    const app = await buildApp(config);
    const token = await getToken(app);
    const res = await app.inject({ method: 'GET', url: '/health', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('reject a static secret used as a bearer token (no fallback to the old API key)', async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: 'GET', url: '/health', headers: { authorization: `Bearer ${base.OAUTH_CLIENT_SECRET}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe('token checks', () => {
  const sign = (cfg: Config, claims: Record<string, unknown>, opts: { exp?: string; aud?: string; key?: string; alg?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
      .setIssuer(`carrier-sales-${cfg.ENVIRONMENT}`)
      .setAudience(opts.aud ?? `carrier-sales-${cfg.ENVIRONMENT}`)
      .setSubject('happyrobot').setJti('j').setIssuedAt()
      .setExpirationTime(opts.exp ?? '15m')
      .sign(new TextEncoder().encode(opts.key ?? cfg.OAUTH_SIGNING_KEY));

  it('rejects an expired token', async () => {
    const t = await sign(config, { scope: 'carrier-calls' }, { exp: '-1s' });
    expect(await verifyToken(config, t)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a staging token on production (audience bound to environment)', async () => {
    const prod = loadConfig({ ...base, ENVIRONMENT: 'production' });
    const stagingToken = await issueToken(config, 'happyrobot');
    expect((await verifyToken(prod, stagingToken)).ok).toBe(false);
  });

  it('rejects a token signed with a different key', async () => {
    const t = await sign(config, { scope: 'carrier-calls' }, { key: 'x'.repeat(40) });
    expect(await verifyToken(config, t)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token with the wrong scope', async () => {
    const t = await sign(config, { scope: 'admin' });
    expect(await verifyToken(config, t)).toEqual({ ok: false, reason: 'wrong_scope' });
  });

  it('rejects an unsigned token (alg none)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iss: 'carrier-sales-staging', aud: 'carrier-sales-staging', sub: 'happyrobot', scope: 'carrier-calls', iat: now, exp: now + 600, jti: 'j' })).toString('base64url');
    expect((await verifyToken(config, `${header}.${payload}.`)).ok).toBe(false);
  });

  it('keeps tokens valid across a signing-key rotation', async () => {
    const before = await issueToken(config, 'happyrobot');
    const rotated = loadConfig({ ...base, OAUTH_SIGNING_KEY: 'n'.repeat(40), OAUTH_SIGNING_KEY_PREVIOUS: base.OAUTH_SIGNING_KEY });
    expect((await verifyToken(rotated, before)).ok).toBe(true);
    const afterRetire = loadConfig({ ...base, OAUTH_SIGNING_KEY: 'n'.repeat(40) });
    expect((await verifyToken(afterRetire, before)).ok).toBe(false);
  });
});

describe('config', () => {
  it('refuses to start with a short secret, without echoing it', () => {
    expect(() => loadConfig({ ...base, OAUTH_CLIENT_SECRET: 'short' })).toThrow(/OAUTH_CLIENT_SECRET/);
    expect(() => loadConfig({ ...base, OAUTH_CLIENT_SECRET: 'short' })).not.toThrow(/short/);
  });
});

describe('TMS request line', () => {
  it('builds CMD, AUTH, then fields', () => {
    expect(buildLine('DEBUG_ECHO', 'tok', { MSG: 'hi' })).toBe('CMD:DEBUG_ECHO|AUTH:tok|MSG:hi');
  });

  it('refuses values that would break framing (injection guard)', () => {
    expect(() => buildLine('LOAD_GET', 'tok', { LOAD_ID: 'LD1|CMD:LOAD_BOOK' })).toThrow();
    expect(() => buildLine('LOAD_GET', 'tok', { LOAD_ID: 'LD1\r\n' })).toThrow();
  });

  it('reports an unreachable TMS as a 502, not a crash', async () => {
    const app = await buildApp(config);
    const token = await getToken(app);
    const res = await app.inject({ method: 'GET', url: '/v1/diagnostics/tms', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(502);
    expect(res.json().tms).toBe('unreachable');
  });
});

// Two OAuth clients, one scope each (D-027). Scope is checked per route, before the route runs.
describe('scopes per client (D-027)', () => {
  const tokenResponse = async (app: Awaited<ReturnType<typeof buildApp>>, id: string, secret: string) =>
    app.inject({ method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  const authed = async (token: string) => ({ authorization: `Bearer ${token}` });

  it('the ops client gets an ops token; the workflow client gets a carrier-calls token', async () => {
    const app = await buildApp(config);
    const ops = await tokenResponse(app, config.OPS_CLIENT_ID, base.OPS_CLIENT_SECRET);
    expect(ops.statusCode).toBe(200);
    expect(ops.json().scope).toBe('ops');
    const wf = await tokenResponse(app, 'happyrobot', base.OAUTH_CLIENT_SECRET);
    expect(wf.json().scope).toBe('carrier-calls');
  });

  it('a workflow token gets 403 on the senior-rep confirm route and on an ops path', async () => {
    const app = await buildApp(config);
    const headers = await authed(await issueToken(config, 'happyrobot'));
    const confirm = await app.inject({ method: 'POST', url: '/v1/reservations/confirm', headers, payload: { load_id: 'LD01075', initials: 'AD' } });
    expect(confirm.statusCode).toBe(403);
    expect(confirm.json()).toEqual({ error: 'insufficient_scope' });
    // Any path under /v1/ops/ is ops-only, even one that doesn't exist: the scope check runs first.
    const ops = await app.inject({ method: 'GET', url: '/v1/ops/anything', headers });
    expect(ops.statusCode).toBe(403);
  });

  it('an encoded or doubled-slash path cannot reach an ops route with a workflow token', async () => {
    const app = await buildApp(config);
    const headers = await authed(await issueToken(config, 'happyrobot'));
    for (const url of ['/v1/reservations/%63onfirm', '//v1/reservations/confirm', '/v1/RESERVATIONS/confirm/']) {
      const res = await app.inject({ method: 'POST', url, headers, payload: { load_id: 'LD01075', initials: 'AD' } });
      expect([403, 404]).toContain(res.statusCode); // never reaches the handler with the wrong scope
      expect(res.json()).not.toHaveProperty('ok');
    }
  });

  it('an ops token gets 403 on a carrier route', async () => {
    const app = await buildApp(config);
    const headers = await authed(await issueToken(config, config.OPS_CLIENT_ID));
    const res = await app.inject({ method: 'POST', url: '/v1/loads/search', headers, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('a wrong secret is refused for either client', async () => {
    const app = await buildApp(config);
    for (const id of ['happyrobot', config.OPS_CLIENT_ID]) {
      const res = await tokenResponse(app, id, 'wrong-secret');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_client' });
    }
    // The ops secret does not open the workflow client, and the reverse.
    expect((await tokenResponse(app, 'happyrobot', base.OPS_CLIENT_SECRET)).statusCode).toBe(401);
    expect((await tokenResponse(app, config.OPS_CLIENT_ID, base.OAUTH_CLIENT_SECRET)).statusCode).toBe(401);
  });
});
