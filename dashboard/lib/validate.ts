// Server-side checks for form input. The service validates again; these keep bad input from being sent at all.

const INITIALS = /^[A-Za-z]{1,5}$/;
const LOAD_ID = /^LD\d{1,10}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MC = /^\d{1,8}$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

const text = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v.trim() : '');

export const parseInitials = (v: FormDataEntryValue | null): string | null => (INITIALS.test(text(v)) ? text(v) : null);
export const parseLoadId = (v: FormDataEntryValue | null): string | null => (LOAD_ID.test(text(v)) ? text(v) : null);
export const parseUuid = (v: FormDataEntryValue | null): string | null => (UUID.test(text(v)) ? text(v) : null);
export const parseMc = (v: FormDataEntryValue | null): string | null => (MC.test(text(v)) ? text(v) : null);

/** Free text up to `max` characters; empty becomes undefined. */
export function optionalText(v: FormDataEntryValue | null, max: number): string | undefined {
  const t = text(v);
  return t === '' ? undefined : t.slice(0, max);
}

export const isValidPhone = (v: string): boolean => PHONE.test(v);
export const isValidEmail = (v: string): boolean => EMAIL.test(v);
