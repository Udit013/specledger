import type { PublishBlocker, RegisterItemValues, RegisterVersionRecord } from '@specledger/core';
import type { Database } from '@specledger/db';

import { notImplemented } from '../not-implemented.js';

export interface PublishInput {
  readonly actor: string;
  readonly now: Date;
}

export interface Published {
  readonly version: RegisterVersionRecord;
  readonly items: readonly { readonly tag: string; readonly values: RegisterItemValues }[];
}

// Publishes the next register version in one transaction: lock the counter row, collect the
// blockers (a document still processing, a field pending review, an open conflict, accepted values
// of equal rank that disagree with no decision) and refuse with 409 PUBLISH_BLOCKED and the list
// if there are any, creating nothing; otherwise create the version with one item per equipment
// holding its reconciled accepted values (decisions included, rejected fields left out) and
// publish it. 409 NOTHING_TO_PUBLISH when no equipment has an accepted value.
export function publishRegister(database: Database, input: PublishInput): Promise<Published> {
  return notImplemented('publishRegister', database, input);
}

export type { PublishBlocker };
