import { err } from '@specledger/core';
import { describe, expect, it } from 'vitest';

import { fakeProvider, okResult, pumpRequest } from '../test/support/fakes.js';
import { canFailOver, LLM_ERROR_CODES, llmError } from './errors.js';
import type { LlmErrorCode } from './errors.js';
import { createFailoverProvider } from './failover.js';

const OPTIONS = { timeoutMs: 1_000 };

// Every code, and whether B must be asked after A fails with it.
const MATRIX: Record<LlmErrorCode, boolean> = {
  RATE_LIMITED: true,
  TIMEOUT: true,
  UNAVAILABLE: true,
  MODEL_RETIRED: true,
  AUTH_FAILED: false,
  SCHEMA_INVALID: false,
  REPLAY_MISS: false,
  BAD_REQUEST: false,
  ABORTED: false,
};

describe('failover matrix', () => {
  it('covers every error code', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...LLM_ERROR_CODES].sort());
  });

  it.each(Object.entries(MATRIX) as [LlmErrorCode, boolean][])(
    'A fails with %s: fails over to B = %s',
    async (code, failsOver) => {
      const a = fakeProvider('a', [err(llmError(code, 'scripted'))]);
      const b = fakeProvider('b', [okResult('b-model')]);
      const failover = createFailoverProvider({
        providers: [a, b],
        cooldownMs: 1_000,
        now: () => 0,
      });
      const result = await failover.extract(pumpRequest(), OPTIONS);
      expect(canFailOver(code)).toBe(failsOver);
      expect(a.calls).toBe(1);
      expect(b.calls).toBe(failsOver ? 1 : 0);
      expect(result).toMatchObject(
        failsOver ? { ok: true, value: { modelId: 'b-model' } } : { ok: false, error: { code } },
      );
    },
  );

  it('returns the last error when every provider fails over', async () => {
    const a = fakeProvider('a', [err(llmError('RATE_LIMITED', 'a'))]);
    const b = fakeProvider('b', [err(llmError('TIMEOUT', 'b'))]);
    const failover = createFailoverProvider({ providers: [a, b], cooldownMs: 1_000, now: () => 0 });
    expect(await failover.extract(pumpRequest(), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT' },
    });
  });

  it('does not ask the next provider once the caller has cancelled', async () => {
    const controller = new AbortController();
    const a = {
      ...fakeProvider('a', []),
      extract: () => {
        controller.abort();
        return Promise.resolve(err(llmError('TIMEOUT', 'a')));
      },
    };
    const b = fakeProvider('b', [okResult('b-model')]);
    const failover = createFailoverProvider({ providers: [a, b], cooldownMs: 1_000, now: () => 0 });
    expect(
      await failover.extract(pumpRequest(), { ...OPTIONS, signal: controller.signal }),
    ).toMatchObject({
      ok: false,
      error: { code: 'ABORTED' },
    });
    expect(b.calls).toBe(0);
  });
});

describe('cooldown', () => {
  it('skips a provider during its cooldown and tries it again afterwards', async () => {
    let now = 10_000;
    const a = fakeProvider('a', [err(llmError('RATE_LIMITED', 'quota')), okResult('a-model')]);
    const b = fakeProvider('b', [okResult('b-model')]);
    const failover = createFailoverProvider({
      providers: [a, b],
      cooldownMs: 60_000,
      now: () => now,
    });
    const model = async () => {
      const result = await failover.extract(pumpRequest(), OPTIONS);
      return result.ok ? result.value.modelId : result.error.code;
    };

    expect(await model()).toBe('b-model');
    now += 59_999;
    expect(await model()).toBe('b-model');
    expect(a.calls).toBe(1);
    now += 1;
    expect(await model()).toBe('a-model');
    expect(a.calls).toBe(2);
  });

  it('reports UNAVAILABLE when every provider is cooling down', async () => {
    const a = fakeProvider('a', [err(llmError('UNAVAILABLE', 'down'))]);
    const failover = createFailoverProvider({ providers: [a], cooldownMs: 60_000, now: () => 0 });
    await failover.extract(pumpRequest(), OPTIONS);
    expect(await failover.extract(pumpRequest(), OPTIONS)).toMatchObject({
      ok: false,
      error: {
        code: 'UNAVAILABLE',
        message: 'Every provider is cooling down after recent failures.',
      },
    });
    expect(a.calls).toBe(1);
  });

  it('does not rest a provider after an error that is not fail-over-able', async () => {
    const a = fakeProvider('a', [
      err(llmError('SCHEMA_INVALID', 'bad output')),
      okResult('a-model'),
    ]);
    const failover = createFailoverProvider({ providers: [a], cooldownMs: 60_000, now: () => 0 });
    await failover.extract(pumpRequest(), OPTIONS);
    expect((await failover.extract(pumpRequest(), OPTIONS)).ok).toBe(true);
    expect(a.calls).toBe(2);
  });
});
