import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROPERTY_SEED } from '../test/property-seed.js';
import { run, scalar } from '../test/reconcile-fixtures.js';
import type { HumanDecision, ReconcileCandidate } from './reconcile.js';
import { RECONCILE_TOLERANCE } from './reconcile.js';

const LINEAGES = [
  { lineage: 'ds-1', sourceType: 'datasheet' },
  { lineage: 'ds-2', sourceType: 'datasheet' },
  { lineage: 'man-1', sourceType: 'manual' },
  { lineage: 'br-1', sourceType: 'brochure' },
] as const;

// Small pools, so that generated inputs often repeat revisions, agree and disagree.
const candidateParts = fc.record({
  fieldName: fc.constantFrom('rated_head', 'rated_flow'),
  source: fc.constantFrom(...LINEAGES),
  revision: fc.constantFrom(null, 'Draft', 'Rev A', 'rev a', 'Rev B', 'R2', 'Rev 3'),
  verified: fc.constantFrom(true, true, true, true, false),
  value: fc.constantFrom(10, 10.02, 10.5, 11),
});

const candidatesArb = fc.array(candidateParts, { maxLength: 9 }).map((parts) =>
  parts.map((part, index): ReconcileCandidate => ({
    id: `c${String(index).padStart(2, '0')}`,
    fieldName: part.fieldName,
    lineage: part.source.lineage,
    sourceType: part.source.sourceType,
    revision: part.revision,
    verification: part.verified ? 'verified' : 'unverified',
    value: part.verified ? scalar(part.value) : null,
  })),
);

// Inputs with optional human decisions based on some of the candidates of a field.
const inputArb = candidatesArb.chain((candidates) =>
  fc
    .subarray(['rated_head', 'rated_flow'])
    .chain((fields) =>
      fc.tuple(
        ...fields.map((fieldName) =>
          fc
            .subarray(candidates.filter((c) => c.fieldName === fieldName))
            .map((basis): HumanDecision => ({
              fieldName,
              value: scalar(10.25),
              candidateId: basis[0]?.id ?? null,
              basedOn: basis.map((c) => ({
                candidateId: c.id,
                lineage: c.lineage,
                revision: c.revision,
              })),
            })),
        ),
      ),
    )
    .map((decisions) => ({ candidates, decisions })),
);

const agree = (a: number, b: number) =>
  Math.abs(a - b) <= RECONCILE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
const OPTIONS = { seed: PROPERTY_SEED, numRuns: 500 };

describe('reconciliation properties', () => {
  it('gives the same result for any order of candidates, decisions and decision bases', () => {
    const permutations = inputArb.chain((input) =>
      fc.record({
        input: fc.constant(input),
        candidates: fc.shuffledSubarray([...input.candidates], {
          minLength: input.candidates.length,
          maxLength: input.candidates.length,
        }),
        decisions: fc.shuffledSubarray([...input.decisions], {
          minLength: input.decisions.length,
          maxLength: input.decisions.length,
        }),
      }),
    );
    fc.assert(
      fc.property(permutations, ({ input, candidates, decisions }) => {
        const reversedBases = decisions.map((d) => ({ ...d, basedOn: [...d.basedOn].reverse() }));
        expect(run(candidates, reversedBases)).toEqual(run(input.candidates, input.decisions));
      }),
      OPTIONS,
    );
  });

  it('is idempotent: reconciling a result again changes nothing', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const once = run(input.candidates, input.decisions);
        expect(run(once.candidates, once.decisions)).toEqual(once);
      }),
      OPTIONS,
    );
  });

  it('only ever selects a verified input candidate, with its value, and agreeing evidence', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const byId = new Map(input.candidates.map((c) => [c.id, c]));
        for (const field of run(input.candidates, input.decisions).fields) {
          if (field.status !== 'selected') continue;
          const selected = byId.get(field.selectedCandidateId);
          expect(selected?.verification).toBe('verified');
          expect(field.value).toEqual(selected?.value);
          expect(field.evidenceCandidateIds).toContain(field.selectedCandidateId);
          for (const id of field.evidenceCandidateIds) {
            const evidence = byId.get(id);
            expect(evidence?.verification).toBe('verified');
            if (evidence?.value?.kind === 'scalar' && field.value.kind === 'scalar') {
              expect(agree(evidence.value.value, field.value.value)).toBe(true);
            }
          }
        }
      }),
      OPTIONS,
    );
  });

  it('never resolves a conflict automatically, whatever lower-ranked or unverified evidence is added', () => {
    fc.assert(
      fc.property(candidatesArb, fc.constantFrom(10, 10.5, 99), (candidates, extraValue) => {
        const before = run(candidates);
        const extra: ReconcileCandidate[] = before.conflicts.flatMap((conflict, index) => [
          {
            id: `x-br-${String(index)}`,
            fieldName: conflict.fieldName,
            lineage: 'br-9',
            sourceType: 'brochure',
            revision: 'Rev Z',
            verification: 'verified',
            value: scalar(extraValue),
          },
          {
            id: `x-un-${String(index)}`,
            fieldName: conflict.fieldName,
            lineage: 'ds-1',
            sourceType: 'datasheet',
            revision: 'Rev 99',
            verification: 'unverified',
            value: null,
          },
        ]);
        const after = run([...candidates, ...extra]);
        // The added brochure is outranked by a datasheet or manual conflict, and joins a brochure
        // conflict without making it agree; the unverified one never competes. Either way the
        // conflict stays open, with at least its original members.
        for (const conflict of before.conflicts) {
          const field = after.fields.find((f) => f.fieldName === conflict.fieldName);
          expect(field?.status).toBe('conflict');
          if (field?.status === 'conflict') {
            expect(field.candidateIds).toEqual(expect.arrayContaining([...conflict.candidateIds]));
          }
        }
        for (const field of after.fields) {
          if (field.status === 'conflict') expect(field.candidateIds.length).toBeGreaterThan(1);
        }
      }),
      OPTIONS,
    );
  });
});
