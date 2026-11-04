// Every way a model call can fail, defined once.
//
// Fail-over-able: the next provider may well succeed, because the failure belongs to this
// provider or this moment, not to the request.
//   RATE_LIMITED   quota or rate limit (HTTP 429)
//   TIMEOUT        no answer within the time limit
//   UNAVAILABLE    network failure or 5xx; the service is down or overloaded
//   MODEL_RETIRED  the configured model id no longer exists (HTTP 404)
//
// Not fail-over-able: another provider would fail the same way, or should not be asked at all.
//   AUTH_FAILED    the key is wrong or revoked; a configuration fault to fix, not to route around
//   SCHEMA_INVALID the model kept answering outside the schema after the correction retries; the
//                  request reached a model and was answered, so the result is "unverified", and
//                  asking another model silently would hide a prompt or schema problem
//   REPLAY_MISS    no recording for this request; a missing fixture is a test or demo fault
//   BAD_REQUEST    the request itself is invalid or refused (for example, not synthetic)
//   ABORTED        the caller cancelled; nobody is waiting for another provider's answer
export const LLM_ERROR_CODES = [
  'RATE_LIMITED',
  'TIMEOUT',
  'UNAVAILABLE',
  'MODEL_RETIRED',
  'AUTH_FAILED',
  'SCHEMA_INVALID',
  'REPLAY_MISS',
  'BAD_REQUEST',
  'ABORTED',
] as const;

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

const FAIL_OVER: ReadonlySet<LlmErrorCode> = new Set([
  'RATE_LIMITED',
  'TIMEOUT',
  'UNAVAILABLE',
  'MODEL_RETIRED',
]);

export const canFailOver = (code: LlmErrorCode): boolean => FAIL_OVER.has(code);

// Details never carry prompt text, document text, response bodies or credentials.
export interface LlmErrorDetails {
  readonly status?: number;
  readonly attempts?: number;
  // Schema problems as "path: problem", without the offending values.
  readonly issues?: readonly string[];
  readonly key?: string;
  readonly howToRecord?: string;
}

export interface LlmError {
  readonly code: LlmErrorCode;
  readonly message: string;
  readonly details?: LlmErrorDetails;
}

export function llmError(code: LlmErrorCode, message: string, details?: LlmErrorDetails): LlmError {
  return details === undefined ? { code, message } : { code, message, details };
}
