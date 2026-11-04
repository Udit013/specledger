import type {
  FieldOutcome,
  HumanDecision,
  ReconcileCandidate,
  ReconcileResult,
} from '../src/reconcile.js';
import { reconcile } from '../src/reconcile.js';
import type { NormalizedValue } from '../src/verifier.js';

export const scalar = (value: number, unit = 'm'): NormalizedValue => ({
  kind: 'scalar',
  value,
  unit,
});

export const range = (low: number, high: number, unit = 'rpm'): NormalizedValue => ({
  kind: 'range',
  low,
  high,
  unit,
});

// A verified datasheet candidate for rated_head in lineage ds-1, Rev A, 10 m, unless overridden.
export function cand(id: string, overrides: Partial<ReconcileCandidate> = {}): ReconcileCandidate {
  return {
    id,
    fieldName: 'rated_head',
    lineage: 'ds-1',
    sourceType: 'datasheet',
    revision: 'Rev A',
    verification: 'verified',
    value: scalar(10),
    ...overrides,
  };
}

export function run(
  candidates: readonly ReconcileCandidate[],
  decisions: readonly HumanDecision[] = [],
): ReconcileResult {
  const result = reconcile({ candidates, decisions });
  if (!result.ok) throw new Error(`reconcile failed: ${result.error.code} ${result.error.subject}`);
  return result.value;
}

export function outcome(result: ReconcileResult, fieldName = 'rated_head'): FieldOutcome {
  const found = result.fields.find((field) => field.fieldName === fieldName);
  if (found === undefined) throw new Error(`no outcome for ${fieldName}`);
  return found;
}

// The log entries of one field, without the field name, for compact assertions.
export const logOf = (result: ReconcileResult, fieldName = 'rated_head') =>
  result.log
    .filter((entry) => entry.fieldName === fieldName)
    .map(({ rule, candidateIds, outcome: o, winnerIds }) => ({
      rule,
      candidateIds,
      outcome: o,
      winnerIds,
    }));
