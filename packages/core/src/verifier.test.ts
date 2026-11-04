import { describe, expect, it } from 'vitest';

import { candidate, PUMP_PAGE, pumpField } from '../test/verifier-fixtures.js';
import type { Candidate } from './candidate.js';
import type { FieldDefinition } from './equipment.js';
import { normalizeWithMap } from './normalize.js';
import { MIN_QUOTE_LENGTH, verifyCandidate } from './verifier.js';
import type { VerificationHints } from './verifier.js';

const verify = (c: Candidate, page = PUMP_PAGE, hints: VerificationHints = {}) =>
  verifyCandidate(c, page, pumpField(c.fieldName), hints);

const reasons = (c: Candidate, page = PUMP_PAGE, hints: VerificationHints = {}) =>
  verify(c, page, hints).reasons;

const FLOW_QUOTE = 'Rated flow: 287.0 m³/h (1264 gpm)';

describe('verifyCandidate: verified values', () => {
  it('verifies a value that is quoted from the page, with its canonical value and span', () => {
    const result = verify(candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE));
    expect(result.status).toBe('verified');
    expect(result.reasons).toEqual([]);
    expect(result.normalizedValue?.kind).toBe('scalar');
    expect(result.normalizedValue).toMatchObject({ unit: 'm3/s' });
    expect(result.normalizedValue?.kind === 'scalar' && result.normalizedValue.value).toBeCloseTo(
      287 / 3600,
      12,
    );
    expect(result.quoteSpan).not.toBeNull();
    const span = result.quoteSpan ?? { start: 0, end: 0 };
    expect(PUMP_PAGE.slice(span.start, span.end)).toBe(FLOW_QUOTE);
  });

  it('verifies the second unit system of a dual-unit statement', () => {
    expect(verify(candidate('rated_flow', '1264', 'gpm', FLOW_QUOTE)).status).toBe('verified');
    expect(verify(candidate('rated_flow', '1264', 'US gpm', FLOW_QUOTE)).status).toBe('verified');
  });

  it('compares numbers by value, not by spelling', () => {
    expect(verify(candidate('rated_flow', '287', 'm³/h', FLOW_QUOTE)).status).toBe('verified');
  });

  it('verifies a range with both bounds', () => {
    const result = verify(
      candidate('rated_speed', '2900 to 3600', 'rpm', 'Rated speed: 2900 to 3600 rpm'),
    );
    expect(result.status).toBe('verified');
    expect(result.normalizedValue).toEqual({ kind: 'range', low: 2900, high: 3600, unit: 'rpm' });
  });

  it('converts temperatures with their offset', () => {
    const result = verify(
      candidate('design_temperature', '80', '°C', 'Design temperature: 80 °C (176 °F)'),
    );
    expect(result.status).toBe('verified');
    expect(result.normalizedValue?.kind === 'scalar' && result.normalizedValue.value).toBeCloseTo(
      353.15,
      9,
    );
  });

  it('matches the quote whatever its whitespace and unit spelling', () => {
    expect(
      verify(candidate('rated_flow', '287.0', 'm3/h', 'Rated  flow:\n287.0 m3/h (1264\u00A0gpm)'))
        .status,
    ).toBe('verified');
  });

  it('computes the canonical value itself from the value and unit', () => {
    const result = verify(candidate('rated_flow', '1264', 'gpm', FLOW_QUOTE));
    expect(result.normalizedValue?.kind === 'scalar' && result.normalizedValue.value).toBeCloseTo(
      (1264 * 3.785411784e-3) / 60,
      12,
    );
  });
});

