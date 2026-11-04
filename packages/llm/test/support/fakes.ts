import { err, FIELD_DEFINITIONS, ok } from '@specledger/core';
import type { Result } from '@specledger/core';

import type { LlmError } from '../../src/errors.js';
import { llmError } from '../../src/errors.js';
import type { ModelCall, ModelClient, ModelReply } from '../../src/model-client.js';
import { PROMPT_VERSION } from '../../src/prompt.js';
import type { ExtractionRequest, ExtractionResponse, LlmProvider } from '../../src/types.js';

export const PAGE_ONE =
  'Centrifugal Pump Datasheet\nRated flow: 500 gpm (113.6 m3/h)\nRated head: 45 m';
export const PAGE_TWO = 'Efficiency: 78 %\nRated speed: 2900 to 3600 rpm';

export function pumpRequest(overrides: Partial<ExtractionRequest> = {}): ExtractionRequest {
  return {
    equipmentClass: 'centrifugal_pump',
    fields: [...FIELD_DEFINITIONS.centrifugal_pump],
    pages: [
      { pageNumber: 1, text: PAGE_ONE },
      { pageNumber: 2, text: PAGE_TWO },
    ],
    promptVersion: PROMPT_VERSION,
    synthetic: true,
    ...overrides,
  };
}

export const GOOD_OUTPUT = {
  candidates: [
    { fieldName: 'rated_flow', value: '500', unit: 'gpm', quote: 'Rated flow: 500 gpm', page: 1 },
  ],
};

const NO_USAGE = { inputTokens: 10, outputTokens: 5 };

// Answers each call with the next scripted reply and records every call it receives.
export function scriptedClient(
  replies: readonly (
    Result<ModelReply, LlmError> | (() => Promise<Result<ModelReply, LlmError>>)
  )[],
  modelId = 'fake-model',
): ModelClient & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  return {
    modelId,
    calls,
    generate(call) {
      calls.push(call);
      const next = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (next === undefined) throw new Error('scriptedClient has no replies');
      return typeof next === 'function' ? next() : Promise.resolve(next);
    },
  };
}

export const objectReply = (value: unknown): Result<ModelReply, LlmError> =>
  ok({ kind: 'object', value, usage: NO_USAGE });

export function response(
  modelId: string,
  overrides: Partial<ExtractionResponse> = {},
): ExtractionResponse {
  return {
    modelId,
    promptVersion: PROMPT_VERSION,
    candidates: GOOD_OUTPUT.candidates,
    usage: NO_USAGE,
    ...overrides,
  };
}

// A provider that answers with fixed results in turn and counts its calls.
export function fakeProvider(
  name: string,
  results: readonly Result<ExtractionResponse, LlmError>[],
): LlmProvider & { calls: number } {
  return {
    name,
    modelId: `${name}-model`,
    calls: 0,
    extract() {
      this.calls += 1;
      const result = results[Math.min(this.calls - 1, results.length - 1)];
      return Promise.resolve(result ?? err(llmError('UNAVAILABLE', 'no scripted result')));
    },
  };
}

export const okResult = (modelId: string) => ok(response(modelId));
