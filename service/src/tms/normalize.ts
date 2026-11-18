// Why this exists: the legacy TMS matches state and equipment exactly and silently returns nothing
// (or an error) for anything else. Speech gives us "Georgia", "new  york", "reefer", "flat bed" and
// similar forms, so every value must be converted to an exact code before it is sent to the TMS.
// Unrecognized state and equipment input returns null so the caller can ask again instead of
// searching with a value the TMS cannot match.

export type EquipmentType = 'DRY_VAN' | 'REEFER' | 'FLATBED' | 'STEP_DECK' | 'POWER_ONLY';

// 50 states plus DC, as [USPS code, official name].
const STATES: ReadonlyArray<readonly [string, string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
  ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['DC', 'District of Columbia'],
];

const DC_VARIANTS = ['dc', 'd c', 'washington dc', 'washington d c', 'district of columbia'];

const STATE_BY_KEY = new Map<string, string>();
for (const [code, name] of STATES) {
  STATE_BY_KEY.set(code.toLowerCase(), code);
  STATE_BY_KEY.set(name.toLowerCase(), code);
}
for (const variant of DC_VARIANTS) STATE_BY_KEY.set(variant, 'DC');

// Input cleanup for state names: periods removed, whitespace collapsed, lowercased.
function cleanStateKey(input: string): string {
  return input.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Returns the 2-letter USPS code for a state or DC (code or official name), or null. */
export function normalizeState(input: string): string | null {
  return STATE_BY_KEY.get(cleanStateKey(input)) ?? null;
}

const EQUIPMENT_SYNONYMS: ReadonlyArray<readonly [EquipmentType, readonly string[]]> = [
  ['DRY_VAN', ['dry van', 'van', 'dryvan', '53 dry van', 'box']],
  ['REEFER', ['reefer', 'refrigerated', 'refer', 'temp controlled', 'temperature controlled', 'cold']],
  ['FLATBED', ['flatbed', 'flat bed', 'flat']],
  ['STEP_DECK', ['step deck', 'stepdeck', 'drop deck', 'single drop']],
  ['POWER_ONLY', ['power only', 'po', 'tractor only']],
];

const EQUIPMENT_BY_KEY = new Map<string, EquipmentType>();
for (const [code, synonyms] of EQUIPMENT_SYNONYMS) {
  EQUIPMENT_BY_KEY.set(code.replace(/_/g, ' ').toLowerCase(), code);
  for (const synonym of synonyms) EQUIPMENT_BY_KEY.set(synonym, code);
}

// Input cleanup for equipment: hyphens and underscores become spaces, whitespace collapsed, lowercased.
function cleanEquipmentKey(input: string): string {
  return input.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Returns the exact equipment code for a synonym or code (any case), or null. */
export function normalizeEquipment(
  input: string,
): 'DRY_VAN' | 'REEFER' | 'FLATBED' | 'STEP_DECK' | 'POWER_ONLY' | null {
  return EQUIPMENT_BY_KEY.get(cleanEquipmentKey(input)) ?? null;
}

const CITY_ALIASES = new Map<string, string>([
  ['nyc', 'New York'],
  ['new york city', 'New York'],
  ['la', 'Los Angeles'],
  ['philly', 'Philadelphia'],
  ['vegas', 'Las Vegas'],
  ['ft worth', 'Fort Worth'],
  ['ft. worth', 'Fort Worth'],
  ['st louis', 'St. Louis'],
  ['st. louis', 'St. Louis'],
  ['saint louis', 'St. Louis'],
]);

/**
 * Trims, collapses whitespace, title-cases, and expands known aliases. Removes "|" and line breaks
 * so the result is safe to embed in a TMS line-protocol message.
 */
export function normalizeCity(input: string): string {
  // "|" would break TMS framing; line breaks become spaces so words don't run together.
  const cleaned = input.replace(/\|/g, '').replace(/[\r\n\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = cleaned.toLowerCase();
  const alias = CITY_ALIASES.get(lower);
  if (alias !== undefined) return alias;
  return lower.replace(/(^|[\s\-'])(\p{L})/gu, (_match, sep: string, ch: string) => sep + ch.toUpperCase());
}
