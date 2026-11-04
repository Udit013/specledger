import { pino } from 'pino';
import type { DestinationStream, LevelWithSilent, Logger } from 'pino';

export const REDACTED = '[REDACTED]';

// Log lines carry ids, statuses and counts, never document text or credentials. Redaction is a
// backstop for objects that reach the logger anyway. It matches keys, not values: a secret placed
// inside a message string is not caught, which is why the rule is to never log content.
export const REDACT_PATHS: readonly string[] = [
  // credentials
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'cookie',
  '*.cookie',
  'req.headers.cookie',
  // @fastify/multipart logs the request's whole header set at trace level.
  'busboyOptions.headers',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'databaseUrl',
  '*.databaseUrl',
  'geminiApiKey',
  '*.geminiApiKey',
  // document content
  'text',
  '*.text',
  'pageText',
  '*.pageText',
  'pages',
  '*.pages',
  'quote',
  '*.quote',
  'documentText',
  '*.documentText',
];

export interface LoggerOptions {
  readonly name: string;
  readonly level: LevelWithSilent;
}

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const pinoOptions = {
    name: options.name,
    level: options.level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination === undefined ? pino(pinoOptions) : pino(pinoOptions, destination);
}
