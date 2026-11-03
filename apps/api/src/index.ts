export const PACKAGE_NAME = '@specledger/api';

export { formatConfigIssues, parseConfig } from './config.js';
export type { Config, ConfigIssue, ConfigKey, ConfigResult } from './config.js';
export { createLogger, REDACT_PATHS, REDACTED } from './logger.js';
export type { LoggerOptions } from './logger.js';
