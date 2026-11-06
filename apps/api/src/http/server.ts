import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '@specledger/db';
import type { Database } from '@specledger/db';
import { manifestSchema } from '@specledger/eval';
import type { LlmLogger } from '@specledger/llm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import type { Config } from '../config.js';
import { loadDemoDocuments } from '../demo/documents.js';
import { createSandboxes } from '../demo/sandboxes.js';
import type { Sandboxes } from '../demo/sandboxes.js';
import { createDemoSessions } from '../demo/session.js';
import { createDemoWorkspace } from '../demo/workspace.js';
import type { DemoWorkspace } from '../demo/workspace.js';
import { createDocumentWorker } from '../worker/document-worker.js';
import type { WorkerLogger } from '../worker/worker.js';
import { buildApp } from './app.js';
import type { DemoDeps } from './deps.js';

// How long /ready waits for the database before answering 503.
export const READY_TIMEOUT_MS = 2_000;

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CORPUS_MANIFEST = fileURLToPath(
  new URL('../../../../fixtures/corpus/manifest.json', import.meta.url),
);

// The sha256 of every synthetic corpus PDF, for UPLOAD_ALLOWLIST=corpus.
export async function corpusAllowlist(path = CORPUS_MANIFEST): Promise<ReadonlySet<string>> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return new Set(manifest.documents.map((document) => document.pdfSha256));
}

export interface DemoServices {
  readonly workspace: DemoWorkspace;
  readonly sandboxes: Sandboxes;
  readonly deps: DemoDeps;
}

// The demo of a configuration with DEMO_DATABASE_URL: the showcase (the demo database's public
// schema, wipeable, migrated) with its own extraction worker (not started), the visitor sandboxes
// and the visitor session issuer.
export async function openDemoServices(
  config: Config,
  logger: LlmLogger & WorkerLogger,
): Promise<DemoServices | null> {
  if (config.demo === null) return null;
  const showcase = openDatabase({ connectionString: config.demo.databaseUrl, wipeable: true });
  await showcase.migrate();
  const workspace = createDemoWorkspace({
    database: showcase,
    limits: config.ingest,
    worker: createDocumentWorker(config, showcase, logger),
    documents: () => loadDemoDocuments(ROOT),
  });
  const sandboxes = createSandboxes({
    connectionString: config.demo.databaseUrl,
    source: 'public',
    maxSandboxes: config.demo.maxSandboxes,
  });
  return {
    workspace,
    sandboxes,
    deps: {
      showcase,
      sessions: createDemoSessions({
        secret: config.demo.sessionSecret,
        ttlMs: config.demo.sessionTtlMs,
      }),
      sandboxes,
      isReady: () => workspace.isReady(),
      reset: () => workspace.reset(),
    },
  };
}

// The HTTP API with its configuration applied, not yet listening.
export async function createApiServer(
  config: Config,
  database: Database,
  logger: FastifyBaseLogger,
  demo: DemoDeps | null = null,
): Promise<FastifyInstance> {
  const { http } = config;
  return buildApp({
    database,
    auth: config.auth,
    limits: config.ingest,
    http: {
      corsOrigins: http.corsOrigins,
      trustProxy: http.trustProxy,
      rateLimitPerMinute: http.rateLimitPerMinute,
      uploadRateLimitPerMinute: http.uploadRateLimitPerMinute,
      requestTimeoutMs: http.requestTimeoutMs,
      bodyLimitBytes: http.bodyLimitBytes,
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    logger,
    uploadAllowlist: config.uploadAllowlist === 'corpus' ? await corpusAllowlist() : null,
    demo,
  });
}
