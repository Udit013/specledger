import { z } from 'zod';

import { notImplemented } from './not-implemented.js';
import type { Result } from './result.js';
import type { DocumentType, VerificationStatus } from './status.js';
import type { NormalizedValue } from './verifier.js';

// Source rank: datasheet above manual above brochure. Higher wins across lineages.
export const SOURCE_RANK: Readonly<Record<DocumentType, number>> = Object.freeze({
  datasheet: 3,
  manual: 2,
  brochure: 1,
});

// Two verified values of equal rank agree, and merge their evidence, when they differ by at most
// this fraction of the larger, compared in the canonical (SI) unit. Otherwise they conflict.
export const RECONCILE_TOLERANCE = 0.005;

// The rules a decision log entry can cite, in the order reconciliation applies them.
export const RECONCILE_RULES = [
  // An unverified candidate is carried along for display and never competes.
  'UNVERIFIED_EXCLUDED',
  // A competing candidate's revision label is missing or unreadable, so it ranks lowest.
  'UNKNOWN_REVISION',
  // Within one lineage, a later revision supersedes earlier ones.
  'LATER_REVISION',
  // Across lineages, the higher source rank supersedes lower ones.
  'HIGHER_SOURCE_RANK',
  // One candidate is left, and it is selected.
  'ONLY_CANDIDATE',
  // Several candidates are left, of equal rank, and their values agree: one is selected and all of
  // them are its evidence.
  'EQUAL_VALUES_MERGED',
  // Several candidates are left, of equal rank, and their values disagree: an open conflict. It is
  // never resolved automatically.
  'EQUAL_RANK_CONFLICT',
  // A human decision exists and no later revision has arrived since: it stands.
  'HUMAN_DECISION_KEPT',
  // A human decision exists, and a candidate with a later revision than its basis has arrived in
  // one of the lineages it was based on: it stands, but must be reviewed again.
  'NEEDS_RE_REVIEW',
  // No verified candidate for the field: nothing is selected.
  'NO_VERIFIED_CANDIDATE',
] as const;
export const reconcileRuleSchema = z.enum(RECONCILE_RULES);
export type ReconcileRule = z.infer<typeof reconcileRuleSchema>;

export type LogOutcome =
  | 'excluded'
  | 'ranked_lowest'
  | 'superseded'
  | 'selected'
  | 'merged'
  | 'conflict'
  | 'kept'
  | 'needs_re_review'
  | 'unresolved';

// One explained step. Every selection, conflict and supersession has one.
export interface DecisionLogEntry {
  readonly rule: ReconcileRule;
  readonly fieldName: string;
  // The candidates this step is about, sorted: the superseded ones for a supersession, the
  // evidence for a selection, the disagreeing ones for a conflict.
  readonly candidateIds: readonly string[];
  readonly outcome: LogOutcome;
  // The candidates that won this step, sorted: the superseding ones, or the selected one. Empty
  // when nothing won.
  readonly winnerIds: readonly string[];
}

// One extracted value for the equipment being reconciled, with what the verifier decided.
export interface ReconcileCandidate {
  // Unique across the input: the stored field id.
  readonly id: string;
  readonly fieldName: string;
  // The series of documents that are revisions of one another (for example one vendor's datasheet
  // for one tag). Revisions are only compared within a lineage. The caller assigns it.
  readonly lineage: string;
  readonly sourceType: DocumentType;
  readonly revision: string | null;
  readonly verification: VerificationStatus;
  // The verifier's canonical value. Required when verified.
  readonly value: NormalizedValue | null;
}

// A human resolution of a field, and the evidence it was made on.
export interface HumanDecision {
  readonly fieldName: string;
  readonly value: NormalizedValue;
  // The candidate the reviewer chose, or null when they entered a value.
  readonly candidateId: string | null;
  // The candidates the reviewer saw. A later revision in one of these lineages calls for re-review.
  readonly basedOn: readonly {
    readonly candidateId: string;
    readonly lineage: string;
    readonly revision: string | null;
  }[];
}

