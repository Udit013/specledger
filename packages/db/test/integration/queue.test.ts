import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { NewJob } from '../../src/queue-types.js';
import { withTestDb } from '../support/test-db.js';

// Concurrency tests need connections for many claimers at once.
const testDb = withTestDb({ maxConnections: 24 });

// The injected clock starts years after the real one, so a query that used NOW() instead of its
// time parameter would find nothing due and fail these tests.
const T0 = Date.parse('2030-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);
const VISIBILITY = 1_000;

const newJob = (key: string, overrides: Partial<NewJob> = {}): NewJob => ({
  type: 'process_document',
  payload: { documentId: key },
  idempotencyKey: key,
  maxAttempts: 3,
  runAt: at(0),
  correlationId: randomUUID(),
  ...overrides,
});

const queue = () => testDb.database.jobs;

async function enqueue(key: string, overrides: Partial<NewJob> = {}) {
  const { job } = await queue().enqueue(newJob(key, overrides), at(0));
  return job;
}

// Each test starts with an empty queue: claim takes any due job in the table.
beforeEach(async () => {
  await testDb.query('delete from jobs');
});

describe('enqueue', () => {
  it('adds a queued job stamped with the given time', async () => {
    const correlationId = randomUUID();
    const { job, created } = await queue().enqueue(newJob('a', { correlationId }), at(5));
    expect(created).toBe(true);
    expect(job).toMatchObject({
      type: 'process_document',
      payload: { documentId: 'a' },
      idempotencyKey: 'a',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      runAt: at(0),
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      correlationId,
      createdAt: at(5),
      updatedAt: at(5),
    });
  });

  it('returns the existing job for a repeated idempotency key', async () => {
    const first = await queue().enqueue(newJob('a'), at(0));
    const again = await queue().enqueue(newJob('a', { payload: { other: true } }), at(9));
    expect(again).toEqual({ job: first.job, created: false });
  });

  it('stores one job when the same key is enqueued concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => queue().enqueue(newJob('same'), at(0))),
    );
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await testDb.query('select count(*)::int as n from jobs')).rows).toEqual([{ n: 1 }]);
  });

  it('commits or rolls back with the transaction it runs in', async () => {
    await expect(
      testDb.database.transaction(async (tx) => {
        await tx.jobs.enqueue(newJob('rolled-back'), at(0));
        throw new Error('the caller failed after enqueueing');
      }),
    ).rejects.toThrow('the caller failed');
    await testDb.database.transaction(async (tx) => {
      await tx.jobs.enqueue(newJob('committed'), at(0));
    });
    const keys = await testDb.query('select idempotency_key from jobs');
    expect(keys.rows).toEqual([{ idempotency_key: 'committed' }]);
  });
});

