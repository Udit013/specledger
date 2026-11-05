// The API and the worker in one process, for hosts that run a single service (the free Render
// plan). Start with `node apps/api/dist/serve.js`. Configuration and migrations are as for the two
// separate processes. SIGTERM or SIGINT stops claiming jobs and stops accepting requests, lets
// in-flight work finish (the worker's grace period, then open requests), and closes the pool once.
import { openDatabase } from '@specledger/db';

import { formatConfigIssues, parseConfig } from './config.js';
import { apiTokensFrom, createApiServer } from './http/server.js';
import { createLogger } from './logger.js';
import { createDocumentWorker, WORKER } from './worker/document-worker.js';

async function main(): Promise<number> {
  const result = parseConfig(process.env);
  if (!result.ok) {
    process.stderr.write(formatConfigIssues(result.issues));
    return 1;
  }
  const { config } = result;
  const tokens = apiTokensFrom(config);
  if (Array.isArray(tokens)) {
    process.stderr.write(formatConfigIssues(tokens));
    return 1;
  }

  const logger = createLogger({ name: 'specledger', level: config.logLevel });
  const database = openDatabase({ connectionString: config.databaseUrl });
  await database.migrate();
  const app = await createApiServer(config, tokens, database, logger);
  const worker = createDocumentWorker(config, database, logger);

  const stopped = new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      logger.info({ signal }, 'stopping');
      void Promise.allSettled([worker.stop(), app.close()]).finally(resolve);
    };
    process.once('SIGTERM', () => {
      stop('SIGTERM');
    });
    process.once('SIGINT', () => {
      stop('SIGINT');
    });
  });
  await app.listen({ host: config.host, port: config.port });
  worker.start();
  logger.info(
    {
      host: config.host,
      port: config.port,
      provider: config.llm.provider,
      concurrency: WORKER.concurrency,
      uploadAllowlist: config.uploadAllowlist,
    },
    'api listening and worker started',
  );
  await stopped;
  await database.close();
  logger.info({}, 'stopped');
  return 0;
}

process.exitCode = await main();
