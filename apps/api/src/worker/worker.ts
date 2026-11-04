import { backoffDelayMs } from '@specledger/db';
import type { BackoffPolicy, JobRecord, Queue } from '@specledger/db';

import { describeFailure } from './job-error.js';

// The queue operations the worker needs; @specledger/db's Queue provides them.
export type WorkerQueue = Pick<
  Queue,
  'claim' | 'heartbeat' | 'complete' | 'fail' | 'release' | 'reapExpired'
>;

export interface JobContext {
  // Aborted when the worker loses the job's lease or the shutdown grace period ends. A handler
  // must stop promptly and must not write after it fires.
  readonly signal: AbortSignal;
}

// Does the work of one job. Resolves when done; throws (preferably a JobError) when it failed.
export type JobHandler = (job: JobRecord, context: JobContext) => Promise<void>;

export interface WorkerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WorkerOptions {
  readonly queue: WorkerQueue;
  // By job type. A job of a type with no handler fails permanently (NO_HANDLER).
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly workerId: string;
  // Injected so every timestamp the worker writes is controlled by tests.
  readonly clock: () => Date;
  // In [0, 1), for backoff jitter.
  readonly random: () => number;
  readonly logger: WorkerLogger;
  // How long to wait before polling again when nothing was due.
  readonly pollIntervalMs: number;
  // Jobs handled at once.
  readonly concurrency: number;
  // Lease length; renewed every heartbeatMs, which must be shorter.
  readonly visibilityMs: number;
  readonly heartbeatMs: number;
  // On stop, how long in-flight jobs may run before they are aborted and released.
  readonly graceMs: number;
  readonly backoff: BackoffPolicy;
}

export interface Worker {
  // Starts polling. Calling it twice has no further effect.
  start(): void;
  // Stops claiming at once, waits up to graceMs for in-flight jobs, then aborts the rest and
  // releases them back to the queue. Resolves when no job is in flight.
  stop(): Promise<void>;
  // Jobs being handled now.
  readonly inFlight: number;
}

