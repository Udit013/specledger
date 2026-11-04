import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AssetPayload } from './contract.js';
import { createHttpAssetClient } from './http-client.js';
import type { HttpAssetClientOptions } from './http-client.js';
import { createMockAssetServer } from './mock-server.js';
import type { MockAssetServer } from './mock-server.js';
import { syncRegisterVersion } from './sync.js';

// Contract tests: the client against the mock of the ACC-style contract, on the loopback interface
// of this process. They prove the client keeps the contract as written down; they do not prove
// anything about the real Autodesk API, which was not used.

const PAYLOAD: AssetPayload = {
  externalId: 'specledger:P-106',
  name: 'P-106',
  attributes: [{ name: 'rated_head', value: '260', unit: 'ft' }],
  source: { system: 'specledger', registerVersion: 4, publishedAt: '2030-01-02T03:04:05.000Z' },
};
const KEY = 'specledger:register:v4:P-106';
const NOW = Date.parse('2030-06-01T12:00:00.000Z');

let mock: MockAssetServer;
let baseUrl: string;
let waits: number[];

beforeAll(async () => {
  mock = createMockAssetServer({ token: 'mock-token' });
  baseUrl = await mock.listen();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.reset();
  waits = [];
});

const client = (options: Partial<HttpAssetClientOptions> = {}) =>
  createHttpAssetClient({
    baseUrl,
    token: 'mock-token',
    timeoutMs: 2_000,
    maxAttempts: 4,
    maxRetryAfterMs: 5_000,
    backoff: { baseMs: 100, maxMs: 1_000 },
    // Time is injected: waits are recorded, not slept, and jitter is fixed.
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => NOW,
    random: () => 0.5,
    ...options,
  });

