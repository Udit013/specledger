import { describe, expect, it } from 'vitest';

import { candidate, PUMP_PAGE, pumpField } from '../test/verifier-fixtures.js';
import { verifyCandidate } from './verifier.js';

// Value-unit pairing. A unit belongs to the number written immediately before it (at most one
// space between them), and a candidate is only proven when its quote states its value bound to
// its unit. The rule is grammatical, not a distance heuristic: a number with no unit right after
// it binds to nothing, so such a claim fails safe.
const reasons = (
  name: string,
  value: string,
  unit: string,
  quote: string,
  page = `Pump\n${quote}`,
) => verifyCandidate(candidate(name, value, unit, quote), page, pumpField(name)).reasons;

describe('value-unit pairing: correct pairs verify', () => {
  it.each([
    ['a value and its unit', 'rated_flow', '287.0', 'm³/h', 'Rated flow: 287.0 m³/h'],
    [
      'a unit written without a space',
      'efficiency',
      '78.5',
      '%',
      'Efficiency: 78.5%, at duty point',
    ],
    ['a unit before sentence punctuation', 'rated_head', '45.2', 'm', 'The rated head is 45.2 m.'],
    [
      'an alias of the quoted unit',
      'rated_flow',
      '1264',
      'US gpm',
      'Rated flow: 287.0 m³/h (1264 gpm)',
    ],
    [
      'a range with its unit',
      'rated_speed',
      '2900 to 3600',
      'rpm',
      'Rated speed: 2900 to 3600 rpm',
    ],
  ])('%s', (_case, name, value, unit, quote) => {
    expect(reasons(name, value, unit, quote)).toEqual([]);
  });
});

describe('value-unit pairing: dual-unit statements', () => {
  const quote = 'Rated flow: 287.0 m³/h (1264 gpm)';

  it('verifies each statement with its own unit', () => {
    expect(reasons('rated_flow', '287.0', 'm³/h', quote)).toEqual([]);
    expect(reasons('rated_flow', '1264', 'gpm', quote)).toEqual([]);
  });

  it('rejects the primary value offered in the secondary unit', () => {
    expect(reasons('rated_flow', '287.0', 'gpm', quote)).toEqual(['UNIT_MISMATCH']);
  });

  it('rejects the parenthetical value offered in the primary unit', () => {
    expect(reasons('rated_flow', '1264', 'm³/h', quote)).toEqual(['UNIT_MISMATCH']);
  });

  it('still reports a disagreeing dual statement once', () => {
    const disagreeing = 'Rated flow: 287.0 m³/h (1364 gpm)';
    expect(reasons('rated_flow', '1364', 'm³/h', disagreeing)).toEqual(['UNIT_MISMATCH']);
  });
});

describe('value-unit pairing: several numbers and units in one quote', () => {
  const quote = 'Rated power: 45.0 kW at 2900 rpm';

  it('binds each number to its own unit', () => {
    expect(reasons('rated_power', '45.0', 'kW', quote)).toEqual([]);
  });

  it('rejects a number taken from another quantity in the same quote', () => {
    expect(reasons('rated_power', '2900', 'kW', quote)).toEqual(['UNIT_MISMATCH']);
  });

  it('rejects a flow figure offered as a head in metres', () => {
    expect(reasons('rated_head', '287.0', 'm', 'Rated flow: 287.0 m³/h (1264 gpm)')).toEqual([
      'UNIT_MISMATCH',
    ]);
  });

  it('accepts the value where it is bound, even if it also appears elsewhere unbound', () => {
    expect(reasons('rated_head', '45', 'm', 'Pump size 45, rated head 45 m')).toEqual([]);
  });
});

describe('value-unit pairing: numbers near a unit but not bound to it', () => {
  it.each([
    [
      'a model number before an unrelated unit',
      'rated_flow',
      '500',
      'm3/h',
      'Model 500 pump, flow 113.6 m3/h',
    ],
    [
      'a number followed by a word, then the unit',
      'rated_flow',
      '500',
      'gpm',
      'Rated flow 500 nominal gpm',
    ],
    ['a unit in a header before the number', 'rated_flow', '287', 'm3/h', 'Rated flow (m3/h): 287'],
    [
      'a unit in parentheses after the number',
      'rated_flow',
      '500',
      'gpm',
      'Rated flow 500 (gpm) nominal',
    ],
  ])('rejects %s with UNIT_MISMATCH', (_case, name, value, unit, quote) => {
    expect(reasons(name, value, unit, quote)).toEqual(['UNIT_MISMATCH']);
  });
});

describe('numbers inside identifiers are not numbers', () => {
  it.each([
    ['a tag number', 'rated_flow', '101', 'gpm', 'Equipment tag: P-101 gpm series'],
    ['the digit of a unit symbol', 'rated_flow', '3', 'gpm', 'Rated flow 248,6 m3/h (1095 gpm)'],
    ['a nominal size', 'rated_head', '100', 'm', 'Flange DN100 m series, head 45.2 m'],
  ])('ignores %s, so the value is not in the quote', (_case, name, value, unit, quote) => {
    expect(reasons(name, value, unit, quote)).toEqual(['VALUE_NOT_IN_QUOTE']);
  });

  it('still reads numbers after punctuation and signs', () => {
    expect(
      reasons('design_temperature', '-20', '°C', 'Design temperature: -20 °C minimum'),
    ).toEqual([]);
    expect(reasons('rated_flow', '287.0', 'm³/h', 'Rated flow:287.0 m³/h nominal')).toEqual([]);
  });
});

describe('value-unit pairing does not change other rules', () => {
  it('keeps VALUE_NOT_IN_QUOTE for a value that is not in the quote at all', () => {
    expect(reasons('rated_flow', '290', 'm³/h', 'Rated flow: 287.0 m³/h (1264 gpm)')).toEqual([
      'VALUE_NOT_IN_QUOTE',
    ]);
  });

  it('keeps UNIT_UNKNOWN alone for a unit outside the registry', () => {
    expect(reasons('rated_flow', '287.0', 'm3/day', 'Rated flow: 287.0 m³/h (1264 gpm)')).toEqual([
      'UNIT_UNKNOWN',
    ]);
  });

  it('keeps the quote span of the page', () => {
    const result = verifyCandidate(
      candidate('rated_flow', '287.0', 'm³/h', 'Rated flow: 287.0 m³/h (1264 gpm)'),
      PUMP_PAGE,
      pumpField('rated_flow'),
    );
    expect(result.status).toBe('verified');
    const span = result.quoteSpan ?? { start: 0, end: 0 };
    expect(PUMP_PAGE.slice(span.start, span.end)).toBe('Rated flow: 287.0 m³/h (1264 gpm)');
  });
});
