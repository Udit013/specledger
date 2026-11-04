import { describe, expect, it } from 'vitest';

import { cand, logOf, outcome, range, run, scalar } from '../test/reconcile-fixtures.js';
import type { HumanDecision } from './reconcile.js';
import { RECONCILE_RULES, RECONCILE_TOLERANCE, reconcile, SOURCE_RANK } from './reconcile.js';

describe('constants', () => {
  it('ranks datasheet above manual above brochure', () => {
    expect(SOURCE_RANK.datasheet).toBeGreaterThan(SOURCE_RANK.manual);
    expect(SOURCE_RANK.manual).toBeGreaterThan(SOURCE_RANK.brochure);
  });

  it('merges within half a percent and exports every rule id', () => {
    expect(RECONCILE_TOLERANCE).toBe(0.005);
    expect(RECONCILE_RULES).toEqual([
      'UNVERIFIED_EXCLUDED',
      'UNKNOWN_REVISION',
      'LATER_REVISION',
      'HIGHER_SOURCE_RANK',
      'ONLY_CANDIDATE',
      'EQUAL_VALUES_MERGED',
      'EQUAL_RANK_CONFLICT',
      'HUMAN_DECISION_KEPT',
      'NEEDS_RE_REVIEW',
      'NO_VERIFIED_CANDIDATE',
    ]);
  });
});

describe('a single candidate', () => {
  it('is selected, with its own evidence and log entry', () => {
    const result = run([cand('a')]);
    expect(outcome(result)).toEqual({
      status: 'selected',
      fieldName: 'rated_head',
      selectedCandidateId: 'a',
      value: scalar(10),
      evidenceCandidateIds: ['a'],
      unverifiedCandidateIds: [],
    });
    expect(logOf(result)).toEqual([
      { rule: 'ONLY_CANDIDATE', candidateIds: ['a'], outcome: 'selected', winnerIds: ['a'] },
    ]);
    expect(result.conflicts).toEqual([]);
  });
});

describe('rule: a later revision supersedes within a lineage', () => {
  it('selects Rev B over Rev A', () => {
    const result = run([
      cand('a', { value: scalar(10) }),
      cand('b', { revision: 'Rev B', value: scalar(12) }),
    ]);
    expect(outcome(result)).toMatchObject({
      status: 'selected',
      selectedCandidateId: 'b',
      value: scalar(12),
    });
    expect(logOf(result)).toEqual([
      { rule: 'LATER_REVISION', candidateIds: ['a'], outcome: 'superseded', winnerIds: ['b'] },
      { rule: 'ONLY_CANDIDATE', candidateIds: ['b'], outcome: 'selected', winnerIds: ['b'] },
    ]);
  });

  it('compares revisions only within a lineage', () => {
    const result = run([
      cand('a', { lineage: 'ds-1', revision: 'Rev A', value: scalar(10) }),
      cand('b', { lineage: 'ds-2', revision: 'Rev C', value: scalar(12) }),
    ]);
    expect(outcome(result).status).toBe('conflict');
    expect(logOf(result).map((entry) => entry.rule)).not.toContain('LATER_REVISION');
  });

  it('keeps both candidates of the same revision in a lineage', () => {
    const result = run([
      cand('a', { revision: 'Rev B' }),
      cand('b', { revision: 'rev b', value: scalar(11) }),
    ]);
    expect(logOf(result)).toEqual([
      { rule: 'EQUAL_RANK_CONFLICT', candidateIds: ['a', 'b'], outcome: 'conflict', winnerIds: [] },
    ]);
  });
});

describe('rule: an unknown revision ranks lowest and is logged', () => {
  it('is superseded by any known revision of its lineage', () => {
    const result = run([
      cand('a', { revision: 'Rev A' }),
      cand('u', { revision: null, value: scalar(12) }),
    ]);
    expect(outcome(result)).toMatchObject({ status: 'selected', selectedCandidateId: 'a' });
    expect(logOf(result)).toEqual([
      { rule: 'UNKNOWN_REVISION', candidateIds: ['u'], outcome: 'ranked_lowest', winnerIds: [] },
      { rule: 'LATER_REVISION', candidateIds: ['u'], outcome: 'superseded', winnerIds: ['a'] },
      { rule: 'ONLY_CANDIDATE', candidateIds: ['a'], outcome: 'selected', winnerIds: ['a'] },
    ]);
  });

  it('never ranks two unknown revisions against each other', () => {
    const result = run([
      cand('u1', { revision: null }),
      cand('u2', { revision: 'Draft', value: scalar(11) }),
    ]);
    expect(logOf(result)).toEqual([
      {
        rule: 'UNKNOWN_REVISION',
        candidateIds: ['u1', 'u2'],
        outcome: 'ranked_lowest',
        winnerIds: [],
      },
      {
        rule: 'EQUAL_RANK_CONFLICT',
        candidateIds: ['u1', 'u2'],
        outcome: 'conflict',
        winnerIds: [],
      },
    ]);
  });
});

