import { createHash } from 'node:crypto';

import Fastify from 'fastify';

import { assetPayloadSchema } from './contract.js';

// A mock of the ACC-style asset contract, for contract tests and demos. It is not the Autodesk
// API and makes no claim to behave like it beyond what docs/adapter-contract.md states.
//
// POST /assets/upsert matches on externalId: it creates the asset, or updates it as a new
// revision. Every request it processes is a write. A repeated Idempotency-Key gets the original
// response back without a write; the same key with another body is a 409. Failures can be injected
// for the next requests, one per request, in order.

export type InjectedFailure =
  | { readonly kind: 'rate_limited'; readonly retryAfter?: string }
  | { readonly kind: 'unavailable'; readonly retryAfter?: string }
  | { readonly kind: 'validation' }
  // The request is processed, then the response is held back for delayMs.
  | { readonly kind: 'slow'; readonly delayMs: number }
  // The request is processed and the response body departs from the contract.
  | { readonly kind: 'drift'; readonly mode: 'extra' | 'missing' | 'retyped' };

export interface MockAssetServer {
  // Starts on a free port of the loopback interface; resolves to its base URL.
  listen(): Promise<string>;
  close(): Promise<void>;
  reset(): void;
  inject(failure: InjectedFailure, times?: number): void;
  requests(): readonly {
    readonly idempotencyKey: string | null;
    readonly correlationId: string | null;
  }[];
  assets(): readonly {
    readonly assetId: string;
    readonly externalId: string;
    readonly revision: number;
  }[];
  writes(): number;
}

interface Stored {
  readonly bodyHash: string;
  readonly status: number;
  readonly body: unknown;
}

const header = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);

export function createMockAssetServer(options: { readonly token?: string } = {}): MockAssetServer {
  const app = Fastify({ logger: false });
  let assets = new Map<string, { assetId: string; externalId: string; revision: number }>();
  let replies = new Map<string, Stored>();
  let failures: InjectedFailure[] = [];
  let log: { idempotencyKey: string | null; correlationId: string | null }[] = [];
  let writes = 0;
  let nextId = 1;

  app.post('/assets/upsert', async (request, reply) => {
    const idempotencyKey = header(request.headers['idempotency-key']);
    log.push({ idempotencyKey, correlationId: header(request.headers['x-correlation-id']) });
    void reply.header('x-correlation-id', header(request.headers['x-correlation-id']) ?? '');

    if (
      options.token !== undefined &&
      request.headers.authorization !== `Bearer ${options.token}`
    ) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED' } });
    }
    const failure = failures.shift();
    if (failure?.kind === 'rate_limited' || failure?.kind === 'unavailable') {
      if (failure.retryAfter !== undefined) void reply.header('retry-after', failure.retryAfter);
      return reply.status(failure.kind === 'rate_limited' ? 429 : 503).send({
        error: { code: failure.kind === 'rate_limited' ? 'RATE_LIMITED' : 'UNAVAILABLE' },
      });
    }
    if (failure?.kind === 'validation') {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION', fields: ['attributes.0.unit'] } });
    }
    const parsed = assetPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.map(String).join('.'));
      return reply.status(400).send({ error: { code: 'VALIDATION', fields } });
    }
    const bodyHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    if (idempotencyKey !== null) {
      const stored = replies.get(idempotencyKey);
      if (stored !== undefined) {
        if (stored.bodyHash !== bodyHash) {
          return reply.status(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
        }
        return reply.status(stored.status).send(stored.body);
      }
    }

    writes += 1;
    const existing = assets.get(parsed.data.externalId);
    const asset = existing
      ? { ...existing, revision: existing.revision + 1 }
      : { assetId: `asset-${String(nextId++)}`, externalId: parsed.data.externalId, revision: 1 };
    assets.set(asset.externalId, asset);
    let body: Record<string, unknown> = { ...asset, created: existing === undefined };
    if (failure?.kind === 'drift') {
      if (failure.mode === 'extra') body = { ...body, debugInfo: 'mock' };
      if (failure.mode === 'missing') {
        body = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'revision'));
      }
      if (failure.mode === 'retyped') body = { ...body, revision: String(asset.revision) };
    }
    const status = existing === undefined ? 201 : 200;
    if (idempotencyKey !== null) replies.set(idempotencyKey, { bodyHash, status, body });
    if (failure?.kind === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
    }
    return reply.status(status).send(body);
  });

  return {
    async listen() {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      return address;
    },
    close: () => app.close(),
    reset() {
      assets = new Map();
      replies = new Map();
      failures = [];
      log = [];
      writes = 0;
      nextId = 1;
    },
    inject(failure, times = 1) {
      for (let i = 0; i < times; i += 1) failures.push(failure);
    },
    requests: () => [...log],
    assets: () => [...assets.values()],
    writes: () => writes,
  };
}
