import { z } from 'zod';

import { err, ok } from './result.js';
import type { Result } from './result.js';
import { compareRevisions, parseRevision } from './revision.js';
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

type Entry = DecisionLogEntry;
type Candidate = ReconcileCandidate;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedIds = (candidates: readonly Candidate[]) => candidates.map((c) => c.id).sort(byText);

const entry = (
  rule: ReconcileRule,
  fieldName: string,
  candidates: readonly Candidate[],
  outcome: LogOutcome,
  winners: readonly Candidate[] = [],
): Entry => ({
  rule,
  fieldName,
  candidateIds: sortedIds(candidates),
  outcome,
  winnerIds: sortedIds(winners),
});

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

const agree = (a: number, b: number) =>
  Math.abs(a - b) <= RECONCILE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));

// Whether candidate a takes precedence over candidate b by reconciliation's rules, values aside:
// within one lineage a later revision supersedes an earlier one (an unknown revision ranks
// lowest), and across lineages the higher source rank wins. Equal precedence is not superseding.
export function supersedes(
  a: Pick<ReconcileCandidate, 'lineage' | 'sourceType' | 'revision'>,
  b: Pick<ReconcileCandidate, 'lineage' | 'sourceType' | 'revision'>,
): boolean {
  if (a.lineage === b.lineage) return compareRevisions(a.revision, b.revision) > 0;
  return SOURCE_RANK[a.sourceType] > SOURCE_RANK[b.sourceType];
}

// Two canonical values agree when they share a unit and every bound is within RECONCILE_TOLERANCE
// (0.5 percent) of the other. Also the evaluation's definition of a correct value.
export function valuesAgree(a: NormalizedValue, b: NormalizedValue): boolean {
  if (a.unit !== b.unit) return false;
  if (a.kind === 'scalar') return b.kind === 'scalar' && agree(a.value, b.value);
  return b.kind === 'range' && agree(a.low, b.low) && agree(a.high, b.high);
}

// Step 3: within each lineage, only the latest revision survives.
function latestRevisions(competing: readonly Candidate[], fieldName: string, log: Entry[]) {
  const survivors: Candidate[] = [];
  for (const lineage of groupBy(competing, (c) => c.lineage).values()) {
    const latest = lineage.reduce((best, c) =>
      compareRevisions(c.revision, best.revision) > 0 ? c : best,
    );
    const top = lineage.filter((c) => compareRevisions(c.revision, latest.revision) === 0);
    const superseded = lineage.filter((c) => compareRevisions(c.revision, latest.revision) < 0);
    if (superseded.length > 0) {
      log.push(entry('LATER_REVISION', fieldName, superseded, 'superseded', top));
    }
    survivors.push(...top);
  }
  return survivors;
}

// Step 4: across lineages, only the highest source rank survives.
function highestRank(survivors: readonly Candidate[], fieldName: string, log: Entry[]) {
  const best = Math.max(...survivors.map((c) => SOURCE_RANK[c.sourceType]));
  const top = survivors.filter((c) => SOURCE_RANK[c.sourceType] === best);
  const superseded = survivors.filter((c) => SOURCE_RANK[c.sourceType] < best);
  if (superseded.length > 0) {
    log.push(entry('HIGHER_SOURCE_RANK', fieldName, superseded, 'superseded', top));
  }
  return top;
}

// Step 5: what is left has equal rank; it is selected, merged or a conflict.
function select(
  top: readonly Candidate[],
  fieldName: string,
  unverifiedCandidateIds: readonly string[],
  log: Entry[],
): FieldOutcome {
  const values = top.map((c) => c.value).filter((v): v is NormalizedValue => v !== null);
  const allAgree = values.every((a) => values.every((b) => valuesAgree(a, b)));
  const evidence = [...top].sort((a, b) => byText(a.id, b.id));
  const chosen = evidence[0];
  // Verified candidates always have a value (validate checks it), so a missing one is only a
  // safeguard; either way, anything short of full agreement is a conflict, never a guess.
  if (chosen?.value == null || values.length !== top.length || !allAgree) {
    log.push(entry('EQUAL_RANK_CONFLICT', fieldName, top, 'conflict'));
    return { status: 'conflict', fieldName, candidateIds: sortedIds(top), unverifiedCandidateIds };
  }
  if (top.length === 1) log.push(entry('ONLY_CANDIDATE', fieldName, top, 'selected', [chosen]));
  else log.push(entry('EQUAL_VALUES_MERGED', fieldName, top, 'merged', [chosen]));
  return {
    status: 'selected',
    fieldName,
    selectedCandidateId: chosen.id,
    value: chosen.value,
    evidenceCandidateIds: sortedIds(top),
    unverifiedCandidateIds,
  };
}

