// Display helpers. Money is whole dollars in en-US ($1,234); percentages have no decimals.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const money = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : usd.format(v));

export const pct = (v: number | null | undefined): string => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}%`);

export const count = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));

/** Twin text values to a number; empty or missing becomes 0. */
export const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));

/** Twin text values to a number, keeping "no value" as null. */
export const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Twin timestamps arrive as "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. Returns ISO, or null. */
export function isoOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Compact, readable text for a value of unknown shape (event details, offers). Never throws. */
export function compactDetail(raw: unknown, max = 220): string {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return raw.length > max ? `${raw.slice(0, max)}…` : raw;
    }
  }
  if (v === null || v === undefined) return '';
  let text: string;
  if (typeof v === 'object' && !Array.isArray(v)) {
    text = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined && x !== '')
      .map(([k, x]) => `${k.replace(/_/g, ' ')}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`)
      .join('; ');
  } else {
    text = JSON.stringify(v);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const DISPLAY_TEXT: Record<string, string> = {
  booked: 'Booked',
  booked_ref_pending: 'Booking ref pending',
  confirmed: 'Booked',
  declined: 'Declined',
  eligible: 'Eligible',
  expired: 'Expired',
  failed: 'Failed',
  in_progress: 'In progress',
  insufficient_scope: 'Rep needed',
  no_deal: 'No deal',
  no_match: 'No matching load',
  not_eligible: 'Not eligible',
  not_verified: 'Not verified',
  open: 'Open',
  released: 'Released',
  reserved: 'Held',
  test_record: 'Test record',
  tms_unavailable: 'Load board down',
  transferred: 'Transferred',
  under_15_minutes: 'Under 15 minutes',
  verified: 'Verified',
};

/** Converts stored codes to plain, sentence-case dashboard text. */
export const humanize = (s: string | null | undefined): string => {
  if (!s) return '—';
  if (DISPLAY_TEXT[s]) return DISPLAY_TEXT[s];
  const text = s.replace(/_/g, ' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

export const isTestRecord = (notes: string | null | undefined): boolean => notes?.startsWith('Not a carrier call') ?? false;

/** "Buffalo, NY -> Tulsa, OK" -> "Buffalo, NY → Tulsa, OK". */
export function laneText(lane: string | null | undefined): string {
  return lane ? lane.replace(/\s*(?:->|→)\s*/g, ' → ') : '—';
}

/** TMS equipment codes in plain words: DRY_VAN -> "Dry van", FLATBED -> "Flatbed". */
export function equipmentText(equipment: string | null | undefined): string {
  if (!equipment) return '—';
  const normalized = equipment.trim().toUpperCase().replace(/[ -]+/g, '_');
  const known: Record<string, string> = { DRY_VAN: 'Dry van', POWER_ONLY: 'Power only', STEP_DECK: 'Step deck' };
  if (known[normalized]) return known[normalized];
  const readable = equipment.replace(/_/g, ' ').trim().toLowerCase();
  return readable ? `${readable.charAt(0).toUpperCase()}${readable.slice(1)}` : '—';
}
