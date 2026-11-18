// FMCSA QCMobile lookups (authority) and the public FMCSA census (contact on file).
//
// Eligibility rule (R-19): allowedToOperate = "Y" AND (common OR contract authority = "A").
// "Allowed to operate" alone isn't enough: MC 1 is allowed to operate with both authorities inactive.
//
// The census (data.transportation.gov, R-20) is flaky: usually ~0.6 s, sometimes 8+ s or a non-JSON reply
// (R-34). Both clients use short timeouts, one retry, and report "unavailable" instead of guessing.
// The FMCSA web key travels in the URL, so URLs are never logged.

export type FmcsaResult =
  | { kind: 'eligible'; dotNumber: number; legalName: string }
  | { kind: 'inactive_authority'; dotNumber: number; legalName: string }
  | { kind: 'not_allowed_to_operate'; dotNumber: number; legalName: string }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string };

export interface CensusContact {
  dotNumber: number;
  legalName: string;
  phone?: string;   // E.164
  email?: string;
}
export type CensusResult = { kind: 'found'; contact: CensusContact } | { kind: 'not_found' } | { kind: 'unavailable'; reason: string };

export interface HttpOptions {
  timeoutMs?: number;      // per attempt (default 2500)
  maxAttempts?: number;    // default 2
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
}

async function getJson(url: string, label: string, o: HttpOptions): Promise<{ ok: true; status: number; body: unknown } | { ok: false; reason: string }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const attempts = o.maxAttempts ?? 2;
  let reason = 'no_attempt';
  for (let i = 1; i <= attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 2500);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) { reason = `http_${res.status}`; }
      else {
        try { return { ok: true, status: res.status, body: JSON.parse(text) }; }
        catch { reason = 'not_json'; }
      }
    } catch (e) {
      reason = (e as Error).name === 'AbortError' ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }
    o.log?.({ event: `${label}_retry`, attempt: i, reason }); // no URL: it may hold a key
    if (i < attempts) await (o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(150);
  }
  return { ok: false, reason };
}

/** Digits only, 1 to 8 of them ("MC-133655", "mc 133 655" -> "133655"); null if it can't be an MC. */
export function normalizeMc(input: string): string | null {
  const digits = input.replace(/^\s*m\s*c\s*[-#:]?/i, '').replace(/[\s-]/g, '');
  if (!/^\d{1,8}$/.test(digits)) return null;
  const trimmed = digits.replace(/^0+(?=\d)/, '');
  return trimmed;
}

export class FmcsaClient {
  constructor(private readonly webKey: string, private readonly o: HttpOptions = {}) {}

  async lookupMc(mc: string): Promise<FmcsaResult> {
    if (!/^\d{1,8}$/.test(mc)) return { kind: 'not_found' };
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/docket-number/${mc}?webKey=${encodeURIComponent(this.webKey)}`;
    const r = await getJson(url, 'fmcsa', this.o);
    if (!r.ok) return { kind: 'unavailable', reason: r.reason };
    const content = (r.body as { content?: unknown }).content;
    if (typeof content === 'string') return { kind: 'unavailable', reason: content.includes('Webkey') ? 'bad_web_key' : 'fmcsa_error' };
    if (!Array.isArray(content) || content.length === 0) return { kind: 'not_found' };
    const c = (content[0] as { carrier?: Record<string, unknown> }).carrier;
    if (!c || typeof c.dotNumber !== 'number') return { kind: 'unavailable', reason: 'unexpected_shape' };
    const base = { dotNumber: c.dotNumber, legalName: String(c.legalName ?? '').trim() };
    if (c.allowedToOperate !== 'Y') return { kind: 'not_allowed_to_operate', ...base };
    if (c.commonAuthorityStatus === 'A' || c.contractAuthorityStatus === 'A') return { kind: 'eligible', ...base };
    return { kind: 'inactive_authority', ...base };
  }
}

/** 10-digit US numbers (optionally with a leading 1) to E.164; anything else is unusable for SMS. */
export function toE164(raw: string | undefined): string | undefined {
  const d = (raw ?? '').replace(/\D/g, '');
  if (/^[2-9]\d{9}$/.test(d)) return `+1${d}`;
  if (/^1[2-9]\d{9}$/.test(d)) return `+${d}`;
  return undefined;
}

export function validEmail(raw: string | undefined): string | undefined {
  const e = (raw ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254 ? e : undefined;
}

export class CensusClient {
  constructor(private readonly o: HttpOptions = {}) {}

  /** Contact registered with FMCSA for this MC. `expectedDot` must match, or the record isn't trusted. */
  async contactForMc(mc: string, expectedDot?: number): Promise<CensusResult> {
    const q = new URLSearchParams({ docket1prefix: 'MC', docket1: mc, $select: 'dot_number,legal_name,phone,email_address' });
    const r = await getJson(`https://data.transportation.gov/resource/az4n-8mr2.json?${q}`, 'census', this.o);
    if (!r.ok) return { kind: 'unavailable', reason: r.reason };
    if (!Array.isArray(r.body)) return { kind: 'unavailable', reason: 'unexpected_shape' };
    const rows = r.body as Record<string, string>[];
    const row = expectedDot !== undefined ? rows.find((x) => Number(x.dot_number) === expectedDot) : rows[0];
    if (!row) return { kind: 'not_found' };
    return {
      kind: 'found',
      contact: { dotNumber: Number(row.dot_number), legalName: (row.legal_name ?? '').trim(), phone: toE164(row.phone), email: validEmail(row.email_address) },
    };
  }
}
