// The worker process: claims jobs from the Postgres queue and runs them. Start with
// `pnpm --filter @specledger/api worker` (after a build). SIGTERM or SIGINT stops it gracefully:
// it stops claiming, lets in-flight jobs finish within the grace period, then releases the rest.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '@specledger/db';
import {
  createFailoverProvider,
  createGeminiProvider,
  createReplayProvider,
  withLogging,
} from '@specledger/llm';
import type { LlmProvider } from '@specledger/llm';

import { formatConfigIssues, parseConfig } from '../config.js';
import type { Config } from '../config.js';
import { createLogger } from '../logger.js';
import { createProcessDocumentHandler, PROCESS_DOCUMENT } from './process-document.js';
import { createWorker } from './worker.js';

// Operating defaults. The lease is long against a model call that can take tens of seconds, and
// renewed four times per lease; backoff starts at 5 s and is capped at 5 min.
const WORKER = {
  pollIntervalMs: 1_000,
  concurrency: 2,
  visibilityMs: 60_000,
  heartbeatMs: 15_000,
  graceMs: 20_000,
  backoff: { baseMs: 5_000, capMs: 300_000 },
} as const;

const RECORDINGS = fileURLToPath(new URL('../../../../fixtures/recordings/', import.meta.url));

// Replay is the demo default. With Gemini, quota or outages fail over to replay (spec 6.5).
function providerFor(config: Config): LlmProvider {
  const replay = createReplayProvider({ dir: RECORDINGS, modelId: config.llm.geminiModel });
  if (config.llm.provider === 'replay' || config.llm.geminiApiKey === null) return replay;
  const gemini = createGeminiProvider({
    apiKey: config.llm.geminiApiKey,
    modelId: config.llm.geminiModel,
  });
  return createFailoverProvider({ providers: [gemini, replay], cooldownMs: 60_000, now: Date.now });
}

async function main(): Promise<number> {
  const result = parseConfig(process.env);
  if (!result.ok) {
    process.stderr.write(formatConfigIssues(result.issues));
    return 1;
  }
  const { config } = result;
  const logger = createLogger({ name: 'worker', level: config.logLevel });
  const database = openDatabase({ connectionString: config.databaseUrl });
  await database.migrate();

  const worker = createWorker({
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

  const stopped = new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      logger.info({ signal }, 'stopping the worker');
      void worker.stop().finally(resolve);
    };
    process.once('SIGTERM', () => {
      stop('SIGTERM');
    });
    process.once('SIGINT', () => {
      stop('SIGINT');
    });
  });
  worker.start();
  logger.info({ provider: config.llm.provider, concurrency: WORKER.concurrency }, 'worker started');
  await stopped;
  await database.close();
  logger.info({}, 'worker stopped');
  return 0;
}

process.exitCode = await main();