describe('claim', () => {
  it('leases the job to the worker, counting the attempt', async () => {
    const job = await enqueue('a');
    const claimed = await queue().claim(at(10), 'w1', VISIBILITY);
    expect(claimed).toMatchObject({
      id: job.id,
      status: 'running',
      attempts: 1,
      lockedBy: 'w1',
      lockedUntil: at(10 + VISIBILITY),
      updatedAt: at(10),
    });
  });

  it('returns null when nothing is due', async () => {
    expect(await queue().claim(at(0), 'w1', VISIBILITY)).toBeNull();
  });

  it('waits for run_at, inclusive', async () => {
    await enqueue('later', { runAt: at(500) });
    expect(await queue().claim(at(499), 'w1', VISIBILITY)).toBeNull();
    expect(await queue().claim(at(500), 'w1', VISIBILITY)).toMatchObject({
      idempotencyKey: 'later',
    });
  });

  it('takes the job that has been due longest first', async () => {
    await enqueue('second', { runAt: at(20) });
    await enqueue('first', { runAt: at(10) });
    expect((await queue().claim(at(30), 'w1', VISIBILITY))?.idempotencyKey).toBe('first');
    expect((await queue().claim(at(30), 'w1', VISIBILITY))?.idempotencyKey).toBe('second');
  });

  it('gives each of 100 jobs to exactly one of 20 concurrent claimers', async () => {
    await Promise.all(Array.from({ length: 100 }, (_, i) => enqueue(`job-${String(i)}`)));
    const claims = await Promise.all(
      Array.from({ length: 20 }, async (_, worker) => {
        const mine: string[] = [];
        for (;;) {
          const job = await queue().claim(at(10), `w${String(worker)}`, 60_000);
          if (job === null) return mine;
          mine.push(job.id);
        }
      }),
    );
    const all = claims.flat();
    expect(all).toHaveLength(100);
    expect(new Set(all).size).toBe(100);
    expect(claims.filter((mine) => mine.length > 0).length).toBeGreaterThan(1);
  });

  it('skips a job locked by another transaction instead of waiting for it', async () => {
    const locked = await enqueue('locked', { runAt: at(0) });
    await enqueue('free', { runAt: at(1) });
    const client = await testDb.client();
    try {
      await client.query('begin');
      await client.query('select id from jobs where id = $1 for update', [locked.id]);
      const timeout = new Promise<'blocked'>((resolve) => {
        setTimeout(() => {
          resolve('blocked');
        }, 2_000);
      });
      const claimed = await Promise.race([queue().claim(at(10), 'w1', VISIBILITY), timeout]);
      expect(claimed).not.toBe('blocked');
      expect(claimed === 'blocked' ? null : claimed?.idempotencyKey).toBe('free');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('lease expiry and takeover', () => {
  it('makes a job whose worker stopped heartbeating claimable after locked_until', async () => {
    const job = await enqueue('a');
    await queue().claim(at(0), 'w1', VISIBILITY);
    expect(await queue().claim(at(VISIBILITY - 1), 'w2', VISIBILITY)).toBeNull();
    expect(await queue().claim(at(VISIBILITY), 'w2', VISIBILITY)).toBeNull();
    expect(await queue().claim(at(VISIBILITY + 1), 'w2', VISIBILITY)).toMatchObject({
      id: job.id,
      attempts: 2,
      lockedBy: 'w2',
      lockedUntil: at(2 * VISIBILITY + 1),
    });
  });

  it('does not take over an expired lease with no attempts left, and the reaper marks it dead', async () => {
    const job = await enqueue('last', { maxAttempts: 1 });
    await queue().claim(at(0), 'w1', VISIBILITY);
    expect(await queue().claim(at(VISIBILITY + 1), 'w2', VISIBILITY)).toBeNull();
    expect(await queue().reapExpired(at(VISIBILITY))).toBe(0);
    expect(await queue().reapExpired(at(VISIBILITY + 1))).toBe(1);
    expect(await queue().getById(job.id)).toMatchObject({
      status: 'dead',
      lockedBy: null,
      lockedUntil: null,
      lastError: 'LEASE_EXPIRED: the worker stopped renewing its lease on the last attempt',
      updatedAt: at(VISIBILITY + 1),
    });
  });
});

describe('fencing', () => {
  // w1 claims, its lease expires, w2 takes the job over.
  async function takenOver() {
    const job = await enqueue('a');
    await queue().claim(at(0), 'w1', VISIBILITY);
    await queue().claim(at(VISIBILITY + 1), 'w2', VISIBILITY);
    const before = await queue().getById(job.id);
    return { job, before };
  }

  it('lets the holder extend its lease', async () => {
    const job = await enqueue('a');
    await queue().claim(at(0), 'w1', VISIBILITY);
    expect(await queue().heartbeat(job.id, 'w1', at(800), VISIBILITY)).toBe(true);
    expect(await queue().claim(at(1_500), 'w2', VISIBILITY)).toBeNull();
    expect(await queue().getById(job.id)).toMatchObject({
      lockedUntil: at(1_800),
      updatedAt: at(800),
    });
  });

  it('rejects a heartbeat from a worker that lost the lease, changing nothing', async () => {
    const { job, before } = await takenOver();
    expect(await queue().heartbeat(job.id, 'w1', at(1_500), VISIBILITY)).toBe(false);
    expect(await queue().getById(job.id)).toEqual(before);
  });

  it('rejects completion by a stale worker, changing nothing', async () => {
    const { job, before } = await takenOver();
    expect(await queue().complete(job.id, 'w1', at(1_500))).toBe(false);
    expect(await queue().getById(job.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'running', lockedBy: 'w2', attempts: 2 });
  });

  it('rejects a failure report by a stale worker, changing nothing', async () => {
    const { job, before } = await takenOver();
    expect(
      await queue().fail(job.id, 'w1', at(1_500), { error: 'X: x', retryAt: null }),
    ).toBeNull();
    expect(await queue().getById(job.id)).toEqual(before);
  });

  it('lets the current holder complete, once', async () => {
    const { job } = await takenOver();
    expect(await queue().complete(job.id, 'w2', at(1_500))).toBe(true);
    expect(await queue().complete(job.id, 'w2', at(1_600))).toBe(false);
    expect(await queue().getById(job.id)).toMatchObject({
      status: 'succeeded',
      lockedBy: null,
      lockedUntil: null,
      updatedAt: at(1_500),
    });
  });

  it('rejects acting on a job that was never claimed', async () => {
    const job = await enqueue('a');
    expect(await queue().complete(job.id, 'w1', at(1))).toBe(false);
    expect(await queue().heartbeat(job.id, 'w1', at(1), VISIBILITY)).toBe(false);
    expect(await queue().release(job.id, 'w1', at(1))).toBe(false);
    expect(await queue().getById(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('failure, retry and dead letter', () => {
  it('queues a retryable failure again at its retry time', async () => {
    const job = await enqueue('a');
    await queue().claim(at(0), 'w1', VISIBILITY);
    const outcome = await queue().fail(job.id, 'w1', at(100), {
      error: 'LLM_RATE_LIMITED: the model provider rate-limited the request',
      retryAt: at(5_000),
    });
    expect(outcome).toBe('queued');
    expect(await queue().getById(job.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      runAt: at(5_000),
      lockedBy: null,
      lockedUntil: null,
      lastError: 'LLM_RATE_LIMITED: the model provider rate-limited the request',
      updatedAt: at(100),
    });
    expect(await queue().claim(at(4_999), 'w1', VISIBILITY)).toBeNull();
    expect(await queue().claim(at(5_000), 'w1', VISIBILITY)).toMatchObject({ attempts: 2 });
  });

  it('marks a permanent failure failed', async () => {
    const job = await enqueue('a');
    await queue().claim(at(0), 'w1', VISIBILITY);
    expect(
      await queue().fail(job.id, 'w1', at(1), { error: 'INVALID_PAYLOAD: bad', retryAt: null }),
    ).toBe('failed');
    expect(await queue().getById(job.id)).toMatchObject({ status: 'failed', lockedBy: null });
    expect(await queue().claim(at(10_000), 'w1', VISIBILITY)).toBeNull();
  });

  it('dead-letters a job after max_attempts and lets it be requeued', async () => {
    const job = await enqueue('a', { maxAttempts: 2 });
    for (const [attempt, expected] of [
      [1, 'queued'],
      [2, 'dead'],
    ] as const) {
      const claimed = await queue().claim(at(attempt * 10), 'w1', VISIBILITY);
      expect(claimed?.attempts).toBe(attempt);
      expect(
        await queue().fail(job.id, 'w1', at(attempt * 10 + 1), {
          error: 'UNEXPECTED: boom',
          retryAt: at(attempt * 10 + 5),
        }),
      ).toBe(expected);
    }
    expect(await queue().getById(job.id)).toMatchObject({ status: 'dead', attempts: 2 });
    expect(await queue().claim(at(1_000), 'w1', VISIBILITY)).toBeNull();

    expect(await queue().requeue(job.id, at(2_000))).toBe(true);
    expect(await queue().getById(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      runAt: at(2_000),
      updatedAt: at(2_000),
    });
    expect(await queue().claim(at(2_000), 'w1', VISIBILITY)).toMatchObject({ attempts: 1 });
  });

  it('requeues only dead jobs', async () => {
    const job = await enqueue('a');
    expect(await queue().requeue(job.id, at(1))).toBe(false);
    await queue().claim(at(1), 'w1', VISIBILITY);
    expect(await queue().requeue(job.id, at(2))).toBe(false);
    expect(await queue().requeue(randomUUID(), at(2))).toBe(false);
  });
});

describe('release', () => {
  it('gives the job back without counting the attempt', async () => {
    const job = await enqueue('a');
    await queue().claim(at(0), 'w1', VISIBILITY);
    expect(await queue().release(job.id, 'w1', at(50))).toBe(true);
    expect(await queue().getById(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      runAt: at(50),
      lockedBy: null,
      lockedUntil: null,
    });
    expect(await queue().claim(at(50), 'w2', VISIBILITY)).toMatchObject({
      attempts: 1,
      lockedBy: 'w2',
    });
  });

  it('rejects a release by a worker that does not hold the lease', async () => {
    const job = await enqueue('a');
    await queue().claim(at(0), 'w1', VISIBILITY);
    expect(await queue().release(job.id, 'w2', at(50))).toBe(false);
    expect(await queue().getById(job.id)).toMatchObject({ status: 'running', lockedBy: 'w1' });
  });
});

describe('getById', () => {
  it('returns null for an unknown job', async () => {
    expect(await queue().getById(randomUUID())).toBeNull();
  });
});
