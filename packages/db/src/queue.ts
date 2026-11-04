import { and, asc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { jobRecordSchema } from './queue-types.js';
import type { FailOutcome, JobFailure, JobRecord, NewJob } from './queue-types.js';
import { toDomain } from './rows.js';
import { jobs } from './schema.js';
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

const LAST_ERROR_LIMIT = 500;
const LEASE_EXPIRED = 'LEASE_EXPIRED: the worker stopped renewing its lease on the last attempt';

const toJob = (row: unknown): JobRecord => toDomain('job', jobRecordSchema, row);

// last_error holds 1 to 500 characters (a CHECK); the worker sends "CODE: message".
const clip = (text: string) => (text.length === 0 ? 'UNKNOWN' : text.slice(0, LAST_ERROR_LIMIT));

const leaseUntil = (now: Date, visibilityMs: number) => {
  if (!Number.isInteger(visibilityMs) || visibilityMs < 1) {
    throw new RangeError('visibilityMs must be a positive integer');
  }
  return new Date(now.getTime() + visibilityMs);
};

export function createQueue(db: Executor): Queue {
  // The fencing condition: the job is running and leased to this worker.
  const heldBy = (jobId: string, workerId: string) =>
    and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId));

  return {
    async enqueue(job, now) {
      const [inserted] = await db
        .insert(jobs)
        .values({
          type: job.type,
          payload: job.payload,
          idempotencyKey: job.idempotencyKey,
          status: 'queued',
          attempts: 0,
          maxAttempts: job.maxAttempts,
          runAt: job.runAt,
          correlationId: job.correlationId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: jobs.idempotencyKey })
        .returning();
      if (inserted !== undefined) return { job: toJob(inserted), created: true };
      const [existing] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.idempotencyKey, job.idempotencyKey));
      if (existing === undefined)
        throw new Error('job conflicted on its idempotency key but was not found');
      return { job: toJob(existing), created: false };
    },

    async claim(now, workerId, visibilityMs) {
      const lockedUntil = leaseUntil(now, visibilityMs);
      // The next due job, locked for this statement. SKIP LOCKED passes over rows another claimer
      // has locked instead of waiting for them, so concurrent claimers each get a different job.
      const next = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            lt(jobs.attempts, jobs.maxAttempts),
            or(
              and(eq(jobs.status, 'queued'), lte(jobs.runAt, now)),
              and(eq(jobs.status, 'running'), lt(jobs.lockedUntil, now)),
            ),
          ),
        )
        .orderBy(asc(jobs.runAt), asc(jobs.id))
        .limit(1)
        .for('update', { skipLocked: true });
      const [claimed] = await db
        .update(jobs)
        .set({
          status: 'running',
          attempts: sql`${jobs.attempts} + 1`,
          lockedBy: workerId,
          lockedUntil,
          updatedAt: now,
        })
        .where(sql`${jobs.id} = (${next})`)
        .returning();
      return claimed === undefined ? null : toJob(claimed);
    },

    async heartbeat(jobId, workerId, now, visibilityMs) {
      const updated = await db
        .update(jobs)
        .set({ lockedUntil: leaseUntil(now, visibilityMs), updatedAt: now })
        .where(heldBy(jobId, workerId))
        .returning({ id: jobs.id });
      return updated.length === 1;
    },

    async complete(jobId, workerId, now) {
      const updated = await db
        .update(jobs)
        .set({ status: 'succeeded', lockedBy: null, lockedUntil: null, updatedAt: now })
        .where(heldBy(jobId, workerId))
        .returning({ id: jobs.id });
      return updated.length === 1;
    },

    async fail(jobId, workerId, now, failure) {
      const common = {
        lockedBy: null,
        lockedUntil: null,
        lastError: clip(failure.error),
        updatedAt: now,
      };
      // A retry happens only while attempts are left; the decision is made on the row itself, in
      // the same statement, so it cannot act on a stale attempt count.
      const outcome =
        failure.retryAt === null
          ? { status: 'failed' }
          : {
              status: sql`case when ${jobs.attempts} < ${jobs.maxAttempts} then 'queued' else 'dead' end`,
              runAt: sql`case when ${jobs.attempts} < ${jobs.maxAttempts}
                then ${failure.retryAt.toISOString()}::timestamptz else ${jobs.runAt} end`,
            };
      const [updated] = await db
        .update(jobs)
        .set({ ...common, ...outcome })
        .where(heldBy(jobId, workerId))
        .returning({ status: jobs.status });
      return updated === undefined ? null : (updated.status as FailOutcome);
    },

    async release(jobId, workerId, now) {
      const updated = await db
        .update(jobs)
        .set({
          status: 'queued',
          attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
          runAt: now,
          lockedBy: null,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(heldBy(jobId, workerId))
        .returning({ id: jobs.id });
      return updated.length === 1;
    },

    async requeue(jobId, now) {
      const updated = await db
        .update(jobs)
        .set({ status: 'queued', attempts: 0, runAt: now, updatedAt: now })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'dead')))
        .returning({ id: jobs.id });
      return updated.length === 1;
    },

    async reapExpired(now) {
      const updated = await db
        .update(jobs)
        .set({
          status: 'dead',
          lockedBy: null,
          lockedUntil: null,
          lastError: LEASE_EXPIRED,
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.status, 'running'),
            lt(jobs.lockedUntil, now),
            gte(jobs.attempts, jobs.maxAttempts),
          ),
        )
        .returning({ id: jobs.id });
      return updated.length;
    },

    async getById(jobId) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      return row === undefined ? null : toJob(row);
    },
  };
}
