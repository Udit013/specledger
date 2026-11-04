import { z } from 'zod';

// Lifecycle: queued -> running -> succeeded; running -> queued again for a retry; running ->
// failed for a permanent error; running -> dead once attempts run out; dead -> queued on requeue.
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// Lower snake_case, like "process_document".
export const JOB_TYPE_PATTERN = '^[a-z][a-z0-9_]{0,62}$';
export const MAX_JOB_ATTEMPTS = 100;

export const jobRecordSchema = z.strictObject({
  id: z.uuid(),
  type: z.string().regex(new RegExp(JOB_TYPE_PATTERN)),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(200),
  status: z.enum(JOB_STATUSES),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().min(1).max(MAX_JOB_ATTEMPTS),
  runAt: z.date(),
  lockedUntil: z.date().nullable(),
  lockedBy: z.string().nullable(),
  lastError: z.string().nullable(),
  correlationId: z.uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;

export interface NewJob {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  readonly runAt: Date;
  readonly correlationId: string;
}

// What a failed attempt asks for. retryAt null means the error is permanent.
export interface JobFailure {
  readonly error: string;
  readonly retryAt: Date | null;
}

export type FailOutcome = 'queued' | 'failed' | 'dead';