// The worker loop. Each poll it reaps leases that expired on their last attempt, then claims jobs
// while fewer than `concurrency` are in flight. For each job it renews the lease every
// heartbeatMs; if a renewal is refused (another worker took the job over) it aborts the handler
// and leaves the job alone. When the handler resolves it completes the job; when it throws, it
// fails the job: retryable failures are retried at now + backoffDelayMs(attempts), permanent ones
// fail at once. Every queue call is fenced by workerId, so a stale worker changes nothing.
export function createWorker(options: WorkerOptions): Worker {
  validate(options);
  const { queue, handlers, workerId, clock, logger } = options;

  interface InFlight {
    readonly controller: AbortController;
    done: Promise<void>;
    // Set when the worker gave the job back (shutdown) or lost its lease: it then writes nothing
    // more for the job, whatever the handler does.
    letGo: boolean;
  }
  const inFlight = new Map<string, InFlight>();
  let running = false;
  let loop: Promise<void> | null = null;
  // Cuts the current wait short, when a slot frees up or stop is called.
  let wake: () => void = () => undefined;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const context = (job: JobRecord) => ({
    workerId,
    jobId: job.id,
    type: job.type,
    attempt: job.attempts,
    correlationId: job.correlationId,
  });

  async function settle(job: JobRecord, entry: InFlight, handler: JobHandler | undefined) {
    if (handler === undefined) {
      const outcome = await queue.fail(job.id, workerId, clock(), {
        error: 'NO_HANDLER: No handler is registered for this job type.',
        retryAt: null,
      });
      logger.error({ ...context(job), outcome }, 'job has no handler');
      return;
    }
    try {
      await handler(job, { signal: entry.controller.signal });
    } catch (error: unknown) {
      if (entry.letGo) return;
      const failure = describeFailure(error);
      const now = clock();
      const retryAt = failure.retryable
        ? new Date(now.getTime() + backoffDelayMs(job.attempts, options.backoff, options.random))
        : null;
      const outcome = await queue.fail(job.id, workerId, now, {
        error: failure.lastError,
        retryAt,
      });
      logger.warn({ ...context(job), code: failure.code, outcome }, 'job failed');
      return;
    }
    if (entry.letGo) return;
    const completed = await queue.complete(job.id, workerId, clock());
    if (completed) logger.info(context(job), 'job succeeded');
    else logger.warn(context(job), 'job finished after its lease was lost; result not recorded');
  }

  function begin(job: JobRecord) {
    const entry: InFlight = {
      controller: new AbortController(),
      done: Promise.resolve(),
      letGo: false,
    };
    const heartbeat = setInterval(() => {
      queue.heartbeat(job.id, workerId, clock(), options.visibilityMs).then(
        (held) => {
          if (held || entry.letGo) return;
          // Another worker took the job over: stop the handler and leave the job to it.
          entry.letGo = true;
          entry.controller.abort();
          logger.warn(context(job), 'lease lost; handler aborted');
        },
        () => {
          logger.warn(context(job), 'heartbeat failed; the lease may expire');
        },
      );
    }, options.heartbeatMs);
    entry.done = settle(job, entry, handlers[job.type])
      .catch(() => {
        // A queue call failed after the handler finished. The lease expires and the job is
        // claimed again; the handler is idempotent, so the retry is safe.
        logger.error(context(job), 'could not record the job outcome');
      })
      .finally(() => {
        clearInterval(heartbeat);
        inFlight.delete(job.id);
        wake();
      });
    inFlight.set(job.id, entry);
  }

  async function poll() {
    while (running) {
      if (inFlight.size >= options.concurrency) {
        await wait(options.pollIntervalMs);
        continue;
      }
      let job: JobRecord | null;
      try {
        await queue.reapExpired(clock());
        job = await queue.claim(clock(), workerId, options.visibilityMs);
      } catch {
        logger.error({ workerId }, 'polling the queue failed');
        await wait(options.pollIntervalMs);
        continue;
      }
      if (job === null) {
        await wait(options.pollIntervalMs);
      } else if (inFlight.has(job.id)) {
        // This worker is still running the job, but paused for longer than the lease (a long GC
        // pause, a suspended machine) and has just claimed it again. Fencing is by worker id, so
        // two copies in one worker could not be told apart: keep the running attempt, which the
        // new lease now covers, and do not start a second one.
        logger.warn(context(job), 'reclaimed a job already in flight; not starting it again');
      } else {
        begin(job);
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = poll();
    },
    async stop() {
      running = false;
      wake();
      await loop;
      loop = null;
      const pending = [...inFlight.entries()];
      if (pending.length === 0) return;
      const finished = Promise.all(pending.map(([, entry]) => entry.done)).then(() => true);
      const graceOver = new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, options.graceMs);
      });
      if (await Promise.race([finished, graceOver])) return;
      // The grace period is over: abort what is still running and give it back to the queue.
      const stragglers = [...inFlight.entries()];
      await Promise.all(
        stragglers.map(async ([jobId, entry]) => {
          entry.letGo = true;
          entry.controller.abort();
          const released = await queue.release(jobId, workerId, clock()).catch(() => false);
          logger.warn({ workerId, jobId, released }, 'job released at shutdown');
        }),
      );
      // Handlers that honour their signal settle almost at once; one that ignores it is not
      // waited for beyond another grace period, since its job is already released.
      await Promise.race([
        Promise.all(stragglers.map(([, entry]) => entry.done)),
        new Promise((resolve) => setTimeout(resolve, options.graceMs)),
      ]);
    },
    get inFlight() {
      return inFlight.size;
    },
  };
}

function validate(options: WorkerOptions): void {
  const positiveInteger = (value: number) => Number.isInteger(value) && value > 0;
  if (!positiveInteger(options.pollIntervalMs))
    throw new RangeError('pollIntervalMs must be a positive integer');
  if (!positiveInteger(options.concurrency))
    throw new RangeError('concurrency must be a positive integer');
  if (!positiveInteger(options.visibilityMs))
    throw new RangeError('visibilityMs must be a positive integer');
  if (!positiveInteger(options.heartbeatMs) || options.heartbeatMs >= options.visibilityMs) {
    throw new RangeError('heartbeatMs must be a positive integer below visibilityMs');
  }
  if (!Number.isInteger(options.graceMs) || options.graceMs < 0) {
    throw new RangeError('graceMs must be a non-negative integer');
  }
}