describe('verifyCandidate: (a) QUOTE_TOO_SHORT', () => {
  const powerLine = 'Rated power: 45.0 kW at 2900 rpm';
  const ending = (length: number) => powerLine.slice(0, powerLine.indexOf(' at')).slice(-length);

  it('rejects a quote one character under the minimum', () => {
    expect(reasons(candidate('rated_power', '45.0', 'kW', ending(MIN_QUOTE_LENGTH - 1)))).toEqual([
      'QUOTE_TOO_SHORT',
    ]);
  });

  it('accepts a quote of exactly the minimum length', () => {
    expect(reasons(candidate('rated_power', '45.0', 'kW', ending(MIN_QUOTE_LENGTH)))).toEqual([]);
  });

  it('measures the normalized quote, so padding with whitespace does not help', () => {
    const short = ending(MIN_QUOTE_LENGTH - 1);
    expect(
      reasons(candidate('rated_power', '45.0', 'kW', `  ${short.replace(' ', '\n\n\n')}  `)),
    ).toContain('QUOTE_TOO_SHORT');
  });
});

describe('verifyCandidate: (b) QUOTE_NOT_FOUND', () => {
  it('rejects a quote that is not on the page', () => {
    expect(
      reasons(candidate('rated_flow', '288.0', 'm³/h', 'Rated flow: 288.0 m³/h (1264 gpm)')),
    ).toEqual(['QUOTE_NOT_FOUND']);
  });

  it('rejects a quote that is on another page', () => {
    const otherPage = 'Page 2\nRated head: 45.2 m (148.3 ft)';
    expect(reasons(candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE), otherPage)).toEqual([
      'QUOTE_NOT_FOUND',
    ]);
  });

  it('finds a quote that spans a line break on the page', () => {
    expect(
      reasons(
        candidate('rated_flow', '287.0', 'm³/h', 'Equipment tag: P-101 Rated flow: 287.0 m³/h'),
      ),
    ).toEqual([]);
  });

  it('returns no span when the quote is not found', () => {
    expect(
      verify(candidate('rated_flow', '288.0', 'm³/h', 'Rated flow: 288.0 m³/h (1264 gpm)'))
        .quoteSpan,
    ).toBeNull();
  });
});

describe('verifyCandidate: (c) VALUE_NOT_IN_QUOTE and AMBIGUOUS_NUMBER_FORMAT', () => {
  it('rejects a value that is not among the numbers in the quote', () => {
    expect(reasons(candidate('rated_flow', '290', 'm³/h', FLOW_QUOTE))).toEqual([
      'VALUE_NOT_IN_QUOTE',
    ]);
  });

  it('rejects a value that does not parse', () => {
    expect(reasons(candidate('rated_flow', 'about 287', 'm³/h', FLOW_QUOTE))).toEqual([
      'VALUE_NOT_IN_QUOTE',
    ]);
  });

  it('rejects a range whose bounds differ from the quoted range', () => {
    expect(
      reasons(candidate('rated_speed', '2900 to 3700', 'rpm', 'Rated speed: 2900 to 3600 rpm')),
    ).toEqual(['VALUE_NOT_IN_QUOTE']);
  });

  it('rejects one end of a quoted range, which would silently pick a value', () => {
    expect(
      reasons(candidate('rated_speed', '2900', 'rpm', 'Rated speed: 2900 to 3600 rpm')),
    ).toEqual(['VALUE_NOT_IN_QUOTE']);
  });

  const ambiguousPage = 'Centrifugal Pump Datasheet\nRated flow: 1,250 gpm';
  const ambiguous = candidate('rated_flow', '1,250', 'gpm', 'Rated flow: 1,250 gpm');

  it('reports an ambiguous value instead of guessing', () => {
    const result = verify(ambiguous, ambiguousPage);
    expect(result.reasons).toEqual(['AMBIGUOUS_NUMBER_FORMAT']);
    expect(result.normalizedValue).toBeNull();
  });

  it('lets the hint resolve an ambiguous value, in either direction', () => {
    const point = verify(ambiguous, ambiguousPage, { decimalMark: 'point' });
    const comma = verify(ambiguous, ambiguousPage, { decimalMark: 'comma' });
    const gpm = 3.785411784e-3 / 60;
    expect(point.status).toBe('verified');
    expect(point.normalizedValue?.kind === 'scalar' && point.normalizedValue.value).toBeCloseTo(
      1250 * gpm,
      12,
    );
    expect(comma.status).toBe('verified');
    expect(comma.normalizedValue?.kind === 'scalar' && comma.normalizedValue.value).toBeCloseTo(
      1.25 * gpm,
      12,
    );
  });
});