describe('rule: a higher source rank supersedes across lineages', () => {
  it.each([
    ['datasheet', 'manual'],
    ['datasheet', 'brochure'],
    ['manual', 'brochure'],
  ] as const)('%s over %s', (higher, lower) => {
    const result = run([
      cand('hi', { lineage: `${higher}-1`, sourceType: higher, value: scalar(10) }),
      cand('lo', { lineage: `${lower}-1`, sourceType: lower, value: scalar(20) }),
    ]);
    expect(outcome(result)).toMatchObject({
      status: 'selected',
      selectedCandidateId: 'hi',
      value: scalar(10),
    });
    expect(logOf(result)).toEqual([
      {
        rule: 'HIGHER_SOURCE_RANK',
        candidateIds: ['lo'],
        outcome: 'superseded',
        winnerIds: ['hi'],
      },
      { rule: 'ONLY_CANDIDATE', candidateIds: ['hi'], outcome: 'selected', winnerIds: ['hi'] },
    ]);
  });

  it('beats a later revision label in another lineage', () => {
    const result = run([
      cand('ds', { lineage: 'ds-1', revision: 'Rev A', value: scalar(10) }),
      cand('br', { lineage: 'br-1', sourceType: 'brochure', revision: 'Rev Z', value: scalar(20) }),
    ]);
    expect(outcome(result)).toMatchObject({ selectedCandidateId: 'ds' });
    expect(logOf(result)).toEqual([
      {
        rule: 'HIGHER_SOURCE_RANK',
        candidateIds: ['br'],
        outcome: 'superseded',
        winnerIds: ['ds'],
      },
      { rule: 'ONLY_CANDIDATE', candidateIds: ['ds'], outcome: 'selected', winnerIds: ['ds'] },
    ]);
  });

  it('applies after revisions, with every step logged', () => {
    const result = run([
      cand('a', { revision: 'Rev A', value: scalar(10) }),
      cand('b', { revision: 'Rev B', value: scalar(12) }),
      cand('m', { lineage: 'man-1', sourceType: 'manual', revision: '1', value: scalar(13) }),
      cand('c', { lineage: 'br-1', sourceType: 'brochure', revision: null, value: scalar(20) }),
    ]);
    expect(outcome(result)).toMatchObject({
      selectedCandidateId: 'b',
      evidenceCandidateIds: ['b'],
    });
    expect(logOf(result)).toEqual([
      { rule: 'UNKNOWN_REVISION', candidateIds: ['c'], outcome: 'ranked_lowest', winnerIds: [] },
      { rule: 'LATER_REVISION', candidateIds: ['a'], outcome: 'superseded', winnerIds: ['b'] },
      {
        rule: 'HIGHER_SOURCE_RANK',
        candidateIds: ['c', 'm'],
        outcome: 'superseded',
        winnerIds: ['b'],
      },
      { rule: 'ONLY_CANDIDATE', candidateIds: ['b'], outcome: 'selected', winnerIds: ['b'] },
    ]);
  });
});

