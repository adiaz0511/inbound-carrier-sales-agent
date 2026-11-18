import { describe, expect, it } from 'vitest';
import { normalizeCity, normalizeEquipment, normalizeState } from '../src/tms/normalize.js';

const ALL_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
  'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
];

describe('normalizeState', () => {
  it('has all 51 codes listed (50 states + DC)', () => {
    expect(ALL_CODES).toHaveLength(51);
  });

  it.each(ALL_CODES)('maps code %s in upper and lower case', (code) => {
    expect(normalizeState(code)).toBe(code);
    expect(normalizeState(code.toLowerCase())).toBe(code);
  });

  it.each([
    ['georgia', 'GA'],
    ['  GEORGIA ', 'GA'],
    ['New  York', 'NY'],
    ['north   carolina', 'NC'],
    ['WEST VIRGINIA', 'WV'],
    ['new hampshire', 'NH'],
    ['Texas', 'TX'],
    ['rhode island', 'RI'],
    ['Washington', 'WA'],
  ])('maps full name %j to %s', (input, code) => {
    expect(normalizeState(input)).toBe(code);
  });

  it.each([
    'district of columbia',
    'District of Columbia',
    'washington dc',
    'Washington DC',
    'washington d.c.',
    'washington D.C',
    'd.c.',
    'D.C.',
    'dc',
    'DC',
  ])('maps DC variant %j to DC', (input) => {
    expect(normalizeState(input)).toBe('DC');
  });

  it.each(['new', 'carolina', 'virginia beach', 'north', 'dakota', 'cali', 'washingt', 'york', ''])(
    'returns null for partial or unknown input %j',
    (input) => {
      expect(normalizeState(input)).toBeNull();
    },
  );
});

describe('normalizeEquipment', () => {
  it.each([
    ['DRY_VAN', ['dry van', 'van', 'dryvan', '53 dry van', 'box', 'DRY_VAN', 'dry_van', 'Dry-Van']],
    ['REEFER', ['reefer', 'refrigerated', 'refer', 'temp controlled', 'temperature controlled', 'cold', 'REEFER']],
    ['FLATBED', ['flatbed', 'flat bed', 'flat', 'FLATBED', 'Flat  Bed']],
    ['STEP_DECK', ['step deck', 'stepdeck', 'drop deck', 'single drop', 'STEP_DECK', 'step-deck']],
    ['POWER_ONLY', ['power only', 'power-only', 'po', 'tractor only', 'POWER_ONLY', 'power_only']],
  ] as const)('maps every synonym for %s', (code, synonyms) => {
    for (const synonym of synonyms) {
      expect(normalizeEquipment(synonym), synonym).toBe(code);
    }
  });

  it.each(['semi', 'pickup', 'intermodal', '', 'reef', 'flatbeds'])('returns null for unknown equipment %j', (input) => {
    expect(normalizeEquipment(input)).toBeNull();
  });
});

describe('normalizeCity', () => {
  it.each([
    ['new york', 'New York'],
    ['FORT WORTH', 'Fort Worth'],
    ['  los   angeles ', 'Los Angeles'],
    ['chicago', 'Chicago'],
    ["o'fallon", "O'Fallon"],
    ['winston-salem', 'Winston-Salem'],
  ])('title-cases %j to %j', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected);
  });

  it.each([
    ['nyc', 'New York'],
    ['NYC', 'New York'],
    ['new york city', 'New York'],
    ['la', 'Los Angeles'],
    ['philly', 'Philadelphia'],
    ['vegas', 'Las Vegas'],
    ['ft worth', 'Fort Worth'],
    ['ft. worth', 'Fort Worth'],
    ['st louis', 'St. Louis'],
    ['st. louis', 'St. Louis'],
    ['saint louis', 'St. Louis'],
  ])('expands alias %j to %j', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected);
  });

  it('removes "|" characters', () => {
    expect(normalizeCity('Chicago|IL')).toBe('Chicagoil');
    expect(normalizeCity('|Dallas|')).toBe('Dallas');
  });

  it('removes line breaks', () => {
    const cases = ['Dallas\n', 'Dal\r\nlas', 'Dal\nlas', 'Dallas\rTX', 'Dallas\u2028TX'];
    for (const input of cases) {
      const result = normalizeCity(input);
      expect(result).not.toMatch(/[\r\n\u2028\u2029]/);
      expect(result).not.toContain('|');
    }
    expect(normalizeCity('Dallas\r\n')).toBe('Dallas');
  });

  it('never returns a string containing "|" or a line break', () => {
    const result = normalizeCity(' | new\n|york\r\n| ');
    expect(result).not.toMatch(/[|\r\n]/);
  });
});
