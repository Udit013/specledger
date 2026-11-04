import { extractionSetSchema } from '@specledger/eval';
import type { EvalDocument } from '@specledger/eval';
import { llmError } from '@specledger/llm';
import type { LlmProvider } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

import { recordExtractions } from './record-extractions.js';

const doc = (id: string, pages: string[] | null): EvalDocument => ({
  id,
  split: 'dev',
  cases: ['baseline'],
  pages,
  truth: {
    schemaVersion: 1,
    documentId: id,
    lineageId: id,
    equipmentTag: id.toUpperCase(),
    equipmentClass: 'centrifugal_pump',
    sourceType: 'datasheet',
    revision: null,
    pageCount: 1,
    textLayer: pages !== null,
    fields: {},
  },
});

// A provider that answers from a script, recording what it was asked. No network.
function scripted(
  answers: ('ok' | 'rate_limited' | 'timeout')[],
): LlmProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: 'scripted',
    modelId: 'scripted-model',
    asked,
    extract(request, options) {
      asked.push(`${options.requestId ?? ''}:${String(request.synthetic)}`);
      const next = answers.shift() ?? 'ok';
      if (next === 'rate_limited')
        return Promise.resolve({ ok: false, error: llmError('RATE_LIMITED', 'rate limited') });
      if (next === 'timeout')
        return Promise.resolve({ ok: false, error: llmError('TIMEOUT', 'timeout') });
      return Promise.resolve({
        ok: true,
        value: {
          candidates: [
            { fieldName: 'rated_head', value: '45', unit: 'm', quote: 'Rated head 45 m', page: 1 },
          ],
          modelId: 'scripted-model',
          promptVersion: request.promptVersion,
          usage: { inputTokens: null, outputTokens: null },
        },
      });
    },
  };
}

const base = {
  modelId: 'scripted-model',
  promptVersion: 'v-test',
  date: '2030-01-01',
  corpusSha256: 'c'.repeat(64),
  pauseMs: 4_500,
  rateLimitWaitMs: 60_000,
  maxRateLimitRetries: 2,
  timeoutMs: 1_000,
};

describe('recordExtractions', () => {
  it('records a labelled set, sending only synthetic requests, pausing between calls', async () => {
    const waits: number[] = [];
    const provider = scripted(['ok', 'ok']);
    const set = await recordExtractions({
      ...base,
      provider,
      documents: [
        doc('p-2', ['Rated head 45 m']),
        doc('p-1', ['Rated head 45 m']),
        doc('p-scan', null),
      ],
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(extractionSetSchema.safeParse(set).success).toBe(true);
    expect(set).toMatchObject({
      origin: 'recorded',
      modelId: 'scripted-model',
      date: '2030-01-01',
    });
    expect(set.label).toMatch(/^RECORDED: answers from scripted-model/);
    expect(Object.keys(set.documents)).toEqual(['p-1', 'p-2']);
    expect(provider.asked).toEqual(['eval-p-1:true', 'eval-p-2:true']);
    expect(waits).toEqual([4_500]);
  });

  it('waits and retries a rate-limited call, then records failures instead of stopping', async () => {
    const waits: number[] = [];
    const provider = scripted([
      'rate_limited',
      'ok',
      'timeout',
      'rate_limited',
      'rate_limited',
      'rate_limited',
    ]);
    const set = await recordExtractions({
      ...base,
      provider,
      documents: [doc('p-1', ['x']), doc('p-2', ['x']), doc('p-3', ['x'])],
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(set.documents).toEqual({
      'p-1': { candidates: [expect.objectContaining({ fieldName: 'rated_head' })] },
      'p-2': { error: 'TIMEOUT' },
      'p-3': { error: 'RATE_LIMITED' },
    });
    expect(waits).toEqual([60_000, 4_500, 4_500, 60_000, 60_000]);
  });
});
