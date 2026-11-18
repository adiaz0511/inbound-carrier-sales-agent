import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Config } from './config.js';

// OAuth 2.0 client credentials (RFC 6749 section 4.4), decisions D-016 and D-027.
//
//   POST /oauth/token   client_id + client_secret  ->  short-lived signed access token (JWT)
//   every other route   Authorization: Bearer <token>
//
// Two clients, each with exactly one scope (D-027):
//   workflow client (OAUTH_CLIENT_ID)  -> 'carrier-calls'  the HappyRobot agent's routes
//   ops client (OPS_CLIENT_ID)         -> 'ops'            the ops dashboard's routes and senior-rep actions
//
// The long-lived client secret crosses the network only to get a token. Each token is signed
// (HS256 via the jose library, never hand-rolled crypto), names this environment as issuer and
// audience, carries the scope of its client, and expires in OAUTH_TOKEN_TTL_SECONDS (15 minutes by default).

export const TOKEN_PATH = '/oauth/token';
export const SCOPES = ['carrier-calls', 'ops'] as const;
export type Scope = (typeof SCOPES)[number];

// Routes that need the 'ops' scope: the whole ops API, and the two senior-rep reservation actions.
// Matched case-insensitively with an optional trailing slash, so a variant of the path can't slip past.
const OPS_ROUTES = /^\/v1\/(ops\/|reservations\/(confirm|release)\/?$)/i;
export const requiredScope = (path: string): Scope => (OPS_ROUTES.test(path) ? 'ops' : 'carrier-calls');

const enc = new TextEncoder();
const digest = (s: string) => createHash('sha256').update(s).digest();
// Short key id so a rotation can tell which key signed a token, without revealing the key.
const keyId = (key: string) => digest(key).toString('hex').slice(0, 12);

// Constant-time comparison of two strings via their SHA-256 digests (equal length by construction).
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function issuer(config: Config): string {
  return `carrier-sales-${config.ENVIRONMENT}`;
}

// The two OAuth clients and the one scope each may hold.
function clientsOf(config: Config) {
  return [
    { id: config.OAUTH_CLIENT_ID, secret: config.OAUTH_CLIENT_SECRET, scope: 'carrier-calls' as const },
    { id: config.OPS_CLIENT_ID, secret: config.OPS_CLIENT_SECRET, scope: 'ops' as const },
  ];
}

type Credentials = { clientId: string; clientSecret: string } | null;

// Accepts both standard ways of sending client credentials:
// client_secret_basic (Authorization: Basic) and client_secret_post (form fields).
function readCredentials(request: FastifyRequest): Credentials {
  const header = request.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep === -1) return null;
    try {
      // RFC 6749 section 2.3.1: both parts are form-urlencoded before base64.
      return { clientId: decodeURIComponent(decoded.slice(0, sep)), clientSecret: decodeURIComponent(decoded.slice(sep + 1)) };
    } catch {
      return null;
    }
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (typeof body.client_id === 'string' && typeof body.client_secret === 'string') {
    return { clientId: body.client_id, clientSecret: body.client_secret };
  }
  return null;
}