export interface ReconcileInput {
  readonly candidates: readonly ReconcileCandidate[];
  readonly decisions: readonly HumanDecision[];
}

export type FieldOutcome =
  | {
      readonly status: 'selected';
      readonly fieldName: string;
      readonly selectedCandidateId: string;
      readonly value: NormalizedValue;
      // The selected candidate and every candidate that agreed with it, sorted.
      readonly evidenceCandidateIds: readonly string[];
      readonly unverifiedCandidateIds: readonly string[];
    }
  | {
      readonly status: 'conflict';
      readonly fieldName: string;
      // The disagreeing candidates of equal rank, sorted.
      readonly candidateIds: readonly string[];
      readonly unverifiedCandidateIds: readonly string[];
    }
  | {
      readonly status: 'decided' | 'needs_re_review';
      readonly fieldName: string;
      readonly decision: HumanDecision;
      // For needs_re_review: the later-revision candidates that arrived after the decision, sorted.
      readonly newCandidateIds: readonly string[];
      readonly unverifiedCandidateIds: readonly string[];
    }
  | {
      readonly status: 'unresolved';
      readonly fieldName: string;
      readonly unverifiedCandidateIds: readonly string[];
    };

export interface ReconcileResult {
  // The input in canonical order (candidates by id, decisions by field with basedOn by candidate
  // id). Reconciling { candidates, decisions } of a result gives that result again.
  readonly candidates: readonly ReconcileCandidate[];
  readonly decisions: readonly HumanDecision[];
  // One per field that has a candidate or a decision, sorted by field name.
  readonly fields: readonly FieldOutcome[];
  // The open conflicts, sorted by field name.
  readonly conflicts: readonly {
    readonly fieldName: string;
    readonly candidateIds: readonly string[];
  }[];
  // Sorted by field name, then rule order, then candidate ids.
  readonly log: readonly DecisionLogEntry[];
}

export type ReconcileErrorCode =
  'DUPLICATE_CANDIDATE_ID' | 'DUPLICATE_DECISION' | 'INVALID_CANDIDATE';

export interface ReconcileError {
  readonly code: ReconcileErrorCode;
  // The offending candidate id or field name.
  readonly subject: string;
}

// Chooses the value of every field for one piece of equipment from its candidates across
// documents and revisions, and explains every outcome in the log. Per field, in order:
//
// 1. Unverified candidates are excluded from competition (UNVERIFIED_EXCLUDED) and listed.
// 2. Competing candidates with an unknown revision are logged (UNKNOWN_REVISION).
// 3. Within each lineage, candidates below the lineage's latest revision are superseded
//    (LATER_REVISION).
// 4. Across lineages, candidates below the highest source rank left are superseded
//    (HIGHER_SOURCE_RANK).
// 5. What is left has equal rank. One candidate is selected (ONLY_CANDIDATE); several whose values
//    all agree pairwise within RECONCILE_TOLERANCE merge (EQUAL_VALUES_MERGED), selecting the one
//    with the smallest id; otherwise they are an open conflict (EQUAL_RANK_CONFLICT). A range only
//    agrees with a range, bound by bound. With no candidate left: NO_VERIFIED_CANDIDATE.
// 6. A human decision for the field overrides steps 3 to 5 and is never overwritten: it stands
//    (HUMAN_DECISION_KEPT), or, when a competing candidate that it was not based on has a later
//    revision than every basis candidate of the same lineage, it stands and is marked for
//    re-review (NEEDS_RE_REVIEW).
//
// Deterministic, independent of input order, and idempotent. Input errors (a repeated candidate id,
// two decisions for one field, a verified candidate without a value) are returned, not thrown.
export function reconcile(input: ReconcileInput): Result<ReconcileResult, ReconcileError> {
  return notImplemented('reconcile', input);
}
