import type { ConflictView, ResolveConflictBody } from '@specledger/core';
import type { ConflictWithTag, Database } from '@specledger/db';

import { notImplemented } from '../not-implemented.js';

// A conflict with the latest field of each document of its equipment for the field.
export function conflictView(database: Database, conflict: ConflictWithTag): Promise<ConflictView> {
  return notImplemented('conflictView', database, conflict);
}

export interface ResolveInput {
  readonly conflictId: string;
  readonly body: ResolveConflictBody;
  readonly actor: string;
  readonly now: Date;
}

// Resolves an open conflict with a structured decision, in one transaction with its audit event:
// either one of its candidates (a field of the equipment for that field) or an entered value and
// unit that read as the field's quantity, with a reason. The decision records the candidates the
// reviewer saw, with their lineages and revisions, so reconciliation can tell when a later
// revision calls for another look. 404 for an unknown conflict, 409 CONFLICT_ALREADY_RESOLVED
// once resolved, 400 CANDIDATE_NOT_IN_CONFLICT or INVALID_VALUE for a bad choice.
export function resolveConflict(database: Database, input: ResolveInput): Promise<ConflictWithTag> {
  return notImplemented('resolveConflict', database, input);
}
