import type { BackoffPolicy, JobRecord, Queue } from '@specledger/db';

import { notImplemented } from './not-implemented.js';

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
  return notImplemented('createWorker', options);
}