export async function issueToken(config: Config, clientId: string): Promise<string> {
  const client = clientsOf(config).find((c) => c.id === clientId);
  if (!client) throw new Error('issueToken: unknown OAuth client');
  return new SignJWT({ scope: client.scope })
    .setProtectedHeader({ alg: 'HS256', kid: keyId(config.OAUTH_SIGNING_KEY) })
    .setIssuer(issuer(config))
    .setAudience(issuer(config))
    .setSubject(clientId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${config.OAUTH_TOKEN_TTL_SECONDS}s`)
    .sign(enc.encode(config.OAUTH_SIGNING_KEY));
}

export type TokenCheck = { ok: true; clientId: string; scope: Scope } | { ok: false; reason: string };

export async function verifyToken(config: Config, token: string): Promise<TokenCheck> {
  const keys = [config.OAUTH_SIGNING_KEY, config.OAUTH_SIGNING_KEY_PREVIOUS].filter((k): k is string => !!k);
  for (const key of keys) {
    try {
      const { payload } = await jwtVerify(token, enc.encode(key), {
        algorithms: ['HS256'], // never accept "none" or a different algorithm
        issuer: issuer(config),
        audience: issuer(config),
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      });
      const client = clientsOf(config).find((c) => c.id === payload.sub);
      if (!client) return { ok: false, reason: 'unknown_client' };
      // The scope must be the one this client is entitled to, nothing else.
      if (payload.scope !== client.scope) return { ok: false, reason: 'wrong_scope' };
      return { ok: true, clientId: client.id, scope: client.scope };
    } catch (e) {
      if (e instanceof joseErrors.JWSSignatureVerificationFailed) continue; // try the previous key
      if (e instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
      if (e instanceof joseErrors.JWTClaimValidationFailed) return { ok: false, reason: `bad_claim_${e.claim}` };
      return { ok: false, reason: 'malformed' };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}

export function registerAuth(app: FastifyInstance, config: Config): void {
  // Failed attempts are logged with a reason and the caller's IP, never with a secret or token.
  const deny = (request: FastifyRequest, reason: string, clientId?: string) =>
    request.log.warn({ event: 'auth_failed', reason, ip: request.ip, clientId }, 'authentication failed');

  app.post(TOKEN_PATH, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache'); // RFC 6749 section 5.1
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.grant_type !== 'client_credentials') {
      deny(request, 'unsupported_grant_type');
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    const creds = readCredentials(request);
    const given = creds ?? { clientId: '', clientSecret: '' };
    // Both clients are compared on every attempt (no early exit), so timing does not show which one matched.
    const matches = clientsOf(config).map((c) => {
      const idOk = safeEqual(given.clientId, c.id);
      const secretOk = safeEqual(given.clientSecret, c.secret);
      return creds !== null && idOk && secretOk ? c : undefined;
    });
    const client = matches.find((c) => c !== undefined);
    if (!client) {
      deny(request, 'invalid_client', creds?.clientId);
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="token"').send({ error: 'invalid_client' });
    }
    return {
      access_token: await issueToken(config, client.id),
      token_type: 'Bearer',
      expires_in: config.OAUTH_TOKEN_TTL_SECONDS,
      scope: client.scope,
    };
  });

  // Every route except the token endpoint requires a valid access token, including /health
  // and routes that don't exist (no route discovery without a token).
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === TOKEN_PATH || request.url.startsWith(`${TOKEN_PATH}?`)) return;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      deny(request, 'missing_token');
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    }
    const result = await verifyToken(config, header.slice(7).trim());
    if (!result.ok) {
      deny(request, result.reason);
      return reply.code(401).header('WWW-Authenticate', 'Bearer error="invalid_token"').send({ error: 'unauthorized' });
    }
    // Scope is checked per route, before the route runs (so even a path that doesn't exist gets 403, not 404).
    // Decide on the route the router actually matched (its pattern), not the raw text of the URL, so an
    // encoded or oddly written path (/v1/%6Fps/..., //v1/ops) can't route to an ops handler under the wrong
    // scope. Unmatched paths fall back to the decoded, slash-collapsed path.
    const raw = request.url.split('?')[0]!;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* malformed escape: keep raw */ }
    const path = request.routeOptions?.url ?? decoded.replace(/\/{2,}/g, '/');
    if (result.scope !== requiredScope(path)) {
      deny(request, 'insufficient_scope', result.clientId);
      return reply.code(403).header('WWW-Authenticate', 'Bearer error="insufficient_scope"').send({ error: 'insufficient_scope' });
    }
    request.auth = { clientId: result.clientId, scope: result.scope };
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { clientId: string; scope: Scope };
  }
}
