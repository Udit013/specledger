import { formatConfigIssues, parseConfig } from './config.js';
import { createLogger } from './logger.js';

const result = parseConfig(process.env);

if (!result.ok) {
  process.stderr.write(formatConfigIssues(result.issues));
  process.exitCode = 1;
} else {
  const { config } = result;
  const logger = createLogger({ name: 'api', level: config.logLevel });
  logger.info({ nodeEnv: config.nodeEnv, port: config.port }, 'configuration loaded');
}
