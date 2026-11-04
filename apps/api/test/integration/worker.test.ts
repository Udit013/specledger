import { randomUUID } from 'node:crypto';

import { backoffDelayMs } from '@specledger/db';
import type { JobRecord } from '@specledger/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobError } from '../../src/worker/job-error.js';
import { createWorker } from '../../src/worker/worker.js';
import type { JobHandler, Worker, WorkerOptions } from '../../src/worker/worker.js';
import { withTestDatabase } from '../support/test-db.js';

const testDb = withTestDatabase();
const T0 = Date.parse('2030-01-01T00:00:00.000Z');
const BACKOFF = { baseMs: 1_000, capMs: 60_000 };

// The injected clock: tests move it; the worker reads it for every timestamp it writes.
let now = T0;
const clock = () => new Date(now);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let workers: Worker[] = [];
function worker(
  handlers: Record<string, JobHandler>,
  overrides: Partial<WorkerOptions> = {},
): Worker {
  const created = createWorker({
    queue: testDb.database.jobs,
    handlers,
    workerId: `worker-${randomUUID().slice(0, 8)}`,
    clock,
    random: () => 0.5,
    logger: silent,
    pollIntervalMs: 10,
    concurrency: 2,
    visibilityMs: 5_000,
    heartbeatMs: 20,
    graceMs: 1_000,
    backoff: BACKOFF,
    ...overrides,
  });
  workers.push(created);
  return created;
}

async function enqueue(type = 'test_job', maxAttempts = 3): Promise<JobRecord> {
  const key = randomUUID();
  const { job } = await testDb.database.jobs.enqueue(
    {
      type,
      payload: { key },
      idempotencyKey: key,
      maxAttempts,
      runAt: clock(),
      correlationId: randomUUID(),
    },
    clock(),
  );
  return job;
}

const get = async (id: string) => {
  const job = await testDb.database.jobs.getById(id);
  if (job === null) throw new Error(`job ${id} is gone`);
  return job;
};

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const statusOf = (id: string) => waitForStatus(id);
const waitForStatus = (id: string, status?: JobRecord['status']) =>
  waitFor(
    () => get(id),
    (job) =>
      status === undefined
        ? job.status !== 'queued' && job.status !== 'running'
        : job.status === status,
  );

beforeEach(async () => {
  now = T0;
  await testDb.query('delete from jobs');
});

afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  workers = [];
});

describe('worker loop', () => {
  it('runs a queued job through its handler and completes it', async () => {
    const seen: string[] = [];
    const job = await enqueue();
    worker({ test_job: (claimed) => Promise.resolve(void seen.push(claimed.id)) }).start();
    expect(await statusOf(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      lockedBy: null,
    });
    expect(seen).toEqual([job.id]);
  });

  it('never runs more jobs at once than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const jobs = await Promise.all(Array.from({ length: 6 }, () => enqueue()));
    worker(
      {
        test_job: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 40));
          active -= 1;
        },
      },
      { concurrency: 2 },
    ).start();
    for (const job of jobs) await waitForStatus(job.id, 'succeeded');
    expect(peak).toBe(2);
  });

  it('stops claiming once stop is called', async () => {
    const w = worker({ test_job: () => Promise.resolve() });
    w.start();
    await w.stop();
    const job = await enqueue();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await get(job.id)).status).toBe('queued');
  });

  it('rejects options that cannot work', () => {
    expect(() => worker({}, { heartbeatMs: 5_000, visibilityMs: 5_000 })).toThrow(RangeError);
    expect(() => worker({}, { concurrency: 0 })).toThrow(RangeError);
    expect(() => worker({}, { pollIntervalMs: 0 })).toThrow(RangeError);
  });
});

