import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';

import { FIELD_DEFINITIONS } from '@specledger/core';
import type { Candidate } from '@specledger/core';
import { groundTruthSchema, manifestSchema } from '@specledger/eval';
import { DEFAULT_INGEST_LIMITS, extractPages } from '@specledger/ingest';
import type { IngestLimits } from '@specledger/ingest';
import { PROMPT_VERSION } from '@specledger/llm';
import type { LlmProvider } from '@specledger/llm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll } from 'vitest';

import { buildApp } from '../../src/http/app.js';
import type { AppDeps, HttpOptions } from '../../src/http/app.js';
import type { Role } from '../../src/http/auth.js';
import { createProcessDocumentHandler } from '../../src/worker/process-document.js';
import { REDACT_PATHS } from '../../src/logger.js';
import { withTestDatabase } from './test-db.js';
import type { TestDatabase } from './test-db.js';

export const TOKENS = {
  engineer: 'engineer-token-for-tests-6f1c2d9a4b',
  approver: 'approver-token-for-tests-0e8b7a3c5d',
} as const;

export const bearer = (role: Role) => ({ authorization: `Bearer ${TOKENS[role]}` });

export const HTTP: HttpOptions = {
  corsOrigins: ['https://review.example.test'],
  trustProxy: false,
  rateLimitPerMinute: 10_000,
  uploadRateLimitPerMinute: 10_000,
  requestTimeoutMs: 30_000,
  bodyLimitBytes: 64 * 1024,
  readyTimeoutMs: 1_000,
};

// Everything the app logs, for asserting what never appears in logs.
export function logCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = pino(
    { level: 'trace', redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } },
    stream,
  );
  return { lines, logger };
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly testDb: TestDatabase;
  readonly logs: string[];
}

// A database of its own and an app on it, for one test file.
export function withApp(
  overrides: {
    http?: Partial<HttpOptions>;
    limits?: Partial<IngestLimits>;
    deps?: Partial<AppDeps>;
  } = {},
): TestApp {
  const testDb = withTestDatabase();
  const capture = logCapture();
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    app = await buildApp({
      database: testDb.database,
      tokens: TOKENS,
      limits: { ...DEFAULT_INGEST_LIMITS, ...overrides.limits },
      http: { ...HTTP, ...overrides.http },
      logger: capture.logger,
      ...overrides.deps,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  const current = (): FastifyInstance => {
    if (app === undefined) throw new Error('the app is used before beforeAll built it');
    return app;
  };
  // A stand-in for the app that is built in beforeAll, so tests can write `const { app } = ...`
  // at module level and use it inside their tests.
  const lazyApp = new Proxy({} as FastifyInstance, {
    get(_target, property) {
      const instance = current();
      const value: unknown = Reflect.get(instance, property, instance);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(instance)
        : value;
    },
  });
  return { app: lazyApp, testDb, logs: capture.lines };
}

// A multipart/form-data body with text fields and an optional file part.
export function multipart(
  fields: Readonly<Record<string, string>>,
  file?: {
    readonly content: Uint8Array;
    readonly filename?: string;
    readonly contentType?: string;
  },
) {
  const boundary = `----specledger${randomUUID().replaceAll('-', '')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file !== undefined) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename ?? 'upload.pdf'}"\r\n` +
          `Content-Type: ${file.contentType ?? 'application/pdf'}\r\n\r\n`,
      ),
      Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const ROOT = new URL('../../../../', import.meta.url);
export const corpusPdf = (id: string) =>
  readFileSync(new URL(`fixtures/corpus/pdf/${id}.pdf`, ROOT));
const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(new URL('fixtures/corpus/manifest.json', ROOT), 'utf8')),
);
export const truthOf = (id: string) =>
  groundTruthSchema.parse(
    JSON.parse(readFileSync(new URL(`fixtures/corpus/truth/${id}.json`, ROOT), 'utf8')),
  );

// Uploads a corpus document over HTTP for `tag`.
export async function upload(
  app: FastifyInstance,
  id: string,
  tag: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  if (manifest.documents.find((d) => d.id === id)?.split !== 'dev')
    throw new Error(`${id} is not a dev document`);
  const body = multipart(
    {
      documentType: 'datasheet',
      revision: 'Rev A',
      equipmentTag: tag,
      equipmentClass: truthOf(id).equipmentClass,
      synthetic: 'true',
      ...fields,
    },
    { content: corpusPdf(id), filename: `${id}.pdf` },
  );
  return app.inject({
    method: 'POST',
    url: '/documents',
    ...body,
    headers: { ...body.headers, ...bearer('engineer'), ...headers },
  });
}

// A model that reads corpus documents correctly: the ground-truth candidates of whichever dev
// document the request's first page belongs to.
export function truthProvider(ids: readonly string[]): LlmProvider {
  const byFirstPage = new Map<string, Candidate[]>();
  const ready = Promise.all(
    ids.map(async (id) => {
      const pages = await extractPages(corpusPdf(id));
      if (!pages.ok) throw new Error(pages.error.code);
      const candidates = Object.entries(truthOf(id).fields).flatMap(([fieldName, field]) =>
        field === null
          ? []
          : [
              {
                fieldName,
                value: field.value,
                unit: field.unit,
                quote: field.quote,
                page: field.page,
              },
            ],
      );
      byFirstPage.set(pages.value.pages[0]?.text ?? '', candidates);
    }),
  );
  return {
    name: 'truth',
    modelId: 'truth-model',
    async extract(request) {
      await ready;
      const candidates = byFirstPage.get(request.pages[0]?.text ?? '') ?? [];
      return {
        ok: true,
        value: {
          modelId: 'truth-model',
          promptVersion: PROMPT_VERSION,
          candidates,
          usage: { inputTokens: null, outputTokens: null },
        },
      };
    },
  };
}

// Runs every due processing job through process_document, as the worker would.
export async function processQueued(testDb: TestDatabase, provider: LlmProvider): Promise<number> {
  const handler = createProcessDocumentHandler({
    store: testDb.database,
    provider,
    llmTimeoutMs: 30_000,
    logger: { info: () => undefined, warn: () => undefined },
  });
  let processed = 0;
  for (;;) {
    const job = await testDb.database.jobs.claim(
      new Date(Date.now() + 60_000),
      'test-worker',
      60_000,
    );
    if (job === null) return processed;
    await handler(job, { signal: new AbortController().signal });
    await testDb.database.jobs.complete(job.id, 'test-worker', new Date());
    processed += 1;
  }
}

export const uniqueTag = (prefix: string) => `${prefix}-${randomUUID().slice(0, 6)}`;
export const fieldNames = (equipmentClass: 'centrifugal_pump' | 'electric_motor') =>
  FIELD_DEFINITIONS[equipmentClass].map((f) => f.name);
