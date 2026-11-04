import type { LlmError } from '@specledger/llm';

import { notImplemented } from './not-implemented.js';

// An expected failure of a job, with a stable code, a fixed message and whether trying again can
// help. Only the code and message are ever stored (jobs.last_error) or logged: never an
// exception's own text, which can carry document content, prompts or query parameters.
export class JobError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean, message: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface JobFailureInfo {
  readonly code: string;
  readonly retryable: boolean;
  // "CODE: message", at most 500 characters: what jobs.last_error stores.
  readonly lastError: string;
}

// How the worker reads anything a handler threw. A JobError keeps its code and retryability.
// Anything else is UNEXPECTED, retryable (most unexpected failures are transient: a dropped
// connection, a deadlock), with a fixed message; its own text is discarded.
export function describeFailure(error: unknown): JobFailureInfo {
  return notImplemented('describeFailure', error);
}

// An LlmError as a job failure, coded LLM_<code>. Retryable when another attempt can succeed:
// RATE_LIMITED, TIMEOUT, UNAVAILABLE and ABORTED (the attempt was cut short). Permanent
// otherwise: AUTH_FAILED and MODEL_RETIRED need a configuration change, SCHEMA_INVALID already
// exhausted the correction retries, REPLAY_MISS needs a recording, BAD_REQUEST will not change.
export function jobErrorFromLlm(error: LlmError): JobError {
  return notImplemented('jobErrorFromLlm', error);
}
