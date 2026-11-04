import { normalizeValue } from '@specledger/core';
import type { FieldDefinition, ReconcileCandidate } from '@specledger/core';
import type { ReconcileSourceRow } from '@specledger/db';

import { lineageOf } from './decisions.js';

// Stored fields as reconciliation candidates, the one mapping every caller uses. A lineage is one
// series of revisions: the documents of one type for one tag. A candidate competes only if its
// canonical value can be derived; otherwise it is carried, never selected. `vouched` decides which
// rows count as verified: the verifier's verdict for the worker, a human's for publishing.
export function reconcileCandidates(
  rows: readonly ReconcileSourceRow[],
  tag: string,
  definitions: ReadonlyMap<string, FieldDefinition>,
  vouched: (row: ReconcileSourceRow) => boolean,
): ReconcileCandidate[] {
  return rows.flatMap((row) => {
    const definition = definitions.get(row.name);
    if (definition === undefined) return [];
    const value = vouched(row) ? normalizeValue(row.value, row.unit, definition) : null;
    return [
      {
        id: row.fieldId,
        fieldName: row.name,
        lineage: lineageOf(tag, row.documentType),
        sourceType: row.documentType,
        revision: row.revision,
        verification: value === null ? 'unverified' : 'verified',
        value,
      },
    ];
  });
}

// What the verifier vouches for: the worker's view, and the rules' suggestion for a conflict.
export const verifiedByVerifier = (row: ReconcileSourceRow) =>
  row.verificationStatus === 'verified';

// What a reviewer vouched for: accepted and edited fields. Rejected ones are left out entirely.
export const acceptedByReviewer = (row: ReconcileSourceRow) =>
  row.reviewStatus === 'accepted' || row.reviewStatus === 'edited';