describe('verifyCandidate: (d) UNIT_UNKNOWN and UNIT_MISMATCH', () => {
  it('rejects a unit that is not in the registry', () => {
    const result = verify(candidate('rated_flow', '287.0', 'm3/day', FLOW_QUOTE));
    expect(result.reasons).toEqual(['UNIT_UNKNOWN']);
    expect(result.normalizedValue).toBeNull();
  });

  it('rejects a unit of another dimension', () => {
    expect(reasons(candidate('rated_flow', '45.2', 'm', 'Rated head: 45.2 m (148.3 ft)'))).toEqual([
      'UNIT_MISMATCH',
    ]);
  });

  it('accepts a known alias of the right dimension', () => {
    expect(reasons(candidate('rated_flow', '287.0', 'cu m/h', FLOW_QUOTE))).toEqual([]);
  });
});

describe('verifyCandidate: (e) dual-unit agreement', () => {
  const page = (secondary: string) => `Pump\nRated flow: 287.0 m³/h (${secondary})`;
  const flow = (secondary: string) =>
    candidate('rated_flow', '287.0', 'm³/h', `Rated flow: 287.0 m³/h (${secondary})`);

  it('rejects two unit systems that disagree by more than the tolerance', () => {
    expect(reasons(flow('1364 gpm'), page('1364 gpm'))).toEqual(['UNIT_MISMATCH']);
    expect(reasons(flow('1272 gpm'), page('1272 gpm'))).toEqual(['UNIT_MISMATCH']);
  });

  it('accepts two unit systems that agree within the tolerance', () => {
    expect(reasons(flow('1268 gpm'), page('1268 gpm'))).toEqual([]);
  });

  it('checks temperatures after the offset conversion', () => {
    const line = 'Design temperature: 80 °C (186 °F)';
    expect(reasons(candidate('design_temperature', '80', '°C', line), `Pump\n${line}`)).toEqual([
      'UNIT_MISMATCH',
    ]);
  });

  it('ignores numbers in units of other dimensions', () => {
    expect(
      reasons(candidate('rated_power', '45.0', 'kW', 'Rated power: 45.0 kW at 2900 rpm')),
    ).toEqual([]);
  });

  it('applies to the quote even when the candidate gives the second statement', () => {
    expect(
      reasons(
        candidate('rated_flow', '1364', 'gpm', 'Rated flow: 287.0 m³/h (1364 gpm)'),
        page('1364 gpm'),
      ),
    ).toEqual(['UNIT_MISMATCH']);
  });
});

describe('verifyCandidate: (f) OUT_OF_RANGE', () => {
  const line = (text: string) => `Pump\n${text}`;

  it('rejects a value outside the plausible range', () => {
    const quote = 'Rated flow: 99999 m3/h';
    expect(reasons(candidate('rated_flow', '99999', 'm3/h', quote), line(quote))).toEqual([
      'OUT_OF_RANGE',
    ]);
  });

  it('accepts a value on the bound of the range', () => {
    const quote = 'Efficiency: 100 %, nominal';
    expect(reasons(candidate('efficiency', '100', '%', quote), line(quote))).toEqual([]);
  });

  it('rejects a value just past the bound', () => {
    const quote = 'Efficiency: 100.5 %, nominal';
    expect(reasons(candidate('efficiency', '100.5', '%', quote), line(quote))).toEqual([
      'OUT_OF_RANGE',
    ]);
  });

  it('rejects a range with one bound outside', () => {
    const quote = 'Rated speed: 50 to 3600 rpm';
    expect(reasons(candidate('rated_speed', '50 to 3600', 'rpm', quote), line(quote))).toEqual([
      'OUT_OF_RANGE',
    ]);
  });
});

