// The HTTP API process. Start with `pnpm --filter @specledger/api start` (after a build). It
// refuses to start without both role tokens, applies migrations, and on SIGTERM or SIGINT stops
// accepting connections, lets in-flight requests finish, then closes the database pool.
import { openDatabase } from '@specledger/db';

import { formatConfigIssues, parseConfig } from './config.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';

// How long /ready waits for the database before answering 503.
const READY_TIMEOUT_MS = 2_000;

async function main(): Promise<number> {
  const result = parseConfig(process.env);
  if (!result.ok) {
    process.stderr.write(formatConfigIssues(result.issues));
    return 1;
  }
  const { config } = result;
  const { engineerToken, approverToken, ...http } = config.http;
  if (engineerToken === null || approverToken === null) {
    process.stderr.write(
      formatConfigIssues(
        (['API_ENGINEER_TOKEN', 'API_APPROVER_TOKEN'] as const)
          .filter((key) => (key === 'API_ENGINEER_TOKEN' ? engineerToken : approverToken) === null)
          .map((key) => ({
            key,
            problem: 'missing' as const,
            expected: 'a token of 32 to 256 URL-safe characters; the API needs both',
          })),
      ),
    );
    return 1;
  }

  const logger = createLogger({ name: 'api', level: config.logLevel });
  const database = openDatabase({ connectionString: config.databaseUrl });
  await database.migrate();
  const app = await buildApp({
    database,
    tokens: { engineer: engineerToken, approver: approverToken },
    limits: config.ingest,
    http: { ...http, readyTimeoutMs: READY_TIMEOUT_MS },
    logger,
  });

  const stopped = new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      logger.info({ signal }, 'stopping the api');
      void app.close().finally(resolve);
    };
    process.once('SIGTERM', () => {
      stop('SIGTERM');
    });
    process.once('SIGINT', () => {
      stop('SIGINT');
    });
  });
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, 'api listening');
  await stopped;
  await database.close();
  logger.info({}, 'api stopped');
  return 0;
}

process.exitCode = await main();
