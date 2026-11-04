import type { ConflictRecord, FieldDefinition, HumanDecision } from '@specledger/core';

import { notImplemented } from '../not-implemented.js';

// The lineage of a stored field for reconciliation: one series of revisions is the documents of
// one type for one tag.
export const lineageOf = (tag: string, documentType: string) => `${tag}:${documentType}`;

// Resolved conflicts as Phase 6 human decisions: the decided value normalized for its field, the
// chosen candidate if any, and the evidence the reviewer saw. A decision whose value no longer
// normalizes (a field definition changed) is skipped, so reconciliation treats the field as
// undecided rather than trusting a value it cannot read.
export function decisionsFrom(
  resolved: readonly ConflictRecord[],
  definitions: ReadonlyMap<string, FieldDefinition>,
): HumanDecision[] {
  return notImplemented('decisionsFrom', resolved, definitions);
}
