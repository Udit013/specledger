import { err } from '@specledger/core';
import { describe, expect, it } from 'vitest';

import { fakeProvider, okResult, PAGE_ONE, pumpRequest } from '../test/support/fakes.js';
import { llmError } from './errors.js';
import { withLogging } from './logging.js';

function capture() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  return {
    lines,
    logger: {
      info: (fields: Record<string, unknown>, message: string) =>
        lines.push({ level: 'info', fields, message }),
      warn: (fields: Record<string, unknown>, message: string) =>
        lines.push({ level: 'warn', fields, message }),
    },
  };
}

describe('withLogging', () => {
  it('logs request id, model, latency, outcome and token counts', async () => {
    const { lines, logger } = capture();
    let clock = 1_000;
    const provider = withLogging(
      fakeProvider('gemini', [okResult('gemini-model')]),
      logger,
      () => (clock += 250),
    );
    await provider.extract(pumpRequest(), { timeoutMs: 1_000, requestId: 'req-1' });
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'llm extraction finished',
        fields: {
          requestId: 'req-1',
          provider: 'gemini',
          model: 'gemini-model',
          promptVersion: pumpRequest().promptVersion,
          pageCount: 2,
          latencyMs: 250,
          outcome: 'ok',
          candidates: 1,
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    ]);
  });

  it('logs the error code of a failure as a warning, without its details', async () => {
    const { lines, logger } = capture();
    const failing = fakeProvider('replay', [
      err(llmError('REPLAY_MISS', `No recording (quote: ${PAGE_ONE})`, { key: 'k' })),
    ]);
    await withLogging(failing, logger).extract(pumpRequest(), { timeoutMs: 1_000 });
    expect(lines[0]).toMatchObject({
      level: 'warn',
      fields: { outcome: 'REPLAY_MISS', provider: 'replay' },
    });
    expect(lines[0]?.fields.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(lines)).not.toContain('Rated flow');
  });

  it('passes a generated request id to the provider', async () => {
    const { logger } = capture();
    const seen: (string | undefined)[] = [];
    const inner = {
      ...fakeProvider('gemini', [okResult('gemini-model')]),
      extract: (_request: unknown, options: { requestId?: string }) => {
        seen.push(options.requestId);
        return Promise.resolve(okResult('gemini-model'));
      },
    };
    await withLogging(inner, logger).extract(pumpRequest(), { timeoutMs: 1_000 });
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
