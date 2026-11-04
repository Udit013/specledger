import { err, ok } from '@specledger/core';
import { describe, expect, it } from 'vitest';

import {
  GOOD_OUTPUT,
  objectReply,
  PAGE_ONE,
  PAGE_TWO,
  pumpRequest,
  scriptedClient,
} from '../test/support/fakes.js';
import { llmError } from './errors.js';
import { extractWithClient } from './model-client.js';

const OPTIONS = { timeoutMs: 5_000 };
const BAD_OUTPUT = { candidates: [{ fieldName: 'rated_flow', value: 500, unit: 'gpm', page: 1 }] };

describe('schema-correction retry', () => {
  it('retries an invalid answer with a corrective message until it is valid', async () => {
    const client = scriptedClient([
      objectReply(BAD_OUTPUT),
      objectReply({ wrong: true }),
      objectReply(GOOD_OUTPUT),
    ]);
    const result = await extractWithClient(client, pumpRequest(), OPTIONS, { maxSchemaRetries: 2 });

    expect(result).toEqual({
      ok: true,
      value: {
        modelId: 'fake-model',
        promptVersion: pumpRequest().promptVersion,
        candidates: GOOD_OUTPUT.candidates,
        usage: { inputTokens: 30, outputTokens: 15 },
      },
    });
    expect(client.calls).toHaveLength(3);
    const third = client.calls[2]?.messages ?? [];
    expect(third.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    const corrections = [third[2]?.content ?? '', third[4]?.content ?? ''];
    expect(corrections[0]).toContain('candidates.0.value: invalid_type (expected string)');
    expect(corrections[0]).toContain('candidates.0.quote: invalid_type (expected string)');
    expect(corrections[1]).toMatch(/unrecognized_keys|candidates: invalid_type/);
    for (const correction of corrections) {
      for (const line of [...PAGE_ONE.split('\n'), ...PAGE_TWO.split('\n')])
        expect(correction).not.toContain(line);
      expect(correction).not.toContain('500');
    }
    // The rejected answer itself is never sent back to the model.
    expect(third[1]?.content).not.toContain('rated_flow');
  });

  it('returns SCHEMA_INVALID after the allowed attempts', async () => {
    const client = scriptedClient([objectReply(BAD_OUTPUT)]);
    const result = await extractWithClient(client, pumpRequest(), OPTIONS, { maxSchemaRetries: 2 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_INVALID', details: { attempts: 3 } },
    });
    expect(client.calls).toHaveLength(3);
  });

  it('treats a field that was not requested as a schema violation', async () => {
    const stray = {
      candidates: [{ ...GOOD_OUTPUT.candidates[0], fieldName: 'impeller_diameter' }],
    };
    const client = scriptedClient([objectReply(stray)]);
    const result = await extractWithClient(client, pumpRequest(), OPTIONS, { maxSchemaRetries: 0 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_INVALID', details: { attempts: 1 } },
    });
  });

  it('passes output the client already found invalid through the same retry', async () => {
    const client = scriptedClient([
      ok({
        kind: 'invalid',
        issues: ['(root): output is not valid JSON'],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      objectReply(GOOD_OUTPUT),
    ]);
    expect((await extractWithClient(client, pumpRequest(), OPTIONS)).ok).toBe(true);
    expect(client.calls[1]?.messages.at(-1)?.content).toContain('output is not valid JSON');
  });
});

describe('extractWithClient', () => {
  it('does not retry a client error', async () => {
    const client = scriptedClient([err(llmError('RATE_LIMITED', 'slow down', { status: 429 }))]);
    expect(await extractWithClient(client, pumpRequest(), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(client.calls).toHaveLength(1);
  });

  it('returns TIMEOUT at the time limit even if the client ignores its signal', async () => {
    const client = scriptedClient([() => new Promise(() => undefined)]);
    const started = performance.now();
    const result = await extractWithClient(client, pumpRequest(), { timeoutMs: 100 });
    expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(client.calls[0]?.signal.aborted).toBe(true);
  });

  it('returns ABORTED when the caller cancels', async () => {
    const controller = new AbortController();
    const client = scriptedClient([
      () => {
        controller.abort();
        return new Promise(() => undefined);
      },
    ]);
    expect(
      await extractWithClient(client, pumpRequest(), {
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'ABORTED' },
    });
  });

  it('maps a client that throws to UNAVAILABLE', async () => {
    const client = scriptedClient([() => Promise.reject(new Error('socket hang up'))]);
    expect(await extractWithClient(client, pumpRequest(), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
  });

  it('calls the client once per chunk and merges the candidates in page order', async () => {
    const second = {
      candidates: [
        { fieldName: 'efficiency', value: '78', unit: '%', quote: 'Efficiency: 78 %', page: 2 },
      ],
    };
    const client = scriptedClient([objectReply(GOOD_OUTPUT), objectReply(second)]);
    const result = await extractWithClient(client, pumpRequest(), OPTIONS, {
      maxChunkChars: PAGE_ONE.length,
    });
    expect(client.calls).toHaveLength(2);
    expect(result.ok && result.value.candidates.map((c) => c.fieldName)).toEqual([
      'rated_flow',
      'efficiency',
    ]);
  });

  it('rejects an invalid request without calling the client', async () => {
    const client = scriptedClient([objectReply(GOOD_OUTPUT)]);
    const result = await extractWithClient(client, pumpRequest({ pages: [] }), OPTIONS);
    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(client.calls).toHaveLength(0);
  });
});
