import { err } from '@specledger/core';
import type { Result } from '@specledger/core';

import { canFailOver, llmError } from './errors.js';
import type { LlmError } from './errors.js';
import type { ExtractionResponse, LlmProvider } from './types.js';

export interface FailoverOptions {
  // Tried in this order.
  readonly providers: readonly LlmProvider[];
  // How long a provider is skipped after a fail-over-able error.
  readonly cooldownMs: number;
  // Milliseconds; injected so tests control time.
  readonly now: () => number;
}

// Tries providers in order. It moves on only for fail-over-able errors (see errors.ts), and then
// rests that provider for cooldownMs; any other error is returned at once.
export function createFailoverProvider(options: FailoverOptions): LlmProvider {
  if (options.providers.length === 0) {
    throw new Error('FailoverProvider needs at least one provider');
  }
  const restingUntil = new Map<number, number>();
  return {
    name: `failover(${options.providers.map((p) => p.name).join(',')})`,
    modelId: options.providers.map((p) => p.modelId).join('|'),
    async extract(request, extractOptions): Promise<Result<ExtractionResponse, LlmError>> {
      let last: LlmError | undefined;
      for (const [index, provider] of options.providers.entries()) {
        if ((restingUntil.get(index) ?? -Infinity) > options.now()) continue;
        if (extractOptions.signal?.aborted === true) {
          return err(llmError('ABORTED', 'The request was cancelled.'));
        }
        const result = await provider.extract(request, extractOptions);
        if (result.ok || !canFailOver(result.error.code)) return result;
        restingUntil.set(index, options.now() + options.cooldownMs);
        last = result.error;
      }
      return err(
        last ?? llmError('UNAVAILABLE', 'Every provider is cooling down after recent failures.'),
      );
    },
  };
}
