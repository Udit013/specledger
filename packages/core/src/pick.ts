import type { Candidate } from './candidate.js';
import type { VerificationResult } from './verifier.js';

export interface VerifiedCandidate {
  readonly candidate: Candidate;
  readonly verdict: VerificationResult;
}

export interface PickedField extends VerifiedCandidate {
  // Other candidates for the same field in this extraction, not stored as fields.
  readonly dropped: number;
}

// An extraction keeps one value per field. Per field: the first verified candidate in the model's
// order, otherwise the first candidate; the rest are counted, not lost silently. Sorted by field
// name. The worker stores what this picks, and the evaluation measures the same choice.
export function pickFields(candidates: readonly VerifiedCandidate[]): PickedField[] {
  const byName = new Map<string, VerifiedCandidate[]>();
  for (const entry of candidates) {
    const name = entry.candidate.fieldName;
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([, group]) => {
      const chosen = group.find((entry) => entry.verdict.status === 'verified') ?? group[0];
      return chosen === undefined ? [] : [{ ...chosen, dropped: group.length - 1 }];
    });
}
