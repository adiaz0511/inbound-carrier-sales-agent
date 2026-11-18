import { compactDetail, humanize, isoOf, money, numOrNull } from './format';

type Detail = Record<string, unknown>;

function detailOf(raw: unknown): Detail {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Detail : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Detail : {};
}

function pick(detail: Detail, ...keys: string[]): unknown {
  return keys.map((key) => detail[key]).find((value) => value !== null && value !== undefined && value !== '');
}

function text(value: unknown, fallback = 'unknown'): string {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function dollars(value: unknown): string {
  const amount = numOrNull(value);
  return amount === null ? 'an unspecified rate' : money(amount);
}

function shortTime(value: unknown): string {
  const iso = isoOf(value);
  if (!iso) return text(value, 'an unspecified time');
  return new Date(iso).toISOString().slice(11, 16);
}

function maskedContact(value: unknown): string {
  const contact = text(value, 'saved contact');
  const at = contact.indexOf('@');
  if (at > 0) return `${contact.charAt(0)}•••${contact.slice(at)}`;
  const digits = contact.replace(/\D/g, '');
  if (digits.length >= 4) return `•••${digits.slice(-4)}`;
  return contact;
}

export function eventSentence(type: string, raw: unknown): string {
  const detail = detailOf(raw);
  switch (type) {
    case 'fmcsa_checked': {
      const rawResult = pick(detail, 'result', 'status', 'eligibility', 'eligible');
      const result = rawResult === true || rawResult === 'true'
        ? 'eligible'
        : rawResult === false || rawResult === 'false'
          ? 'not eligible'
          : text(rawResult, 'checked');
      const mc = pick(detail, 'mc_number', 'mc');
      return `FMCSA check: ${humanize(result).toLowerCase()}${mc ? ` (MC ${mc})` : ''}`;
    }
    case 'code_sent': {
      const channel = text(pick(detail, 'channel', 'method'), 'contact');
      const destination = maskedContact(pick(detail, 'masked_destination', 'destination', 'email', 'phone'));
      return `Code sent by ${channel} to ${destination}`;
    }
    case 'code_verified':
      return 'Verification code accepted';
    case 'offer': {
      const asked = dollars(pick(detail, 'carrier_offer_usd', 'offer_usd', 'asked_usd', 'offer'));
      const counter = dollars(pick(detail, 'counter_usd', 'our_counter_usd', 'counter'));
      const round = pick(detail, 'round', 'counter_round');
      return `Carrier asked ${asked} → countered ${counter}${round ? ` (round ${round})` : ''}`;
    }
    case 'reserved': {
      const load = text(pick(detail, 'load_id', 'loadId'), 'Load');
      const rate = dollars(pick(detail, 'agreed_rate_usd', 'price_usd', 'rate_usd', 'rate'));
      const until = pick(detail, 'expires_at', 'hold_until', 'reserved_until', 'hold_expires_at');
      return `${load === 'Load' ? load : `Load ${load}`} held at ${rate}${until ? ` (hold until ${shortTime(until)})` : ''}`;
    }
    case 'released':
      return `Hold released${pick(detail, 'reason') ? `: ${text(detail.reason)}` : ''}`;
    case 'confirmed': {
      const load = pick(detail, 'load_id', 'loadId');
      return `${load ? `Load ${load}` : 'Load'} booked`;
    }
    case 'tms_unavailable':
      return 'Load board unavailable; the call could not continue';
    case 'transfer':
    case 'transferred': {
      return 'Handed to senior rep';
    }
    case 'call_ended':
      return `Call ended: ${humanize(text(pick(detail, 'outcome', 'status'), 'completed')).toLowerCase()}`;
    default: {
      const compact = compactDetail(raw);
      return compact ? `${humanize(type)}: ${compact}` : humanize(type);
    }
  }
}

export function rawEventDetail(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return JSON.stringify(raw ?? null, null, 2);
}