describe('failures', () => {
  it('retries a retryable failure after a backoff from the injected random source', async () => {
    const job = await enqueue();
    worker({
      test_job: () =>
        Promise.reject(
          new JobError('LLM_RATE_LIMITED', true, 'The model provider rate-limited the request.'),
        ),
    }).start();
    const failed = await waitFor(
      () => get(job.id),
      (j) => j.lastError !== null,
    );
    expect(failed).toMatchObject({
      status: 'queued',
      attempts: 1,
      runAt: new Date(T0 + backoffDelayMs(1, BACKOFF, () => 0.5)),
      lastError: 'LLM_RATE_LIMITED: The model provider rate-limited the request.',
    });
  });

  it('fails a permanent error at once', async () => {
    const job = await enqueue();
    worker({
      test_job: () =>
        Promise.reject(new JobError('INVALID_PAYLOAD', false, 'The job payload is invalid.')),
    }).start();
    expect(await statusOf(job.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'INVALID_PAYLOAD: The job payload is invalid.',
    });
  });

  it('treats an unexpected exception as retryable and never stores its text', async () => {
    const job = await enqueue();
    worker({
      test_job: () => Promise.reject(new Error('page text: Rated flow 500 gpm, key AIza-secret')),
    }).start();
    const failed = await waitFor(
      () => get(job.id),
      (j) => j.lastError !== null,
    );
    expect(failed.status).toBe('queued');
    expect(failed.lastError).toBe('UNEXPECTED: An unexpected error occurred.');
  });

  it('dead-letters a job once its attempts run out', async () => {
    const job = await enqueue('test_job', 2);
    worker({
      test_job: () => Promise.reject(new JobError('LLM_TIMEOUT', true, 'The model timed out.')),
    }).start();
    await waitFor(
      () => get(job.id),
      (j) => j.attempts === 1 && j.status === 'queued',
    );
    now += BACKOFF.capMs;
    expect(await statusOf(job.id)).toMatchObject({ status: 'dead', attempts: 2 });
  });

  it('fails a job of a type that has no handler', async () => {
    const job = await enqueue('unknown_job');
    worker({ test_job: () => Promise.resolve() }).start();
    expect(await statusOf(job.id)).toMatchObject({
      status: 'failed',
      lastError: 'NO_HANDLER: No handler is registered for this job type.',
    });
  });

  it('reaps a lease that expired on the last attempt', async () => {
    const job = await enqueue('test_job', 1);
    await testDb.database.jobs.claim(clock(), 'ghost', 100);
    now += 200;
    worker({ test_job: () => Promise.resolve() }).start();
    expect(await statusOf(job.id)).toMatchObject({ status: 'dead', lockedBy: null });
  });
});

describe('leases', () => {
  it('renews the lease while a handler runs past the visibility timeout', async () => {
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job = await enqueue();
    worker({ test_job: () => finished }, { visibilityMs: 300, heartbeatMs: 20 }).start();
    await waitForStatus(job.id, 'running');
    now += 1_000; // past the first lease
    await waitFor(
      () => get(job.id),
      (j) => (j.lockedUntil?.getTime() ?? 0) >= now + 300,
    );
    expect(await testDb.database.jobs.claim(clock(), 'rival', 300)).toBeNull();
    finish();
    expect(await statusOf(job.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('aborts the handler and leaves the job alone when another worker takes it over', async () => {
    let aborted = false;
    const job = await enqueue();
    worker({
      test_job: (_job, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    }).start();
    await waitForStatus(job.id, 'running');
    await testDb.query(`update jobs set locked_by = 'rival' where id = $1`, [job.id]);
    await waitFor(
      () => Promise.resolve(aborted),
      (a) => a,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await get(job.id)).toMatchObject({
      status: 'running',
      lockedBy: 'rival',
      lastError: null,
    });
  });
});

describe('graceful shutdown', () => {
  it('lets an in-flight job finish within the grace period', async () => {
    const job = await enqueue();
    const w = worker(
      { test_job: () => new Promise((resolve) => setTimeout(resolve, 100)) },
      { graceMs: 2_000 },
    );
    w.start();
    await waitForStatus(job.id, 'running');
    await w.stop();
    expect(w.inFlight).toBe(0);
    expect((await get(job.id)).status).toBe('succeeded');
  });

  it('aborts and releases a job that outlives the grace period, within the grace period', async () => {
    let aborted = false;
    const job = await enqueue();
    const w = worker(
      {
        test_job: (_job, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      },
      { graceMs: 200 },
    );
    w.start();
    await waitForStatus(job.id, 'running');
    const started = Date.now();
    await w.stop();
    const took = Date.now() - started;
    expect(aborted).toBe(true);
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1_500);
    expect(w.inFlight).toBe(0);
    expect(await get(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      lockedBy: null,
      lastError: null,
    });
  });
});
