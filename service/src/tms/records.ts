// Parsing and validation of TMS record lines.
//
// The live server sends fixed-width, space-padded values (widths measured from every open load on
// 2026-11-09, R-30; they differ from the spec's samples). The server also injects malformed replies
// on purpose (R-15): extra delimiters, corrupted field names (we saw "XXOMMODITY" and an empty key),
// over-long values. So a record is accepted only if:
//   - every part is KEY:VALUE with a known key, and no key repeats,
//   - every required field is present (optional ones may be absent),
//   - every value has exactly its fixed width (padding included), and
//   - every trimmed value has the expected type.
// Fields are read by name, never by position (field order may change between server builds).
// Anything else is a MalformedRecord, which the client treats as a fault and retries.

import type { EquipmentType } from './normalize.js';

export class MalformedRecord extends Error {
  constructor(reason: string) {
    super(`malformed TMS record: ${reason}`);
  }
}

type Kind = 'id' | 'text' | 'state' | 'zip' | 'datetime' | 'equipment' | 'int' | 'status' | 'notes';
interface FieldSpec { width: number; kind: Kind; optional?: boolean }

const SUMMARY_FIELDS: Record<string, FieldSpec> = {
  LOAD_ID: { width: 12, kind: 'id' },
  ORIG_CITY: { width: 30, kind: 'text' },
  ORIG_STATE: { width: 2, kind: 'state' },
  ORIG_ZIP: { width: 5, kind: 'zip' },
  DEST_CITY: { width: 30, kind: 'text' },
  DEST_STATE: { width: 2, kind: 'state' },
  DEST_ZIP: { width: 5, kind: 'zip' },
  PICKUP_DT: { width: 14, kind: 'datetime' },
  EQTYPE: { width: 10, kind: 'equipment' },
  RATE: { width: 8, kind: 'int' },
  MILES: { width: 6, kind: 'int' },
  STATUS: { width: 8, kind: 'status' },
};

const DETAIL_FIELDS: Record<string, FieldSpec> = {
  ...SUMMARY_FIELDS,
  DELIVERY_DT: { width: 14, kind: 'datetime' },
  WEIGHT: { width: 8, kind: 'int' },
  COMMODITY: { width: 30, kind: 'text' },
  PIECES: { width: 6, kind: 'int' },
  DIMS: { width: 30, kind: 'text' },
  NOTES: { width: 120, kind: 'notes' },
  // The broker's ceiling. Only present for tokens allowed to see it (spec, LOAD_GET). Never leaves the service.
  MAX_BUY: { width: 8, kind: 'int', optional: true },
};

// LOAD_BOOK reply. Never observed live yet (no booking made), so widths are not enforced; types are.
const BOOKING_FIELDS: Record<string, FieldSpec> = {
  LOAD_ID: { width: 0, kind: 'id' },
  BOOKING_REF: { width: 0, kind: 'text' },
  STATUS: { width: 0, kind: 'status' },
  TIMESTAMP: { width: 0, kind: 'datetime' },
};

const EQUIPMENT = new Set(['DRY_VAN', 'REEFER', 'FLATBED', 'STEP_DECK', 'POWER_ONLY']);

function checkValue(key: string, value: string, kind: Kind): string | number | Date {
  const bad = (why: string) => new MalformedRecord(`${key} ${why}`);
  switch (kind) {
    case 'id':
      if (!/^LD\d+$/.test(value)) throw bad('is not a load id');
      return value;
    case 'state':
      if (!/^[A-Z]{2}$/.test(value)) throw bad('is not a state code');
      return value;
    case 'zip':
      if (!/^\d{5}$/.test(value)) throw bad('is not a ZIP');
      return value;
    case 'equipment':
      if (!EQUIPMENT.has(value)) throw bad('is not a known equipment type');
      return value;
    case 'status':
      if (!/^[A-Z_]{2,}$/.test(value)) throw bad('is not a status');
      return value;
    case 'int': {
      if (!/^\d{1,9}$/.test(value)) throw bad('is not a whole number');
      return Number(value);
    }
    case 'datetime': {
      const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
      if (!m) throw bad('is not YYYYMMDDHHMMSS');
      const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
      const date = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
      if (date.getUTCMonth() !== mo! - 1 || date.getUTCDate() !== d! || h! > 23 || mi! > 59 || s! > 59) throw bad('is not a real date');
      return date;
    }
    case 'text':
      if (value.length === 0) throw bad('is empty');
      return value;
    case 'notes':
      return value; // may be blank (spec: a non-trivial fraction ship with NOTES empty)
  }
}

