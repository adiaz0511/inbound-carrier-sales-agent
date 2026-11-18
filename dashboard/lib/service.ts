import 'server-only';

// The only code that talks to the carrier sales service. Runs on the server (server components, route
// handlers, server actions). The browser never sees the client secret or the token (decisions D-026, D-027).

const TIMEOUT_MS = 10_000;
// Refresh the token this long before it expires, so no request goes out with a token that is about to lapse.
const REFRESH_MARGIN_MS = 60_000;

export type ServiceErrorKind = 'config' | 'unreachable' | 'timeout' | 'http';

/** A failed service call. Carries no secret, no token and no response body; only a short error code. */
export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(kind: ServiceErrorKind, status: number | null, code: string | null = null) {
    super(`service ${kind}${status ? ` (${status})` : ''}${code ? `: ${code}` : ''}`);
    this.name = 'ServiceError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** Short label for an error panel: "503", "unreachable", "timeout", "not configured". Never a stack trace. */
export function describeServiceError(e: unknown): string {
  if (!(e instanceof ServiceError)) return 'unexpected error';
  if (e.kind === 'http') return String(e.status);
  if (e.kind === 'config') return 'not configured';
  return e.kind;
}

type Token = { value: string; expiresAt: number };
let cached: Token | null = null;
let inflight: Promise<string> | null = null;

function settings() {
  const base = process.env.SERVICE_BASE_URL?.trim();
  const clientId = process.env.OPS_CLIENT_ID?.trim();
  const clientSecret = process.env.OPS_CLIENT_SECRET?.trim();
  if (!base || !clientId || !clientSecret) throw new ServiceError('config', null);
  return { base: base.replace(/\/+$/, ''), clientId, clientSecret };
}

type Reply = { ok: boolean; status: number; body: unknown };

/** One HTTP call with the 10 s timeout. The timer covers reading the body too. */
async function send(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null; // a non-JSON body is treated as no body; the status still decides
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    throw new ServiceError(controller.signal.aborted ? 'timeout' : 'unreachable', null);
  } finally {
    clearTimeout(timer);
  }
}

// Only a short lowercase code from the service's { error } field is passed on.
function codeOf(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' && /^[a-z_]{1,64}$/.test(e) ? e : null;
}

async function fetchToken(): Promise<Token> {
  const s = settings();
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId, client_secret: s.clientSecret });
  const res = await send(`${s.base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  });
  if (!res.ok) throw new ServiceError('http', res.status, codeOf(res.body));
  const b = res.body as { access_token?: unknown; expires_in?: unknown } | null;
  if (typeof b?.access_token !== 'string' || typeof b?.expires_in !== 'number') throw new ServiceError('http', 502);
  return { value: b.access_token, expiresAt: Date.now() + b.expires_in * 1000 - REFRESH_MARGIN_MS };
}

/** Returns a cached bearer token, fetching a new one when missing, expiring, or forced. */
export async function getToken(force = false): Promise<string> {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;
  inflight ??= fetchToken()
    .then((t) => {
      cached = t;
      return t.value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const url = `${settings().base}${path}`;
  const attempt = async (token: string) =>
    send(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res = await attempt(await getToken());
  if (res.status === 401) {
    // The token may have been revoked or rotated: fetch a fresh one and retry once. A 401 means the request was not processed.
    res = await attempt(await getToken(true));
  }
  if (!res.ok) throw new ServiceError('http', res.status, codeOf(res.body));
  return res.body as T;
}

/** GET an ops route. `path` must be built from validated values (encode ids with encodeURIComponent). */
export function opsGet<T>(path: string): Promise<T> {
  return call<T>('GET', path);
}

/** POST to an ops route. Some routes answer 200 with { ok: false, reason } for business refusals; callers read that. */
export function opsPost<T>(path: string, body: unknown): Promise<T> {
  return call<T>('POST', path, body);
}
