export const PACKAGE_NAME = '@specledger/db';

export { backoffDelayMs } from './backoff.js';
export type { BackoffPolicy } from './backoff.js';
export { openDatabase } from './database.js';
export type { Database, DatabaseOptions } from './database.js';
export { JOB_STATUSES, jobRecordSchema, MAX_JOB_ATTEMPTS } from './queue-types.js';
export type { FailOutcome, JobFailure, JobRecord, JobStatus, NewJob } from './queue-types.js';
export type { Queue } from './queue.js';
export { StoredRowInvalidError } from './repositories.js';
export type {
  NewDocument,
  NewField,
  NewReviewEvent,
  ReconcileSourceRow,
  Repositories,
} from './repositories.js';
