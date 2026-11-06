// The HTTP API process. Start with `pnpm --filter @specledger/api start` (after a build). It
// refuses to start without both role tokens, applies migrations, and on SIGTERM or SIGINT stops
// accepting connections, lets in-flight requests finish, then closes the database pool. The demo
// workspace (DEMO_DATABASE_URL) is served only by the combined process, serve.ts, which runs its
// worker too.
import { openDatabase } from '@specledger/db';

import { formatConfigIssues, parseConfig } from './config.js';
import { apiTokensFrom, createApiServer } from './http/server.js';
import { createLogger } from './logger.js';

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

  const logger = createLogger({ name: 'api', level: config.logLevel });
  const database = openDatabase({ connectionString: config.databaseUrl });
  await database.migrate();
  const app = await createApiServer(config, tokens, database, logger);

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