function parseLine(line: string, spec: Record<string, FieldSpec>, enforceWidth: boolean): Record<string, string | number | Date> {
  const out: Record<string, string | number | Date> = {};
  for (const part of line.split('|')) {
    const sep = part.indexOf(':');
    if (sep <= 0) throw new MalformedRecord('part without a KEY:VALUE shape');
    const key = part.slice(0, sep);
    const raw = part.slice(sep + 1);
    const field = spec[key];
    if (!field) throw new MalformedRecord(`unexpected field ${JSON.stringify(key.slice(0, 20))}`);
    if (key in out) throw new MalformedRecord(`duplicate field ${key}`);
    if (enforceWidth && raw.length !== field.width) throw new MalformedRecord(`${key} has width ${raw.length}, expected ${field.width}`);
    out[key] = checkValue(key, raw.trim(), field.kind);
  }
  for (const [key, field] of Object.entries(spec)) {
    if (!field.optional && !(key in out)) throw new MalformedRecord(`missing field ${key}`);
  }
  return out;
}

export interface LoadSummary {
  loadId: string;
  origin: { city: string; state: string; zip: string };
  destination: { city: string; state: string; zip: string };
  pickupAt: Date;
  equipment: EquipmentType;
  postedRate: number;
  miles: number;
  status: string;
}

export interface LoadDetail extends LoadSummary {
  deliveryAt: Date;
  weightLbs: number;
  commodity: string;
  pieces: number;
  dimensions: string;
  notes: string;
  /** Broker ceiling. Internal only: never serialize to an API response. */
  maxBuy: number | undefined;
}

export interface BookingConfirmation {
  loadId: string;
  bookingRef: string;
  status: string;
  bookedAt: Date;
}

function summaryFrom(r: Record<string, string | number | Date>): LoadSummary {
  return {
    loadId: r.LOAD_ID as string,
    origin: { city: r.ORIG_CITY as string, state: r.ORIG_STATE as string, zip: r.ORIG_ZIP as string },
    destination: { city: r.DEST_CITY as string, state: r.DEST_STATE as string, zip: r.DEST_ZIP as string },
    pickupAt: r.PICKUP_DT as Date,
    equipment: r.EQTYPE as EquipmentType,
    postedRate: r.RATE as number,
    miles: r.MILES as number,
    status: r.STATUS as string,
  };
}

export function parseSummary(line: string): LoadSummary {
  return summaryFrom(parseLine(line, SUMMARY_FIELDS, true));
}

export function parseDetail(line: string): LoadDetail {
  const r = parseLine(line, DETAIL_FIELDS, true);
  return {
    ...summaryFrom(r),
    deliveryAt: r.DELIVERY_DT as Date,
    weightLbs: r.WEIGHT as number,
    commodity: r.COMMODITY as string,
    pieces: r.PIECES as number,
    dimensions: r.DIMS as string,
    notes: r.NOTES as string,
    maxBuy: r.MAX_BUY as number | undefined,
  };
}

export function parseBooking(line: string): BookingConfirmation {
  const r = parseLine(line, BOOKING_FIELDS, false);
  return { loadId: r.LOAD_ID as string, bookingRef: r.BOOKING_REF as string, status: r.STATUS as string, bookedAt: r.TIMESTAMP as Date };
}