// Step 6: a human decision stands; a later revision in one of its basis lineages marks it for
// re-review, and nothing is overwritten.
function respectDecision(
  decision: HumanDecision,
  competing: readonly Candidate[],
  unverifiedCandidateIds: readonly string[],
  log: Entry[],
): FieldOutcome {
  const basisIds = new Set(decision.basedOn.map((basis) => basis.candidateId));
  const basisByLineage = groupBy(decision.basedOn, (basis) => basis.lineage);
  const newer = competing.filter((c) => {
    const basis = basisByLineage.get(c.lineage);
    return (
      !basisIds.has(c.id) &&
      basis !== undefined &&
      basis.every((b) => compareRevisions(c.revision, b.revision) > 0)
    );
  });
  const { fieldName } = decision;
  if (newer.length > 0) {
    log.push(entry('NEEDS_RE_REVIEW', fieldName, newer, 'needs_re_review'));
    return {
      status: 'needs_re_review',
      fieldName,
      decision,
      newCandidateIds: sortedIds(newer),
      unverifiedCandidateIds,
    };
  }
  log.push({
    rule: 'HUMAN_DECISION_KEPT',
    fieldName,
    candidateIds: [...basisIds].sort(byText),
    outcome: 'kept',
    winnerIds: decision.candidateId === null ? [] : [decision.candidateId],
  });
  return { status: 'decided', fieldName, decision, newCandidateIds: [], unverifiedCandidateIds };
}

function reconcileField(
  fieldName: string,
  candidates: readonly Candidate[],
  decision: HumanDecision | undefined,
  log: Entry[],
): FieldOutcome {
  // Steps 1 and 2: unverified candidates are carried, never compete; unknown revisions are noted.
  const unverified = candidates.filter((c) => c.verification !== 'verified');
  const competing = candidates.filter((c) => c.verification === 'verified');
  const unverifiedCandidateIds = sortedIds(unverified);
  if (unverified.length > 0)
    log.push(entry('UNVERIFIED_EXCLUDED', fieldName, unverified, 'excluded'));
  const unknown = competing.filter((c) => parseRevision(c.revision) === null);
  if (unknown.length > 0) log.push(entry('UNKNOWN_REVISION', fieldName, unknown, 'ranked_lowest'));

  if (decision !== undefined)
    return respectDecision(decision, competing, unverifiedCandidateIds, log);
  if (competing.length === 0) {
    log.push(entry('NO_VERIFIED_CANDIDATE', fieldName, [], 'unresolved'));
    return { status: 'unresolved', fieldName, unverifiedCandidateIds };
  }
  const top = highestRank(latestRevisions(competing, fieldName, log), fieldName, log);
  return select(top, fieldName, unverifiedCandidateIds, log);
}

function validate(input: ReconcileInput): ReconcileError | null {
  const ids = input.candidates.map((c) => c.id).sort(byText);
  const repeated = ids.find((id, index) => ids[index + 1] === id);
  if (repeated !== undefined) return { code: 'DUPLICATE_CANDIDATE_ID', subject: repeated };
  const fields = input.decisions.map((d) => d.fieldName).sort(byText);
  const twice = fields.find((field, index) => fields[index + 1] === field);
  if (twice !== undefined) return { code: 'DUPLICATE_DECISION', subject: twice };
  const invalid = input.candidates
    .filter((c) => c.verification === 'verified' && c.value === null)
    .map((c) => c.id)
    .sort(byText)[0];
  return invalid === undefined ? null : { code: 'INVALID_CANDIDATE', subject: invalid };
}

const RULE_INDEX = new Map(RECONCILE_RULES.map((rule, index) => [rule, index]));

const compareEntries = (a: Entry, b: Entry) =>
  byText(a.fieldName, b.fieldName) ||
  (RULE_INDEX.get(a.rule) ?? 0) - (RULE_INDEX.get(b.rule) ?? 0) ||
  byText(a.candidateIds.join('\u0000'), b.candidateIds.join('\u0000'));

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
  const problem = validate(input);
  if (problem !== null) return err(problem);

  // Canonical order first: every later step reads sorted input, so the output cannot depend on
  // the order the caller passed things in.
  const candidates = [...input.candidates].sort((a, b) => byText(a.id, b.id));
  const decisions = [...input.decisions]
    .map((d) => ({
      ...d,
      basedOn: [...d.basedOn].sort((a, b) => byText(a.candidateId, b.candidateId)),
    }))
    .sort((a, b) => byText(a.fieldName, b.fieldName));
  const decisionFor = new Map(decisions.map((d) => [d.fieldName, d]));
  const byField = groupBy(candidates, (c) => c.fieldName);
  const fieldNames = [...new Set([...byField.keys(), ...decisionFor.keys()])].sort(byText);

  const log: Entry[] = [];
  const fields = fieldNames.map((name) =>
    reconcileField(name, byField.get(name) ?? [], decisionFor.get(name), log),
  );
  return ok({
    candidates,
    decisions,
    fields,
    conflicts: fields.flatMap((f) =>
      f.status === 'conflict' ? [{ fieldName: f.fieldName, candidateIds: f.candidateIds }] : [],
    ),
    log: log.sort(compareEntries),
  });
}