describe('verifyCandidate: every failing reason, in rule order', () => {
  it('reports all failures, not only the first', () => {
    expect(reasons(candidate('rated_flow', '45', 'furlong', '9 kW pumps'))).toEqual([
      'QUOTE_TOO_SHORT',
      'QUOTE_NOT_FOUND',
      'VALUE_NOT_IN_QUOTE',
      'UNIT_UNKNOWN',
    ]);
  });

  it('reports UNIT_MISMATCH once when the unit and the dual statement both fail', () => {
    const quote = 'Rated flow: 287.0 m³/h (1364 gpm)';
    expect(reasons(candidate('rated_flow', '287.0', 'ft', quote), `Pump\n${quote}`)).toEqual([
      'UNIT_MISMATCH',
    ]);
  });

  it('marks a result verified exactly when no reason fails', () => {
    for (const c of [
      candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE),
      candidate('rated_flow', '290', 'm³/h', FLOW_QUOTE),
    ]) {
      const result = verify(c);
      expect(result.status === 'verified').toBe(result.reasons.length === 0);
    }
  });
});

describe('verifyCandidate: INTERNAL', () => {
  const internal = {
    status: 'unverified',
    reasons: ['INTERNAL'],
    normalizedValue: null,
    quoteSpan: null,
  };

  it('rejects a candidate for a different field', () => {
    const c = candidate('rated_head', '287.0', 'm³/h', FLOW_QUOTE);
    expect(verifyCandidate(c, PUMP_PAGE, pumpField('rated_flow'))).toEqual(internal);
  });

  it('rejects a range for a field that takes a single value', () => {
    const quote = 'Rated power: 40 to 45 kW';
    expect(verify(candidate('rated_power', '40 to 45', 'kW', quote), `Pump\n${quote}`)).toEqual(
      internal,
    );
  });

  it.each<[string, () => ReturnType<typeof verifyCandidate>]>([
    [
      'page text that is not a string',
      () =>
        verifyCandidate(
          candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE),
          undefined as unknown as string,
          pumpField('rated_flow'),
        ),
    ],
    [
      'a candidate that is not an object',
      () => verifyCandidate(null as unknown as Candidate, PUMP_PAGE, pumpField('rated_flow')),
    ],
    [
      'a candidate without a quote',
      () =>
        verifyCandidate(
          {
            ...candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE),
            quote: undefined,
          } as unknown as Candidate,
          PUMP_PAGE,
          pumpField('rated_flow'),
        ),
    ],
    [
      'a field of an unknown dimension',
      () =>
        verifyCandidate(candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE), PUMP_PAGE, {
          ...pumpField('rated_flow'),
          dimension: 'colour',
        } as unknown as FieldDefinition),
    ],
    [
      'a field whose range is not finite',
      () =>
        verifyCandidate(candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE), PUMP_PAGE, {
          ...pumpField('rated_flow'),
          plausibleRange: { min: Number.NaN, max: 10 },
        }),
    ],
  ])('returns INTERNAL, without throwing, for %s', (_case, run) => {
    expect(run).not.toThrow();
    expect(run()).toEqual(internal);
  });
});

describe('verifyCandidate: quote span', () => {
  it('points at the original text, extra whitespace and all', () => {
    const page = 'Pump\nRated   flow:\u00A0287.0\nm³/h (1264 gpm)\nRated head: 45.2 m';
    const result = verify(candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE), page);
    expect(result.status).toBe('verified');
    const span = result.quoteSpan ?? { start: 0, end: 0 };
    expect(page.slice(span.start, span.end)).toBe('Rated   flow:\u00A0287.0\nm³/h (1264 gpm)');
    expect(normalizeWithMap(page.slice(span.start, span.end)).normalized).toBe(
      normalizeWithMap(FLOW_QUOTE).normalized,
    );
  });

  it('points at the first occurrence of a repeated quote', () => {
    const page = `${FLOW_QUOTE}\nNotes\n${FLOW_QUOTE}`;
    expect(verify(candidate('rated_flow', '287.0', 'm³/h', FLOW_QUOTE), page).quoteSpan).toEqual({
      start: 0,
      end: FLOW_QUOTE.length,
    });
  });
});
