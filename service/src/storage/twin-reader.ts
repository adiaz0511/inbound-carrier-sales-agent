// Read-only access to Twin for the ops dashboard (decision D-026).
//
// The Twin SQL endpoint runs any SQL it is given. So the rule in this codebase is strict: every SQL string
// is fixed text, and any value placed into it first passes one of the validators below (sqlInt, sqlUuid,
// sqlMc). Free text (names, notes, initials) never goes into SQL; it is written through the writer API as a
// JSON value instead.

import type { TwinEnvironment } from './twin.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MC_RE = /^[0-9]{1,8}$/;

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/** An integer in [min, max], for interpolating a number into SQL. Throws otherwise. */
export function sqlInt(n: unknown, min: number, max: number): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`sqlInt: expected an integer from ${min} to ${max}`);
  }
  return n;
}

/** A UUID, for interpolating into SQL. Throws otherwise. */
export function sqlUuid(s: unknown): string {
  if (!isUuid(s)) throw new Error('sqlUuid: not a UUID');
  return s;
}

/** A carrier MC number (digits only), for interpolating into SQL. Throws otherwise. */
export function sqlMc(s: unknown): string {
  if (typeof s !== 'string' || !MC_RE.test(s)) throw new Error('sqlMc: not an MC number');
  return s;
}

export interface TwinReaderOptions {
  apiKey: string;
  environment: TwinEnvironment;
  baseUrl?: string;     // default https://platform.happyrobot.ai/api/v2
  fetchImpl?: typeof fetch;
  timeoutMs?: number;   // per request (default 5000)
}

/** A failed read. The message never includes the key. */
export class TwinReadError extends Error {
  constructor(readonly status: number | 'network' | 'bad_response', detail: string) {
    super(`Twin read failed (${status}): ${detail}`);
  }
}

export class TwinReader {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: TwinReaderOptions) {
    this.base = (o.baseUrl ?? 'https://platform.happyrobot.ai/api/v2').replace(/\/$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** Run a fixed SQL statement built only from validated values. Returns the rows. */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 5000);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/twin/sql`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.o.apiKey}`,
            'x-twin-environment': this.o.environment,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sql }),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new TwinReadError('network', (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).name);
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).split(this.o.apiKey).join('[redacted]').slice(0, 300);
        throw new TwinReadError(res.status, text);
      }
      const body = (await res.json().catch(() => null)) as { rows?: unknown } | null;
      if (!body || !Array.isArray(body.rows)) throw new TwinReadError('bad_response', 'no rows array');
      return body.rows as T[];
    } finally {
      clearTimeout(timer);
    }
  }
}
