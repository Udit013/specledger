import { LLM_ERROR_CODES, llmError } from '@specledger/llm';
import type { LlmErrorCode } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

import { describeFailure, JobError, jobErrorFromLlm } from './job-error.js';

describe('describeFailure', () => {
  it('keeps the code, retryability and message of a JobError', () => {
    expect(
      describeFailure(new JobError('INVALID_PAYLOAD', false, 'The job payload is invalid.')),
    ).toEqual({
      code: 'INVALID_PAYLOAD',
      retryable: false,
      lastError: 'INVALID_PAYLOAD: The job payload is invalid.',
    });
  });

  it.each([
    new Error(
      'duplicate key value violates unique constraint (detail: Key (quote)=(Rated flow 500 gpm))',
    ),
    'a thrown string',
    { message: 'an object' },
    undefined,
  ])('reports anything else as UNEXPECTED and retryable, discarding its text (%#)', (thrown) => {
    expect(describeFailure(thrown)).toEqual({
      code: 'UNEXPECTED',
      retryable: true,
      lastError: 'UNEXPECTED: An unexpected error occurred.',
    });
  });

  it('cuts the stored text to the column limit', () => {
    const failure = describeFailure(new JobError('X', true, 'y'.repeat(800)));
    expect(failure.lastError).toHaveLength(500);
    expect(failure.lastError.startsWith('X: yyy')).toBe(true);
  });
});

describe('jobErrorFromLlm', () => {
  const RETRYABLE: Record<LlmErrorCode, boolean> = {
    RATE_LIMITED: true,
    TIMEOUT: true,
    UNAVAILABLE: true,
    ABORTED: true,
    MODEL_RETIRED: false,
    AUTH_FAILED: false,
    SCHEMA_INVALID: false,
    REPLAY_MISS: false,
    BAD_REQUEST: false,
  };

  it('covers every LLM error code', () => {
    expect(Object.keys(RETRYABLE).sort()).toEqual([...LLM_ERROR_CODES].sort());
  });

  it.each(Object.entries(RETRYABLE) as [LlmErrorCode, boolean][])(
    '%s is retryable: %s',
    (code, retryable) => {
      const error = jobErrorFromLlm(llmError(code, 'The provider said something about page text.'));
      expect(error).toBeInstanceOf(JobError);
      expect(error).toMatchObject({ code: `LLM_${code}`, retryable });
      // The provider's message is fixed text already, but is not relied on: the job error uses its own.
      expect(error.message).not.toContain('page text');
    },
  );
});
