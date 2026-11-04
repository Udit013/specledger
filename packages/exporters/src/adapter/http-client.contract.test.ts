import { describe, expect, it } from 'vitest';

import type { AssetPayload } from './contract.js';
import { createHttpAssetClient } from './http-client.js';
import type { HttpAssetClientOptions } from './http-client.js';

// The request and response contract of docs/adapter-contract.md, checked against a fetch stub
// that records exactly what the client sends. These pin the client's side of the contract; they
// prove nothing about Autodesk's real API (see the document's verification checklist).

const PAYLOAD: AssetPayload = {
  externalId: 'specledger:P-106',
  name: 'P-106',
  attributes: [{ name: 'rated_head', value: '260', unit: 'ft' }],
  source: { system: 'specledger', registerVersion: 4, publishedAt: '2030-01-02T03:04:05.000Z' },
};
const KEY = 'specledger:register:v4:P-106';
const OK_BODY = { assetId: 'a-1', externalId: 'specledger:P-106', revision: 1, created: true };

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function stub(responses: (() => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('no more stubbed responses');
    return Promise.resolve(next());
  };
  return { sent, fetchStub };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const client = (fetchStub: typeof fetch, options: Partial<HttpAssetClientOptions> = {}) => {
  const waits: number[] = [];
  return {
    waits,
    client: createHttpAssetClient({
      baseUrl: 'https://assets.example.test/api/',
      token: 'tok',
      fetch: fetchStub,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      now: () => 0,
      random: () => 0.5,
      timeoutMs: 200,
      backoff: { baseMs: 100, maxMs: 1_000 },
      ...options,
    }),
  };
};

describe('request contract', () => {
  it('POSTs the validated payload to /assets/upsert with every required header', async () => {
    const { sent, fetchStub } = stub([() => json(201, OK_BODY)]);
    await client(fetchStub).client.upsertAsset(PAYLOAD, KEY, { correlationId: 'corr-9' });
    expect(sent).toEqual([
      {
        url: 'https://assets.example.test/api/assets/upsert',
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer tok',
          'content-type': 'application/json',
          'idempotency-key': KEY,
          'x-correlation-id': 'corr-9',
        },
        body: PAYLOAD,
      },
    ]);
  });

  it('sends no correlation id or token header when there is none', async () => {
    const { sent, fetchStub } = stub([() => json(201, OK_BODY)]);
    await createHttpAssetClient({ baseUrl: 'https://a.test', fetch: fetchStub }).upsertAsset(
      PAYLOAD,
      KEY,
    );
    expect(Object.keys(sent[0]?.headers ?? {}).sort()).toEqual([
      'accept',
      'content-type',
      'idempotency-key',
    ]);
  });

  it('sends a byte-identical body and the same headers on every retry', async () => {
    const { sent, fetchStub } = stub([
      () => json(503, { error: { code: 'UNAVAILABLE' } }),
      () => json(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '0' }),
      () => json(201, OK_BODY),
    ]);
    const { client: c, waits } = client(fetchStub);
    expect(await c.upsertAsset(PAYLOAD, KEY, { correlationId: 'c' })).toMatchObject({ ok: true });
    expect(new Set(sent.map((s) => JSON.stringify(s))).size).toBe(1);
    // Retry-After: 0 means "now": the client waits 0 ms, not the backoff.
    expect(waits).toEqual([50, 0]);
  });
});

describe('response contract', () => {
  it.each([
    [403, 'UNAUTHORIZED'],
    [422, 'VALIDATION_FAILED'],
  ] as const)('treats %i as final: %s', async (status, code) => {
    const { sent, fetchStub } = stub([
      () => json(status, { error: { code: 'X', fields: ['name'] } }),
    ]);
    const result = await client(fetchStub).client.upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({ ok: false, error: { code, status, attempts: 1 } });
    expect(sent).toHaveLength(1);
  });

  it('reports a success body that is not JSON as drift, without throwing', async () => {
    const { fetchStub } = stub([() => new Response('<html>gateway</html>', { status: 200 })]);
    const result = await client(fetchStub).client.upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'RESPONSE_SCHEMA_DRIFT',
        drift: {
          compatible: false,
          differences: [{ path: '', kind: 'type_changed', actual: 'string' }],
        },
      },
    });
  });

  it('ignores malformed field lists in a validation error rather than trusting them', async () => {
    const { fetchStub } = stub([() => json(400, { error: { fields: 'attributes' } })]);
    const result = await client(fetchStub).client.upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fields: [] } });
  });

  it('times out a response whose body never finishes, and retries', async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"assetId":'));
          },
        }),
        { status: 201 },
      );
    const { sent, fetchStub } = stub([stalled, () => json(201, OK_BODY)]);
    const result = await client(fetchStub, { timeoutMs: 50 }).client.upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({ ok: true, value: { attempts: 2 } });
    expect(sent).toHaveLength(2);
  });
});

describe('cancellation', () => {
  it('stops retrying when the caller aborts during the backoff wait', async () => {
    const controller = new AbortController();
    const { sent, fetchStub } = stub([() => json(503, {}), () => json(201, OK_BODY)]);
    const c = createHttpAssetClient({
      baseUrl: 'https://a.test',
      fetch: fetchStub,
      random: () => 0.5,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    const result = await c.upsertAsset(PAYLOAD, KEY, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: 'ABORTED', attempts: 1 } });
    expect(sent).toHaveLength(1);
  });
});
