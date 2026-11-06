// The API and the worker in one process, for hosts that run a single service (the free Render
// plan). Start with `node apps/api/dist/serve.js`. Configuration and migrations are as for the two
// separate processes. SIGTERM or SIGINT stops claiming jobs and stops accepting requests, lets
// in-flight work finish (the worker's grace period, then open requests), and closes the pool once.
// With DEMO_DATABASE_URL it also serves the demo workspace under /demo, with a second worker on
// the demo database, and seeds that database with the curated documents when it is empty.
import { openDatabase } from '@specledger/db';

import { formatConfigIssues, parseConfig } from './config.js';
import { createApiServer, openDemoServices } from './http/server.js';
import { createLogger } from './logger.js';
import { createDocumentWorker, WORKER } from './worker/document-worker.js';

async function main(): Promise<number> {
  const result = parseConfig(process.env);
  if (!result.ok) {
    process.stderr.write(formatConfigIssues(result.issues));
    return 1;
  }
  const { config } = result;

  const logger = createLogger({ name: 'specledger', level: config.logLevel });
  const database = openDatabase({ connectionString: config.databaseUrl });
  await database.migrate();
  const demo = await openDemoServices(config, logger);
  const app = await createApiServer(config, database, logger, demo?.deps ?? null);
  const worker = createDocumentWorker(config, database, logger);

  let cleanupTimer: NodeJS.Timeout | undefined;
  const stopped = new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      logger.info({ signal }, 'stopping');
      clearInterval(cleanupTimer);
      void Promise.allSettled([worker.stop(), demo?.workspace.stop(), app.close()]).finally(
        resolve,
      );
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
  if (demo !== null) {
    demo.workspace.start();
    // The showcase gets whichever curated documents it lacks, in the background; the API is
    // already up. Expired visitor sandboxes are dropped now and every ten minutes.
    const cleanup = () => {
      demo.sandboxes.cleanup().then(
        (dropped) => {
          if (dropped > 0) logger.info({ dropped }, 'expired demo sandboxes dropped');
        },
        (error: unknown) => {
          logger.error(
            { errorName: error instanceof Error ? error.name : typeof error },
            'demo sandbox cleanup failed',
          );
        },
      );
    };
    cleanup();
    cleanupTimer = setInterval(cleanup, 10 * 60_000);
    cleanupTimer.unref();
    demo.workspace.ensureSeeded().then(
      (queued) => {
        logger.info({ queued }, 'demo showcase seeded');
      },
      (error: unknown) => {
        logger.error(
          { errorName: error instanceof Error ? error.name : typeof error },
          'demo workspace seeding failed',
        );
      },
    );
  }
  logger.info(
    {
      host: config.host,
      port: config.port,
      provider: config.llm.provider,
      concurrency: WORKER.concurrency,
      uploadAllowlist: config.uploadAllowlist,
      demo: demo !== null,
    },
    'api listening and worker started',
  );
  await stopped;
  await Promise.allSettled([
    database.close(),
    demo?.workspace.database.close(),
    demo?.sandboxes.close(),
  ]);
  logger.info({}, 'stopped');
  return 0;
}

process.exitCode = await main();
