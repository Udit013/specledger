import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '@specledger/db';
import type { Database } from '@specledger/db';
import { manifestSchema } from '@specledger/eval';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import type { Config, ConfigIssue } from '../config.js';
import { loadDemoDocuments } from '../demo/documents.js';
import { createDemoSessions } from '../demo/session.js';
import { createDemoWorkspace } from '../demo/workspace.js';
import type { DemoWorkspace } from '../demo/workspace.js';
import { createDocumentWorker } from '../worker/document-worker.js';
import type { WorkerLogger } from '../worker/worker.js';
import type { LlmLogger } from '@specledger/llm';
import { buildApp } from './app.js';
import type { ApiTokens } from './auth.js';
import type { DemoDeps } from './deps.js';

// How long /ready waits for the database before answering 503.
export const READY_TIMEOUT_MS = 2_000;

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CORPUS_MANIFEST = fileURLToPath(
  new URL('../../../../fixtures/corpus/manifest.json', import.meta.url),
);

// Both role tokens, or the configuration issues to report: the API refuses to start without them.
export function apiTokensFrom(config: Config): ApiTokens | ConfigIssue[] {
  const { engineerToken, approverToken } = config.http;
  if (engineerToken !== null && approverToken !== null) {
    return { engineer: engineerToken, approver: approverToken };
  }
  return (['API_ENGINEER_TOKEN', 'API_APPROVER_TOKEN'] as const)
    .filter((key) => (key === 'API_ENGINEER_TOKEN' ? engineerToken : approverToken) === null)
    .map((key) => ({
      key,
      problem: 'missing' as const,
      expected: 'a token of 32 to 256 URL-safe characters; the API needs both',
    }));
}

// The sha256 of every synthetic corpus PDF, for UPLOAD_ALLOWLIST=corpus.
export async function corpusAllowlist(path = CORPUS_MANIFEST): Promise<ReadonlySet<string>> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return new Set(manifest.documents.map((document) => document.pdfSha256));
}

export interface DemoServices {
  readonly workspace: DemoWorkspace;
  readonly deps: DemoDeps;
}

// The demo workspace of a configuration with DEMO_DATABASE_URL: its own wipeable database
// (migrated), its own extraction worker (not started), and the visitor session issuer.
export async function openDemoServices(
  config: Config,
  logger: LlmLogger & WorkerLogger,
): Promise<DemoServices | null> {
  if (config.demo === null) return null;
  const database = openDatabase({ connectionString: config.demo.databaseUrl, wipeable: true });
  await database.migrate();
  const workspace = createDemoWorkspace({
    database,
    limits: config.ingest,
    worker: createDocumentWorker(config, database, logger),
    documents: () => loadDemoDocuments(ROOT),
  });
  return {
    workspace,
    deps: {
      database,
      sessions: createDemoSessions({
        secret: config.demo.sessionSecret,
        ttlMs: config.demo.sessionTtlMs,
      }),
      uploadAllowlist: await corpusAllowlist(),
      reset: () => workspace.reset(),
    },
  };
}

// The HTTP API with its configuration applied, not yet listening.
export async function createApiServer(
  config: Config,
  tokens: ApiTokens,
  database: Database,
  logger: FastifyBaseLogger,
  demo: DemoDeps | null = null,
): Promise<FastifyInstance> {
  const { http } = config;
  return buildApp({
    database,
    tokens,
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
