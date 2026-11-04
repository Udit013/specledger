import type { LlmError, LlmErrorCode } from '@specledger/llm';

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

const LAST_ERROR_LIMIT = 500;

// How the worker reads anything a handler threw. A JobError keeps its code and retryability.
// Anything else is UNEXPECTED, retryable (most unexpected failures are transient: a dropped
// connection, a deadlock), with a fixed message; its own text is discarded.
export function describeFailure(error: unknown): JobFailureInfo {
  const failure =
    error instanceof JobError
      ? error
      : new JobError('UNEXPECTED', true, 'An unexpected error occurred.');
  return {
    code: failure.code,
    retryable: failure.retryable,
    lastError: `${failure.code}: ${failure.message}`.slice(0, LAST_ERROR_LIMIT),
  };
}

const LLM_FAILURES: Readonly<Record<LlmErrorCode, { retryable: boolean; message: string }>> = {
  RATE_LIMITED: { retryable: true, message: 'The model provider rate-limited the request.' },
  TIMEOUT: { retryable: true, message: 'The model did not answer in time.' },
  UNAVAILABLE: { retryable: true, message: 'The model provider is unavailable.' },
  ABORTED: { retryable: true, message: 'The extraction was cancelled.' },
  MODEL_RETIRED: { retryable: false, message: 'The configured model is not available.' },
  AUTH_FAILED: { retryable: false, message: 'The model provider rejected the credentials.' },
  SCHEMA_INVALID: { retryable: false, message: 'The model kept answering outside the schema.' },
  REPLAY_MISS: { retryable: false, message: 'No recorded response exists for this request.' },
  BAD_REQUEST: { retryable: false, message: 'The model provider refused the request.' },
};

// An LlmError as a job failure, coded LLM_<code>. Retryable when another attempt can succeed:
// RATE_LIMITED, TIMEOUT, UNAVAILABLE and ABORTED (the attempt was cut short). Permanent
// otherwise: AUTH_FAILED and MODEL_RETIRED need a configuration change, SCHEMA_INVALID already
// exhausted the correction retries, REPLAY_MISS needs a recording, BAD_REQUEST will not change.
export function jobErrorFromLlm(error: LlmError): JobError {
  const { retryable, message } = LLM_FAILURES[error.code];
  return new JobError(`LLM_${error.code}`, retryable, message);
}
