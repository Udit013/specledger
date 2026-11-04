import { randomUUID } from 'node:crypto';

import type { LlmProvider } from './types.js';

// The subset of pino the llm package uses, so it does not depend on a logging library.
export interface LlmLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

// Logs one line per extraction: ids, model, latency, outcome and token counts. Never page text,
// prompts, candidates or error details (which may name what the model sent back).
export function withLogging(
  inner: LlmProvider,
  logger: LlmLogger,
  now: () => number = () => performance.now(),
): LlmProvider {
  return {
    name: inner.name,
    modelId: inner.modelId,
    async extract(request, options) {
      const requestId = options.requestId ?? randomUUID();
      const started = now();
      const result = await inner.extract(request, { ...options, requestId });
      const fields = {
        requestId,
        provider: inner.name,
        model: result.ok ? result.value.modelId : inner.modelId,
        promptVersion: request.promptVersion,
        pageCount: request.pages.length,
        latencyMs: Math.round(now() - started),
        outcome: result.ok ? 'ok' : result.error.code,
        ...(result.ok
          ? {
              candidates: result.value.candidates.length,
              inputTokens: result.value.usage.inputTokens,
              outputTokens: result.value.usage.outputTokens,
            }
          : {}),
      };
      if (result.ok) logger.info(fields, 'llm extraction finished');
      else logger.warn(fields, 'llm extraction failed');
      return result;
    },
  };
}
