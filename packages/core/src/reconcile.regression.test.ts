import { describe, expect, it } from 'vitest';

import { cand, logOf, outcome, run, scalar } from '../test/reconcile-fixtures.js';

// Regression cases from the Phase 2 dev split (the holdout is never used for tests). Values are
// the ground truth of the corpus documents, converted to canonical units.

describe('revision case (m-201): Rev B updates rated current and efficiency', () => {
  const revA = { lineage: 'm-201:datasheet', revision: 'Rev A' } as const;
  const revB = { lineage: 'm-201:datasheet', revision: 'Rev B' } as const;
  const result = run([
    cand('a-current', { ...revA, fieldName: 'rated_current', value: scalar(78.6, 'A') }),
    cand('b-current', { ...revB, fieldName: 'rated_current', value: scalar(76.3, 'A') }),
    cand('a-power', { ...revA, fieldName: 'rated_power', value: scalar(45_000, 'W') }),
    cand('b-power', { ...revB, fieldName: 'rated_power', value: scalar(45_000, 'W') }),
  ]);

  it('takes the changed value from Rev B and logs the supersession', () => {
    expect(outcome(result, 'rated_current')).toMatchObject({
      status: 'selected',
      selectedCandidateId: 'b-current',
      value: scalar(76.3, 'A'),
    });
    expect(logOf(result, 'rated_current')).toEqual([
      {
        rule: 'LATER_REVISION',
        candidateIds: ['a-current'],
        outcome: 'superseded',
        winnerIds: ['b-current'],
      },
      {
        rule: 'ONLY_CANDIDATE',
        candidateIds: ['b-current'],
        outcome: 'selected',
        winnerIds: ['b-current'],
      },
    ]);
  });

  it('supersedes an unchanged value too, rather than merging across revisions', () => {
    expect(logOf(result, 'rated_power').map((entry) => entry.rule)).toEqual([
      'LATER_REVISION',
      'ONLY_CANDIDATE',
    ]);
  });
});

describe('brochure case (p-106): the datasheet outranks a brochure that disagrees', () => {
  const datasheet = {
    lineage: 'p-106:datasheet',
    sourceType: 'datasheet',
    revision: 'Rev A',
  } as const;
  const brochure = { lineage: 'p-106:brochure', sourceType: 'brochure', revision: null } as const;
  const result = run([
    cand('ds-head', { ...datasheet, value: scalar(260 * 0.3048) }),
    cand('br-head', { ...brochure, value: scalar(250 * 0.3048) }),
    cand('br-max-flow', {
      ...brochure,
      fieldName: 'rated_flow',
      value: scalar(2596 * 6.30901964e-5, 'm3/s'),
    }),
    cand('ds-flow', {
      ...datasheet,
      fieldName: 'rated_flow',
      value: scalar(1997 * 6.30901964e-5, 'm3/s'),
    }),
  ]);

  it('selects the datasheet head, not the brochure one four percent lower', () => {
    expect(outcome(result)).toMatchObject({ status: 'selected', selectedCandidateId: 'ds-head' });
    expect(logOf(result)).toEqual([
      {
        rule: 'UNKNOWN_REVISION',
        candidateIds: ['br-head'],
        outcome: 'ranked_lowest',
        winnerIds: [],
      },
      {
        rule: 'HIGHER_SOURCE_RANK',
        candidateIds: ['br-head'],
        outcome: 'superseded',
        winnerIds: ['ds-head'],
      },
      {
        rule: 'ONLY_CANDIDATE',
        candidateIds: ['ds-head'],
        outcome: 'selected',
        winnerIds: ['ds-head'],
      },
    ]);
  });

  // The verifier accepts the brochure's "Maximum flow" quote as a rated flow (a known limit);
  // source rank is what keeps it out of the register.
  it('keeps the brochure maximum out of the rated flow', () => {
    expect(outcome(result, 'rated_flow')).toMatchObject({
      status: 'selected',
      selectedCandidateId: 'ds-flow',
    });
  });
});