describe('rule: equal rank merges agreeing values and conflicts otherwise', () => {
  const twoLineages = (a: number, b: number) =>
    run([
      cand('a', { lineage: 'ds-1', value: scalar(a) }),
      cand('b', { lineage: 'ds-2', value: scalar(b) }),
    ]);

  it('merges values within half a percent, selecting the smallest id', () => {
    const result = twoLineages(10, 10.05);
    expect(outcome(result)).toEqual({
      status: 'selected',
      fieldName: 'rated_head',
      selectedCandidateId: 'a',
      value: scalar(10),
      evidenceCandidateIds: ['a', 'b'],
      unverifiedCandidateIds: [],
    });
    expect(logOf(result)).toEqual([
      {
        rule: 'EQUAL_VALUES_MERGED',
        candidateIds: ['a', 'b'],
        outcome: 'merged',
        winnerIds: ['a'],
      },
    ]);
  });

  it('conflicts just past half a percent, and lists the conflict', () => {
    const result = twoLineages(10, 10.06);
    expect(outcome(result)).toEqual({
      status: 'conflict',
      fieldName: 'rated_head',
      candidateIds: ['a', 'b'],
      unverifiedCandidateIds: [],
    });
    expect(logOf(result)).toEqual([
      { rule: 'EQUAL_RANK_CONFLICT', candidateIds: ['a', 'b'], outcome: 'conflict', winnerIds: [] },
    ]);
    expect(result.conflicts).toEqual([{ fieldName: 'rated_head', candidateIds: ['a', 'b'] }]);
  });

  it('conflicts when any pair disagrees, even if each agrees with a middle value', () => {
    const result = run([
      cand('a', { lineage: 'ds-1', value: scalar(10) }),
      cand('b', { lineage: 'ds-2', value: scalar(10.04) }),
      cand('c', { lineage: 'ds-3', value: scalar(10.08) }),
    ]);
    expect(outcome(result)).toMatchObject({ status: 'conflict', candidateIds: ['a', 'b', 'c'] });
  });

  it('never merges equal numbers in different units', () => {
    const result = run([
      cand('a', { lineage: 'ds-1', value: scalar(10, 'm') }),
      cand('b', { lineage: 'ds-2', value: scalar(10, 'W') }),
    ]);
    expect(outcome(result)).toMatchObject({ status: 'conflict', candidateIds: ['a', 'b'] });
  });

  it('merges ranges bound by bound, and never merges a range with a scalar', () => {
    const ranges = run([
      cand('a', { fieldName: 'rated_speed', lineage: 'ds-1', value: range(2900, 3600) }),
      cand('b', { fieldName: 'rated_speed', lineage: 'ds-2', value: range(2900, 3610) }),
    ]);
    expect(outcome(ranges, 'rated_speed')).toMatchObject({
      status: 'selected',
      evidenceCandidateIds: ['a', 'b'],
    });
    const mixed = run([
      cand('a', { fieldName: 'rated_speed', lineage: 'ds-1', value: range(2900, 3600) }),
      cand('b', { fieldName: 'rated_speed', lineage: 'ds-2', value: scalar(2900, 'rpm') }),
    ]);
    expect(outcome(mixed, 'rated_speed')).toMatchObject({ status: 'conflict' });
  });
});

describe('rule: only verified candidates compete', () => {
  it('excludes an unverified candidate even with a later revision, and carries it', () => {
    const result = run([
      cand('v', { revision: 'Rev A', value: scalar(10) }),
      cand('x', { revision: 'Rev C', verification: 'unverified', value: scalar(99) }),
    ]);
    expect(outcome(result)).toMatchObject({
      status: 'selected',
      selectedCandidateId: 'v',
      unverifiedCandidateIds: ['x'],
    });
    expect(logOf(result)).toEqual([
      { rule: 'UNVERIFIED_EXCLUDED', candidateIds: ['x'], outcome: 'excluded', winnerIds: [] },
      { rule: 'ONLY_CANDIDATE', candidateIds: ['v'], outcome: 'selected', winnerIds: ['v'] },
    ]);
  });

  it('selects nothing when no candidate is verified', () => {
    const result = run([cand('x', { verification: 'unverified', value: null })]);
    expect(outcome(result)).toEqual({
      status: 'unresolved',
      fieldName: 'rated_head',
      unverifiedCandidateIds: ['x'],
    });
    expect(logOf(result)).toEqual([
      { rule: 'UNVERIFIED_EXCLUDED', candidateIds: ['x'], outcome: 'excluded', winnerIds: [] },
      { rule: 'NO_VERIFIED_CANDIDATE', candidateIds: [], outcome: 'unresolved', winnerIds: [] },
    ]);
  });
});

