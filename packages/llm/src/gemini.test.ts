import { describe, expect, it } from 'vitest';

import { networkGuard } from '../test/network-guard.js';
import { GOOD_OUTPUT, PAGE_ONE, pumpRequest } from '../test/support/fakes.js';
import { createGeminiProvider, errorForStatus } from './gemini.js';
import { withLogging } from './logging.js';

// Shaped like a real key so a leak would be recognisable; it is not a key.
const PLANTED_KEY = `AIza${'Q'.repeat(35)}`;
const OPTIONS = { timeoutMs: 5_000 };

interface SeenRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

// Stands in for the Gemini REST API: each call takes the next scripted response.
function fakeGemini(responses: readonly (() => Response)[]) {
  const seen: SeenRequest[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
    const next = responses[Math.min(seen.length - 1, responses.length - 1)];
    if (next === undefined) throw new Error('fakeGemini has no responses');
    return Promise.resolve(next());
  };
  return { fetch, seen };
}

const answer = (text: string) => () =>
  Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
  });
const status = (code: number) => () =>
  Response.json(
    { error: { code, message: `echo of the prompt: ${PAGE_ONE}`, status: 'X' } },
    { status: code },
  );

function gemini(responses: readonly (() => Response)[], maxSchemaRetries = 2) {
  const api = fakeGemini(responses);
  const provider = createGeminiProvider({
    apiKey: PLANTED_KEY,
    modelId: 'gemini-test',
    fetch: api.fetch,
    maxSchemaRetries,
  });
  return { provider, seen: api.seen };
}

describe('GeminiProvider', () => {
  it('returns schema-valid candidates with token counts', async () => {
    const { provider, seen } = gemini([answer(JSON.stringify(GOOD_OUTPUT))]);
    expect(await provider.extract(pumpRequest(), OPTIONS)).toEqual({
      ok: true,
      value: {
        modelId: 'gemini-test',
        promptVersion: pumpRequest().promptVersion,
        candidates: GOOD_OUTPUT.candidates,
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('/models/gemini-test:generateContent');
  });

  it('sends document text only in user content, never in the system instruction', async () => {
    const { provider, seen } = gemini([answer(JSON.stringify(GOOD_OUTPUT))]);
    await provider.extract(pumpRequest(), OPTIONS);
    const body = seen[0]?.body ?? {};
    expect(JSON.stringify(body.systemInstruction)).not.toContain('Rated flow');
    expect(JSON.stringify(body.contents)).toContain('Rated flow: 500 gpm');
    // Structured output: the request carries the JSON schema, limited to the requested fields.
    const config = JSON.stringify(body.generationConfig);
    expect(config).toContain('"responseJsonSchema"');
    expect(config).toContain('"enum":["rated_flow","rated_head"');
  });

  it('sends the key in a header, not in the URL', async () => {
    const { provider, seen } = gemini([answer(JSON.stringify(GOOD_OUTPUT))]);
    await provider.extract(pumpRequest(), OPTIONS);
    expect(seen[0]?.url).not.toContain(PLANTED_KEY);
    expect(seen[0]?.headers.get('x-goog-api-key')).toBe(PLANTED_KEY);
  });

  it('retries a malformed answer with a correction, then succeeds', async () => {
    const { provider, seen } = gemini([
      answer('not json at all'),
      answer(JSON.stringify(GOOD_OUTPUT)),
    ]);
    expect((await provider.extract(pumpRequest(), OPTIONS)).ok).toBe(true);
    expect(seen).toHaveLength(2);
    const contents = JSON.stringify(seen[1]?.body.contents);
    expect(contents).toContain('did not match the required JSON schema');
    expect(contents).not.toContain('not json at all');
  });

  it('returns SCHEMA_INVALID after the correction attempts', async () => {
    const { provider, seen } = gemini([answer('{"candidates": [{"fieldName": "rated_flow"}]}')], 1);
    expect(await provider.extract(pumpRequest(), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_INVALID', details: { attempts: 2 } },
    });
    expect(seen).toHaveLength(2);
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'MODEL_RETIRED'],
    [400, 'BAD_REQUEST'],
    [500, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
  ])('maps HTTP %i to %s with one call and no response body', async (code, expected) => {
    const { provider, seen } = gemini([status(code)]);
    const result = await provider.extract(pumpRequest(), OPTIONS);
    expect(result).toMatchObject({
      ok: false,
      error: { code: expected, details: { status: code } },
    });
    // No hidden retries, even for codes the SDK would retry by default.
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('Rated flow');
  });

  it('maps a network failure to UNAVAILABLE', async () => {
    const provider = createGeminiProvider({
      apiKey: PLANTED_KEY,
      modelId: 'gemini-test',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await provider.extract(pumpRequest(), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
  });

  it('times out a call that never answers', async () => {
    const provider = createGeminiProvider({
      apiKey: PLANTED_KEY,
      modelId: 'gemini-test',
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    expect(await provider.extract(pumpRequest(), { timeoutMs: 100 })).toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT' },
    });
  });

  it('refuses a document that is not flagged synthetic before any request', async () => {
    const { provider, seen } = gemini([answer(JSON.stringify(GOOD_OUTPUT))]);
    expect(await provider.extract(pumpRequest({ synthetic: false }), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(seen).toHaveLength(0);
  });

  it('keeps the key and the document out of errors and logs', async () => {
    const lines: string[] = [];
    const logger = {
      info: (fields: Record<string, unknown>, message: string) =>
        lines.push(JSON.stringify({ fields, message })),
      warn: (fields: Record<string, unknown>, message: string) =>
        lines.push(JSON.stringify({ fields, message })),
    };
    for (const responses of [[answer(JSON.stringify(GOOD_OUTPUT))], [status(401)], [status(500)]]) {
      const { provider } = gemini(responses);
      const result = await withLogging(provider, logger).extract(pumpRequest(), OPTIONS);
      lines.push(JSON.stringify(result.ok ? 'ok' : result.error));
    }
    expect(lines.length).toBe(6);
    for (const line of lines) {
      expect(line).not.toContain(PLANTED_KEY);
      expect(line).not.toContain('Rated flow');
      expect(line).not.toContain('untrusted');
    }
  });

  it('never opened a socket', () => {
    expect(networkGuard.attempts).toBe(0);
  });
});

describe('errorForStatus', () => {
  it('treats an unknown status as UNAVAILABLE', () => {
    expect(errorForStatus(undefined).code).toBe('UNAVAILABLE');
    expect(errorForStatus(418).code).toBe('BAD_REQUEST');
  });
});
