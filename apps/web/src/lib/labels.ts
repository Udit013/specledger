import type {
  DocumentSummary,
  PublishBlocker,
  ReconcileRule,
  ReviewStatus,
  VerificationStatus,
} from '@specledger/core';

// Every status is shown as words (with a symbol), never by color alone.

type JobState = DocumentSummary['processing']['status'];

export const JOB_LABELS: Readonly<Record<JobState, { text: string; symbol: string }>> = {
  none: { text: 'Not queued', symbol: '–' },
  queued: { text: 'Queued', symbol: '…' },
  running: { text: 'Running', symbol: '↻' },
  succeeded: { text: 'Succeeded', symbol: '✓' },
  failed: { text: 'Failed', symbol: '✕' },
  dead: { text: 'Dead', symbol: '✕' },
};

export const REVIEW_LABELS: Readonly<Record<ReviewStatus, { text: string; symbol: string }>> = {
  pending: { text: 'Pending review', symbol: '○' },
  accepted: { text: 'Accepted', symbol: '✓' },
  edited: { text: 'Edited', symbol: '✎' },
  rejected: { text: 'Rejected', symbol: '✕' },
};

export const VERIFICATION_LABELS: Readonly<
  Record<VerificationStatus, { text: string; symbol: string }>
> = {
  verified: { text: 'Verified', symbol: '✓' },
  unverified: { text: 'Unverified', symbol: '!' },
};

// The past tense used in announcements: "rated_head accepted."
export const REVIEW_DONE: Readonly<Record<'accept' | 'edit' | 'reject', string>> = {
  accept: 'accepted',
  edit: 'edited',
  reject: 'rejected',
};

export const RULE_LABELS: Readonly<Record<ReconcileRule, string>> = {
  UNVERIFIED_EXCLUDED: 'unverified values excluded',
  UNKNOWN_REVISION: 'unreadable revisions rank lowest',
  LATER_REVISION: 'later revision',
  HIGHER_SOURCE_RANK: 'higher source rank',
  ONLY_CANDIDATE: 'only candidate left',
  EQUAL_VALUES_MERGED: 'equal values merged',
  EQUAL_RANK_CONFLICT: 'equal-rank values disagree',
  HUMAN_DECISION_KEPT: 'human decision kept',
  NEEDS_RE_REVIEW: 'later revision since the decision',
  NO_VERIFIED_CANDIDATE: 'no verified value',
};

export const BLOCKER_LABELS: Readonly<Record<PublishBlocker['kind'], string>> = {
  JOB_IN_PROGRESS: 'Document still processing',
  FIELD_PENDING_REVIEW: 'Field pending review',
  CONFLICT_OPEN: 'Open conflict',
  UNRESOLVED_DISAGREEMENT: 'Reviewed values disagree',
};