describe('human decisions', () => {
  const a = cand('a', { lineage: 'ds-1', revision: 'Rev A', value: scalar(10) });
  const b = cand('b', { lineage: 'ds-2', revision: 'Rev A', value: scalar(11) });
  const decision: HumanDecision = {
    fieldName: 'rated_head',
    value: scalar(10.5),
    candidateId: null,
    basedOn: [
      { candidateId: 'b', lineage: 'ds-2', revision: 'Rev A' },
      { candidateId: 'a', lineage: 'ds-1', revision: 'Rev A' },
    ],
  };
  const canonical: HumanDecision = { ...decision, basedOn: [...decision.basedOn].reverse() };

  it('resolves a conflict, and survives a re-run with unchanged evidence', () => {
    const first = run([a, b], [decision]);
    const again = run(first.candidates, first.decisions);
    for (const result of [first, again]) {
      expect(outcome(result)).toEqual({
        status: 'decided',
        fieldName: 'rated_head',
        decision: canonical,
        newCandidateIds: [],
        unverifiedCandidateIds: [],
      });
      expect(logOf(result)).toEqual([
        { rule: 'HUMAN_DECISION_KEPT', candidateIds: ['a', 'b'], outcome: 'kept', winnerIds: [] },
      ]);
      expect(result.conflicts).toEqual([]);
    }
  });

  it('becomes NEEDS_RE_REVIEW, not overwritten, when a later revision arrives', () => {
    const c = cand('c', { lineage: 'ds-1', revision: 'Rev B', value: scalar(12) });
    const result = run([a, b, c], [decision]);
    expect(outcome(result)).toEqual({
      status: 'needs_re_review',
      fieldName: 'rated_head',
      decision: canonical,
      newCandidateIds: ['c'],
      unverifiedCandidateIds: [],
    });
    expect(logOf(result)).toEqual([
      { rule: 'NEEDS_RE_REVIEW', candidateIds: ['c'], outcome: 'needs_re_review', winnerIds: [] },
    ]);
  });

  it('stays decided when new evidence has the same or an earlier revision', () => {
    const same = cand('d', { lineage: 'ds-1', revision: 'rev a', value: scalar(15) });
    const earlier = cand('e', { lineage: 'ds-2', revision: null, value: scalar(15) });
    expect(outcome(run([a, b, same, earlier], [decision])).status).toBe('decided');
  });

  it('stays decided when new evidence comes from a lineage it was not based on', () => {
    const other = cand('f', { lineage: 'ds-3', revision: 'Rev Z', value: scalar(15) });
    expect(outcome(run([a, b, other], [decision])).status).toBe('decided');
  });

  it('is re-reviewed when a known revision arrives in a lineage whose basis had none', () => {
    const unlabelled: HumanDecision = {
      ...decision,
      basedOn: [{ candidateId: 'u', lineage: 'ds-1', revision: null }],
    };
    const result = run(
      [cand('u', { revision: null }), cand('g', { revision: 'Rev A' })],
      [unlabelled],
    );
    expect(outcome(result)).toMatchObject({ status: 'needs_re_review', newCandidateIds: ['g'] });
  });

  it('names the chosen candidate as the winner of the kept decision', () => {
    const chosen: HumanDecision = { ...decision, candidateId: 'a', value: scalar(10) };
    expect(logOf(run([a, b], [chosen]))).toEqual([
      { rule: 'HUMAN_DECISION_KEPT', candidateIds: ['a', 'b'], outcome: 'kept', winnerIds: ['a'] },
    ]);
  });

  it('stands for a field that has no candidates left', () => {
    const result = run([], [decision]);
    expect(outcome(result)).toMatchObject({ status: 'decided', decision: canonical });
  });

  it('ignores unverified candidates when looking for new evidence', () => {
    const later = cand('x', {
      lineage: 'ds-1',
      revision: 'Rev Z',
      verification: 'unverified',
      value: null,
    });
    const result = run([a, b, later], [decision]);
    expect(outcome(result)).toMatchObject({ status: 'decided', unverifiedCandidateIds: ['x'] });
    expect(logOf(result)).toEqual([
      { rule: 'UNVERIFIED_EXCLUDED', candidateIds: ['x'], outcome: 'excluded', winnerIds: [] },
      { rule: 'HUMAN_DECISION_KEPT', candidateIds: ['a', 'b'], outcome: 'kept', winnerIds: [] },
    ]);
  });
});

describe('several fields', () => {
  it('reconciles each field on its own and sorts outcomes and log by field', () => {
    const result = run([
      cand('f1', { fieldName: 'rated_power', value: scalar(45_000, 'W') }),
      cand('h1', { fieldName: 'rated_head', value: scalar(10) }),
      cand('h2', { fieldName: 'rated_head', revision: 'Rev B', value: scalar(11) }),
    ]);
    expect(result.fields.map((field) => [field.fieldName, field.status])).toEqual([
      ['rated_head', 'selected'],
      ['rated_power', 'selected'],
    ]);
    expect(result.log.map((entry) => [entry.fieldName, entry.rule])).toEqual([
      ['rated_head', 'LATER_REVISION'],
      ['rated_head', 'ONLY_CANDIDATE'],
      ['rated_power', 'ONLY_CANDIDATE'],
    ]);
  });
});

describe('input errors are returned, not thrown', () => {
  it('rejects a repeated candidate id', () => {
    expect(
      reconcile({ candidates: [cand('a'), cand('a', { value: scalar(11) })], decisions: [] }),
    ).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_CANDIDATE_ID', subject: 'a' },
    });
  });

  it('rejects two decisions for one field', () => {
    const decision: HumanDecision = {
      fieldName: 'rated_head',
      value: scalar(10),
      candidateId: null,
      basedOn: [],
    };
    expect(reconcile({ candidates: [], decisions: [decision, decision] })).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_DECISION', subject: 'rated_head' },
    });
  });

  it('rejects a verified candidate without a value', () => {
    expect(reconcile({ candidates: [cand('a', { value: null })], decisions: [] })).toEqual({
      ok: false,
      error: { code: 'INVALID_CANDIDATE', subject: 'a' },
    });
  });
});
