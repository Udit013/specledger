// The worker process: claims jobs from the Postgres queue and runs them. Start with
// `pnpm --filter @specledger/api worker` (after a build). SIGTERM or SIGINT stops it gracefully:
// it stops claiming, lets in-flight jobs finish within the grace period, then releases the rest.
import { openDatabase } from '@specledger/db';

import { formatConfigIssues, parseConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createDocumentWorker, WORKER } from './document-worker.js';

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

  const worker = createDocumentWorker(config, database, logger);

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
