import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROPERTY_SEED } from '../test/property-seed.js';
import { compareRevisions, parseRevision } from './revision.js';

// Sign of a comparison, with -0 read as 0: a comparator may return either.
const sign = (n: number) => (n === 0 ? 0 : Math.sign(n));
const same = (a: string | null, b: string | null) => compareRevisions(a, b) === 0;

describe('parseRevision', () => {
  it.each<[string, ReturnType<typeof parseRevision>]>([
    ['Rev A', { kind: 'letter', ordinal: 1 }],
    ['Rev. C', { kind: 'letter', ordinal: 3 }],
    ['rev b', { kind: 'letter', ordinal: 2 }],
    ['REVISION D', { kind: 'letter', ordinal: 4 }],
    ['Z', { kind: 'letter', ordinal: 26 }],
    ['Rev AA', { kind: 'letter', ordinal: 27 }],
    ['R2', { kind: 'number', parts: [2] }],
    ['Rev 2', { kind: 'number', parts: [2] }],
    ['Revision 3', { kind: 'number', parts: [3] }],
    ['0', { kind: 'number', parts: [0] }],
    ['2.1', { kind: 'number', parts: [2, 1] }],
    ['  Rev 10  ', { kind: 'number', parts: [10] }],
  ])('reads %j', (label, expected) => {
    expect(parseRevision(label)).toEqual(expected);
  });

  it.each([null, '', '   ', 'Draft', 'Final', 'Rev', 'Rev ABC', 'Rev 2B', '2.', 'v2', '-1'])(
    'treats %j as unknown',
    (label) => {
      expect(parseRevision(label)).toBeNull();
    },
  );
});

describe('compareRevisions', () => {
  it.each<[string | null, string | null]>([
    ['Rev A', 'A'],
    ['Rev. C', 'rev c'],
    ['R2', 'Rev 2'],
    ['Revision 3', '3'],
    ['  Rev B ', 'B'],
    ['2', '2.0'],
    [null, 'Draft'],
    ['Draft', 'Final'],
  ])('treats %j and %j as the same revision', (a, b) => {
    expect(same(a, b)).toBe(true);
    expect(same(b, a)).toBe(true);
  });

  it('orders labels of mixed formats', () => {
    const ordered = [
      'Rev A',
      'Rev B',
      'Rev. C',
      'Rev Z',
      'Rev AA',
      'R0',
      'Rev 1',
      'R2',
      '2.1',
      '2.10',
      'Rev 10',
    ];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(
        compareRevisions(ordered[i] ?? null, ordered[i + 1] ?? null),
        `${String(ordered[i])} < ${String(ordered[i + 1])}`,
      ).toBeLessThan(0);
    }
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareRevisions)).toEqual(ordered);
  });

  it('compares numbers numerically, not as text', () => {
    expect(compareRevisions('R2', 'R10')).toBeLessThan(0);
    expect(compareRevisions('2.9', '2.10')).toBeLessThan(0);
  });

  it('puts every letter revision before every numbered one', () => {
    expect(compareRevisions('Rev ZZ', 'Rev 0')).toBeLessThan(0);
  });

  it('ranks unknown and missing labels below every known one', () => {
    for (const unknown of [null, '', 'Draft', 'Rev 2B']) {
      expect(compareRevisions(unknown, 'Rev A')).toBeLessThan(0);
      expect(compareRevisions('R0', unknown)).toBeGreaterThan(0);
    }
  });

  const label = fc.oneof(
    fc.constantFrom(
      null,
      '',
      'Draft',
      'Rev A',
      'rev a',
      'Rev B',
      'Rev. C',
      'Z',
      'AA',
      'R0',
      'R2',
      'Rev 2',
      '2.1',
      '10',
    ),
    fc.string({ maxLength: 8 }),
  );

  it('is a total order: reflexive, antisymmetric and transitive', () => {
    fc.assert(
      fc.property(label, label, label, (a, b, c) => {
        expect(same(a, a)).toBe(true);
        expect(sign(compareRevisions(a, b))).toBe(sign(-compareRevisions(b, a)));
        if (compareRevisions(a, b) <= 0 && compareRevisions(b, c) <= 0) {
          expect(compareRevisions(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: 1000 },
    );
  });
});
