import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { err, ok } from '@specledger/core';
import type { Result } from '@specledger/core';
import { APICallError, generateText, NoObjectGeneratedError, Output } from 'ai';

import { llmError } from './errors.js';
import type { LlmError } from './errors.js';
import { describeIssues, extractWithClient } from './model-client.js';
import type { ClientSettings, ModelCall, ModelClient, ModelReply } from './model-client.js';
import type { LlmProvider, TokenUsage } from './types.js';

// A stable free-tier model at the time of writing (ai.google.dev model list, November 2026).
// Configurable because models are retired; a retired id surfaces as MODEL_RETIRED.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

export interface GeminiOptions extends ClientSettings {
  readonly apiKey: string;
  readonly modelId: string;
  // Replaces the HTTP client; tests pass a fake so no request leaves the process.
  readonly fetch?: typeof globalThis.fetch;
}

// Maps an HTTP failure to the taxonomy. The response body is not kept: it can echo the prompt.
export function errorForStatus(status: number | undefined): LlmError {
  if (status === 429)
    return llmError('RATE_LIMITED', 'The model provider rate-limited the request.', { status });
  if (status === 401 || status === 403) {
    return llmError('AUTH_FAILED', 'The model provider rejected the API key.', { status });
  }
  if (status === 404) {
    return llmError('MODEL_RETIRED', 'The configured model is not available at the provider.', {
      status,
    });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return llmError('BAD_REQUEST', 'The model provider rejected the request.', { status });
  }
  return llmError(
    'UNAVAILABLE',
    'The model provider is unavailable.',
    status === undefined ? undefined : { status },
  );
}

const usageOf = (
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
): TokenUsage => ({
  inputTokens: usage?.inputTokens ?? null,
  outputTokens: usage?.outputTokens ?? null,
});

// The issues of output the SDK refused, computed with our schema so they carry paths only.
function invalidReply(call: ModelCall, error: NoObjectGeneratedError): ModelReply {
  let issues: string[] = ['(root): output is not valid JSON'];
  if (error.text !== undefined) {
    try {
      const parsed = call.schema.safeParse(JSON.parse(error.text));
      if (!parsed.success) issues = describeIssues(parsed.error);
    } catch {
      // Not JSON; keep the generic issue.
    }
  }
  return { kind: 'invalid', issues, usage: usageOf(error.usage) };
}

function geminiClient(options: GeminiOptions): ModelClient {
  const google = createGoogleGenerativeAI({
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const model = google(options.modelId);
  return {
    modelId: options.modelId,
    async generate(call): Promise<Result<ModelReply, LlmError>> {
      try {
        const result = await generateText({
          model,
          instructions: call.system,
          messages: call.messages.map((message) => ({ ...message })),
          output: Output.object({ schema: call.schema }),
          temperature: 0,
          // No hidden retries: retrying, and deciding to fail over, belongs to the caller.
          maxRetries: 0,
          abortSignal: call.signal,
        });
        return ok({ kind: 'object', value: result.output, usage: usageOf(result.usage) });
      } catch (error: unknown) {
        if (NoObjectGeneratedError.isInstance(error)) return ok(invalidReply(call, error));
        if (APICallError.isInstance(error)) return err(errorForStatus(error.statusCode));
        // Network failures and aborts; extractWithClient turns an abort into TIMEOUT or ABORTED.
        return err(errorForStatus(undefined));
      }
    },
  };
}

// Gemini through the Vercel AI SDK's structured output. Free-tier content may be used to improve
// Google's products, so only requests flagged synthetic are sent; anything else is refused before
// a connection is made.
export function createGeminiProvider(options: GeminiOptions): LlmProvider {
  if (options.apiKey.trim() === '') throw new Error('GeminiProvider needs an API key');
  const client = geminiClient(options);
  return {
    name: 'gemini',
    modelId: options.modelId,
    async extract(request, extractOptions) {
      if (!request.synthetic) {
        return err(
          llmError('BAD_REQUEST', 'Only synthetic documents may be sent to the Gemini free tier.'),
        );
      }
      return extractWithClient(client, request, extractOptions, options);
    },
  };
}
