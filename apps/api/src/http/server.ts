import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Database } from '@specledger/db';
import { manifestSchema } from '@specledger/eval';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import type { Config, ConfigIssue } from '../config.js';
import { buildApp } from './app.js';
import type { ApiTokens } from './auth.js';

// How long /ready waits for the database before answering 503.
export const READY_TIMEOUT_MS = 2_000;

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

// The HTTP API with its configuration applied, not yet listening.
export async function createApiServer(
  config: Config,
  tokens: ApiTokens,
  database: Database,
  logger: FastifyBaseLogger,
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
  });
}
