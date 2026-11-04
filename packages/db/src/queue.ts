import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { notImplemented } from './not-implemented.js';
import type { FailOutcome, JobFailure, JobRecord, NewJob } from './queue-types.js';
import type * as schema from './schema.js';

type Executor = PgDatabase<PgQueryResultHKT, typeof schema>;

// The Postgres job queue. Every function takes the current time as a parameter, never NOW() in
// SQL, so tests drive time with an injected clock. Functions that act on a claimed job take the
// claiming worker's id and change nothing unless that worker still holds the lease (fencing): a
// worker whose lease expired and was taken over cannot complete, fail or extend the job.
export interface Queue {
  // Adds a job, unless one with the same idempotency key exists: insert on conflict do nothing,
  // then select. Runs on the executor it was created with, so inside a transaction the job commits
  // or rolls back with the caller's other writes.
  enqueue(job: NewJob, now: Date): Promise<{ readonly job: JobRecord; readonly created: boolean }>;

  // One statement: takes the next job that is queued with run_at <= now, or running with an
  // expired lease (locked_until < now) and attempts left, using FOR UPDATE SKIP LOCKED so
  // concurrent claimers never wait for or take the same job. It sets status running, increments
  // attempts and leases the job to workerId until now + visibilityMs. Null when nothing is due.
  claim(now: Date, workerId: string, visibilityMs: number): Promise<JobRecord | null>;

  // Extends the lease to now + visibilityMs. False, changing nothing, unless workerId holds a
  // running job's lease.
  heartbeat(jobId: string, workerId: string, now: Date, visibilityMs: number): Promise<boolean>;

  // Marks the job succeeded and clears the lease. False, changing nothing, unless workerId holds
  // a running job's lease.
  complete(jobId: string, workerId: string, now: Date): Promise<boolean>;

  // Records a failed attempt. With failure.retryAt and attempts left: queued again at retryAt.
  // With retryAt but no attempts left: dead. Without retryAt (permanent): failed. The lease is
  // cleared and failure.error stored. Null, changing nothing, unless workerId holds the lease.
  fail(
    jobId: string,
    workerId: string,
    now: Date,
    failure: JobFailure,
  ): Promise<FailOutcome | null>;

  // Gives a running job back without counting the attempt (graceful shutdown): queued at now,
  // attempts decremented, lease cleared. False unless workerId holds the lease.
  release(jobId: string, workerId: string, now: Date): Promise<boolean>;

  // Moves a dead job back to queued with attempts reset to 0 and run_at = now. False unless the
  // job is dead.
  requeue(jobId: string, now: Date): Promise<boolean>;

  // Marks dead every running job whose lease expired with no attempts left (its worker died on
  // the last attempt), so it does not stay running forever. Returns how many.
  reapExpired(now: Date): Promise<number>;

  getById(jobId: string): Promise<JobRecord | null>;
}

export function createQueue(db: Executor): Queue {
  const stub =
    (name: string) =>
    (...args: unknown[]): never =>
      notImplemented(`queue.${name}`, db, ...args);
  return {
    enqueue: stub('enqueue'),
    claim: stub('claim'),
    heartbeat: stub('heartbeat'),
    complete: stub('complete'),
    fail: stub('fail'),
    release: stub('release'),
    requeue: stub('requeue'),
    reapExpired: stub('reapExpired'),
    getById: stub('getById'),
  };
}