describe('upsertAsset against the mock', () => {
  it('creates the asset, sending the idempotency key and correlation id', async () => {
    const result = await client().upsertAsset(PAYLOAD, KEY, { correlationId: 'corr-1' });
    expect(result).toMatchObject({
      ok: true,
      value: { externalId: 'specledger:P-106', revision: 1, created: true, attempts: 1 },
    });
    expect(mock.requests()).toEqual([
      expect.objectContaining({ idempotencyKey: KEY, correlationId: 'corr-1' }),
    ]);
  });

  it('retries a 429 after its Retry-After seconds, with the same key', async () => {
    mock.inject({ kind: 'rate_limited', retryAfter: '2' });
    const result = await client().upsertAsset(PAYLOAD, KEY, { correlationId: 'corr-2' });
    expect(result).toMatchObject({ ok: true, value: { attempts: 2, created: true } });
    expect(waits).toEqual([2_000]);
    expect(mock.requests().map((r) => [r.idempotencyKey, r.correlationId])).toEqual([
      [KEY, 'corr-2'],
      [KEY, 'corr-2'],
    ]);
  });

  it('retries a 429 after its Retry-After HTTP date, measured on the injected clock', async () => {
    mock.inject({ kind: 'rate_limited', retryAfter: 'Sat, 01 Jun 2030 12:00:03 GMT' });
    const result = await client().upsertAsset(PAYLOAD, KEY);
    expect(result.ok).toBe(true);
    expect(waits).toEqual([3_000]);
  });

  it('retries 503s with jittered exponential backoff when no Retry-After is given', async () => {
    mock.inject({ kind: 'unavailable' }, 2);
    const result = await client().upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({ ok: true, value: { attempts: 3 } });
    // Full jitter with random() = 0.5: half of 100 ms, then half of 200 ms.
    expect(waits).toEqual([50, 100]);
  });

  it('honours a 503 Retry-After over the backoff', async () => {
    mock.inject({ kind: 'unavailable', retryAfter: '1' });
    await client().upsertAsset(PAYLOAD, KEY);
    expect(waits).toEqual([1_000]);
  });

  it('gives up without waiting when Retry-After exceeds the cap', async () => {
    mock.inject({ kind: 'rate_limited', retryAfter: '60' });
    const result = await client().upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        retryable: true,
        attempts: 1,
        status: 429,
        retryAfterMs: 60_000,
      },
    });
    expect(waits).toEqual([]);
  });

  it('gives up when an HTTP-date Retry-After exceeds the cap on the injected clock', async () => {
    mock.inject({ kind: 'rate_limited', retryAfter: 'Sat, 01 Jun 2030 12:00:10 GMT' });
    const result = await client().upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', attempts: 1 } });
    expect(waits).toEqual([]);
  });

  it('stops after maxAttempts on persistent 503s', async () => {
    mock.inject({ kind: 'unavailable' }, 10);
    const result = await client({ maxAttempts: 3 }).upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE', attempts: 3, status: 503, retryable: true },
    });
    expect(mock.requests()).toHaveLength(3);
  });

  it('does not retry a 400 validation error, and reports the failing fields', async () => {
    mock.inject({ kind: 'validation' });
    const result = await client().upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        retryable: false,
        attempts: 1,
        status: 400,
        fields: ['attributes.0.unit'],
      },
    });
    expect(mock.requests()).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('does not retry a rejected token', async () => {
    const result = await client({ token: 'wrong' }).upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', attempts: 1 } });
  });

  it('refuses an invalid payload or key before sending anything', async () => {
    const bad = { ...PAYLOAD, externalId: '' };
    expect(await client().upsertAsset(bad, KEY)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', attempts: 0 },
    });
    expect(await client().upsertAsset(PAYLOAD, 'key with spaces')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', attempts: 0 },
    });
    expect(mock.requests()).toHaveLength(0);
  });

  it('times out a slow response, retries with the same key, and gets the original result', async () => {
    mock.inject({ kind: 'slow', delayMs: 600 });
    const result = await client({ timeoutMs: 150 }).upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({ ok: true, value: { attempts: 2, created: true, revision: 1 } });
    // The first request was processed; the retry was answered from the idempotency record.
    expect(mock.writes()).toBe(1);
    expect(mock.assets()).toHaveLength(1);
  });

  it('a duplicate upsert with the same key creates one asset and one write', async () => {
    const first = await client().upsertAsset(PAYLOAD, KEY);
    const again = await client().upsertAsset(PAYLOAD, KEY);
    expect(again).toEqual(first);
    expect(mock.assets()).toHaveLength(1);
    expect(mock.writes()).toBe(1);
  });

  it('a new key for the same asset is a new write: an update, not a second asset', async () => {
    await client().upsertAsset(PAYLOAD, KEY);
    const update = await client().upsertAsset(PAYLOAD, `${KEY}:again`);
    expect(update).toMatchObject({ ok: true, value: { created: false, revision: 2 } });
    expect(mock.assets()).toHaveLength(1);
    expect(mock.writes()).toBe(2);
  });

  it('refuses the same key with another payload, without retrying', async () => {
    await client().upsertAsset(PAYLOAD, KEY);
    const changed = { ...PAYLOAD, name: 'P-106 renamed' };
    const result = await client().upsertAsset(changed, KEY);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT', status: 409, retryable: false, attempts: 1 },
    });
  });

  it('accepts a response with extra fields and reports them as drift', async () => {
    mock.inject({ kind: 'drift', mode: 'extra' });
    const result = await client().upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({
      ok: true,
      value: {
        created: true,
        drift: {
          compatible: true,
          differences: [{ path: 'debugInfo', kind: 'added', expected: null, actual: 'string' }],
        },
      },
    });
  });

  it.each([
    ['missing', { path: 'revision', kind: 'removed', expected: 'number', actual: null }],
    ['retyped', { path: 'revision', kind: 'type_changed', expected: 'number', actual: 'string' }],
  ] as const)(
    'returns a drift report for a %s field instead of throwing',
    async (mode, difference) => {
      mock.inject({ kind: 'drift', mode });
      const result = await client().upsertAsset(PAYLOAD, KEY);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'RESPONSE_SCHEMA_DRIFT',
          retryable: false,
          drift: { compatible: false, differences: [difference] },
        },
      });
    },
  );

  it('retries network failures and reports them typed when they persist', async () => {
    const result = await client({
      baseUrl: 'http://127.0.0.1:9',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      maxAttempts: 2,
    }).upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'NETWORK', attempts: 2, status: null },
    });
    expect(waits).toEqual([50]);
  });

  it.each([500, 502, 504, 418])('does not retry an unexpected %i', async (status) => {
    let calls = 0;
    const result = await client({
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('{}', { status }));
      },
    }).upsertAsset(PAYLOAD, KEY);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNEXPECTED_STATUS', status, retryable: false, attempts: 1 },
    });
    expect(calls).toBe(1);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await client().upsertAsset(PAYLOAD, KEY, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: 'ABORTED', retryable: false } });
  });
});

describe('syncRegisterVersion', () => {
  it('upserts each item with its own deterministic key and reports per item', async () => {
    const version = {
      number: 4,
      approvedBy: 'role:approver',
      publishedAt: new Date('2030-01-02T03:04:05.000Z'),
      items: [
        { tag: 'P-106', values: { rated_head: { value: '260', unit: 'ft' } } },
        { tag: 'M-201', values: { rated_power: { value: '75', unit: 'kW' } } },
      ],
    };
    mock.inject({ kind: 'validation' });
    const first = await syncRegisterVersion(client(), version, { correlationId: 'sync-1' });
    expect(first.map((r) => [r.tag, r.result.ok])).toEqual([
      ['M-201', false],
      ['P-106', true],
    ]);
    // Running the same sync again writes nothing new: every item replays its key.
    const writes = mock.writes();
    const again = await syncRegisterVersion(client(), version, { correlationId: 'sync-1' });
    expect(again.map((r) => r.result.ok)).toEqual([true, true]);
    expect(mock.writes()).toBe(writes + 1);
    expect(mock.requests().map((r) => r.idempotencyKey)).toContain('specledger:register:v4:M-201');
  });
});
