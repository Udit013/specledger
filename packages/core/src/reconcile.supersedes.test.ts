import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROPERTY_SEED } from '../test/property-seed.js';
import { cand, run, scalar } from '../test/reconcile-fixtures.js';
import { supersedes } from './reconcile.js';
import type { DocumentType } from './status.js';

const key = (lineage: string, sourceType: DocumentType, revision: string | null) => ({
  lineage,
  sourceType,
  revision,
});

describe('supersedes', () => {
  it.each([
    [
      'a later revision of the same lineage',
      key('l', 'datasheet', 'Rev B'),
      key('l', 'datasheet', 'Rev A'),
      true,
    ],
    [
      'an earlier revision of the same lineage',
      key('l', 'datasheet', 'Rev A'),
      key('l', 'datasheet', 'Rev B'),
      false,
    ],
    ['the same revision', key('l', 'datasheet', 'Rev A'), key('l', 'datasheet', 'Rev A'), false],
    [
      'a known revision over an unknown one',
      key('l', 'datasheet', 'Rev A'),
      key('l', 'datasheet', null),
      true,
    ],
    ['two unknown revisions', key('l', 'datasheet', null), key('l', 'datasheet', 'Issue 3'), false],
    ['a higher-ranked lineage', key('d', 'datasheet', null), key('b', 'brochure', 'Rev Z'), true],
    [
      'a lower-ranked lineage, whatever its revision',
      key('b', 'brochure', 'Rev Z'),
      key('d', 'datasheet', null),
      false,
    ],
    [
      'another lineage of the same rank',
      key('d1', 'datasheet', 'Rev B'),
      key('d2', 'datasheet', 'Rev A'),
      false,
    ],
  ] as const)('%s: %s', (_case, a, b, expected) => {
    expect(supersedes(a, b)).toBe(expected);
  });

  // The rule is reconciliation's own: for two verified candidates whose values disagree,
  // reconcile selects one exactly when it supersedes the other, and opens a conflict when neither
  // does. If the two ever drift apart, this fails.
  it('agrees with reconcile on every pair of candidates', () => {
    const lineage = fc.constantFrom('ds-1', 'ds-2', 'br-1', 'mn-1');
    const typeOf = (l: string): DocumentType =>
      l.startsWith('ds') ? 'datasheet' : l.startsWith('br') ? 'brochure' : 'manual';
    const revision = fc.constantFrom(null, 'Rev A', 'Rev B', 'Rev 2', 'R3', 'Issue 3', '');
    const side = fc.record({ lineage, revision });
    fc.assert(
      fc.property(side, side, (a, b) => {
        const first = cand('a', {
          lineage: a.lineage,
          sourceType: typeOf(a.lineage),
          revision: a.revision === '' ? null : a.revision,
          value: scalar(10),
        });
        const second = cand('b', {
          lineage: b.lineage,
          sourceType: typeOf(b.lineage),
          revision: b.revision === '' ? null : b.revision,
          value: scalar(20),
        });
        const outcome = run([first, second]).fields[0];
        const aWins = supersedes(first, second);
        const bWins = supersedes(second, first);
        expect(aWins && bWins).toBe(false);
        if (aWins) expect(outcome).toMatchObject({ status: 'selected', selectedCandidateId: 'a' });
        else if (bWins)
          expect(outcome).toMatchObject({ status: 'selected', selectedCandidateId: 'b' });
        else expect(outcome?.status).toBe('conflict');
      }),
      { seed: PROPERTY_SEED, numRuns: 500 },
    );
  });
});
