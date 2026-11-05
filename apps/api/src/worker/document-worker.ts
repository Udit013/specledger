import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

import type { Database } from '@specledger/db';
import {
  createFailoverProvider,
  createGeminiProvider,
  createReplayProvider,
  withLogging,
} from '@specledger/llm';
import type { LlmLogger, LlmProvider } from '@specledger/llm';

import type { Config } from '../config.js';
import { createProcessDocumentHandler, PROCESS_DOCUMENT } from './process-document.js';
import { createWorker } from './worker.js';
import type { WorkerLogger } from './worker.js';

// Operating defaults. The lease is long against a model call that can take tens of seconds, and
// renewed four times per lease; backoff starts at 5 s and is capped at 5 min.
export const WORKER = {
  pollIntervalMs: 1_000,
  concurrency: 2,
  visibilityMs: 60_000,
  heartbeatMs: 15_000,
  graceMs: 20_000,
  backoff: { baseMs: 5_000, capMs: 300_000 },
} as const;

const RECORDINGS = fileURLToPath(new URL('../../../../fixtures/recordings/', import.meta.url));

// Replay is the demo default. With Gemini, quota or outages fail over to replay (spec 6.5).
export function providerFor(config: Config): LlmProvider {
  const replay = createReplayProvider({ dir: RECORDINGS, modelId: config.llm.geminiModel });
  if (config.llm.provider === 'replay' || config.llm.geminiApiKey === null) return replay;
  const gemini = createGeminiProvider({
    apiKey: config.llm.geminiApiKey,
    modelId: config.llm.geminiModel,
  });
  return createFailoverProvider({ providers: [gemini, replay], cooldownMs: 60_000, now: Date.now });
}

// The process_document worker, as both the worker process and the combined server run it.
export function createDocumentWorker(
  config: Config,
  database: Database,
  logger: LlmLogger & WorkerLogger,
) {
  return createWorker({
    queue: database.jobs,
    handlers: {
      [PROCESS_DOCUMENT]: createProcessDocumentHandler({
        store: database,
        provider: withLogging(providerFor(config), logger),
        llmTimeoutMs: config.llm.timeoutMs,
        logger,
      }),
    },
    workerId: `${hostname()}:${String(process.pid)}:${randomUUID().slice(0, 8)}`,
    clock: () => new Date(),
    random: Math.random,
    logger,
    ...WORKER,
  });
}
