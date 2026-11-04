import type { FieldRecord, ReviewFieldBody } from '@specledger/core';
import type { Database } from '@specledger/db';

import { notImplemented } from '../not-implemented.js';

export interface ReviewInput {
  readonly fieldId: string;
  readonly body: ReviewFieldBody;
  readonly actor: string;
}

// Applies a review action with optimistic concurrency, writing the field and its audit event in one
// transaction. accept and reject keep the value; edit replaces it, and the new value must be
// readable for the field (a number and a unit of the field's quantity). Accepting an unverified
// value requires a reason. A stale expectedVersion is a 409 VERSION_CONFLICT carrying the current
// field; an unknown field is a 404.
export function reviewField(database: Database, input: ReviewInput): Promise<FieldRecord> {
  return notImplemented('reviewField', database, input);
}
