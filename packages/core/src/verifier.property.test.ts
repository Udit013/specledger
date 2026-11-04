import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROPERTY_SEED } from '../test/property-seed.js';
import { candidate, PUMP_PAGE, pumpField } from '../test/verifier-fixtures.js';
import { normalizeWithMap } from './normalize.js';
import { verifyCandidate } from './verifier.js';

// Candidates against PUMP_PAGE that exercise different outcomes: verified, and several reasons.
const CASES = [
  candidate('rated_flow', '287.0', 'm³/h', 'Rated flow: 287.0 m³/h (1264 gpm)'),
  candidate('rated_flow', '1264', 'gpm', 'Rated flow: 287.0 m³/h (1264 gpm)'),
  candidate('rated_flow', '290', 'm³/h', 'Rated flow: 287.0 m³/h (1264 gpm)'),
  candidate('rated_head', '45.2', 'ft', 'Rated head: 45.2 m (148.3 ft)'),
  candidate('rated_speed', '2900 to 3600', 'rpm', 'Rated speed: 2900 to 3600 rpm'),
  candidate('design_temperature', '80', '°C', 'Design temperature: 80 °C (176 °F)'),
  candidate('rated_power', '45.0', 'kW', 'Rated power: 45.0 kW at 2900 rpm'),
  candidate('efficiency', '78.5', '%', 'Efficiency: 78.5 %'),
];

// Replaces some of the single spaces and line breaks in `text` with longer whitespace runs.
function respace(text: string, runs: readonly string[]): string {
  let index = 0;
  return text.replace(/[ \n]/g, (gap) => {
    const run = runs[index % runs.length] ?? gap;
    index += 1;
    return run === '' ? gap : run;
  });
}

const whitespaceRuns = fc.array(
  fc.constantFrom('', ' ', '  ', '\n', ' \n ', '\t', '\u00A0', '\r\n', '   \n\n  '),
  { minLength: 1, maxLength: 12 },
);

describe('verifier properties', () => {
  it('gives the same verdict when whitespace and line breaks are added to page and quote', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CASES),
        whitespaceRuns,
        whitespaceRuns,
        (c, pageRuns, quoteRuns) => {
          const field = pumpField(c.fieldName);
          const plain = verifyCandidate(c, PUMP_PAGE, field);
          const spaced = verifyCandidate(
            { ...c, quote: respace(c.quote, quoteRuns) },
            respace(PUMP_PAGE, pageRuns),
            field,
          );
          expect(spaced.status).toBe(plain.status);
          expect(spaced.reasons).toEqual(plain.reasons);
          expect(spaced.normalizedValue).toEqual(plain.normalizedValue);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 400 },
    );
  });

  it('never verifies a candidate whose quote is not on the page', () => {
    const quoteText = fc.oneof(
      fc.string({ maxLength: 60 }),
      fc
        .tuple(
          fc.constantFrom('Rated flow', 'Rated head', 'Efficiency', 'Flow'),
          fc.integer({ min: 1, max: 99999 }),
        )
        .map(([label, n]) => `${label}: ${String(n)} gpm`),
    );
    fc.assert(
      fc.property(quoteText, fc.constantFrom(...CASES), (quote, base) => {
        const page = normalizeWithMap(PUMP_PAGE).normalized;
        fc.pre(!page.includes(normalizeWithMap(quote).normalized));
        const result = verifyCandidate({ ...base, quote }, PUMP_PAGE, pumpField(base.fieldName));
        expect(result.status).toBe('unverified');
        expect(result.reasons).toContain('QUOTE_NOT_FOUND');
        expect(result.quoteSpan).toBeNull();
      }),
      { seed: PROPERTY_SEED, numRuns: 400 },
    );
  });

  it('never throws, and returns a well-formed result, for arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.record({
          fieldName: fc.constantFrom(
            'rated_flow',
            'rated_speed',
            'efficiency',
            'design_temperature',
          ),
          value: fc.string({ maxLength: 20 }),
          unit: fc.string({ maxLength: 8 }),
          quote: fc.string({ maxLength: 80 }),
          page: fc.integer({ min: 1, max: 3 }),
        }),
        fc.string({ maxLength: 200 }),
        (c, page) => {
          const result = verifyCandidate(c, page, pumpField(c.fieldName));
          expect(['verified', 'unverified']).toContain(result.status);
          expect(result.status === 'verified').toBe(result.reasons.length === 0);
          expect(new Set(result.reasons).size).toBe(result.reasons.length);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 500 },
    );
  });
});
