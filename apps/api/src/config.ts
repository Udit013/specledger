import { DEFAULT_INGEST_LIMITS, INGEST_LIMIT_BOUNDS } from '@specledger/ingest';
import type { IngestLimits } from '@specledger/ingest';
import { DEFAULT_GEMINI_MODEL } from '@specledger/llm';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

// replay answers from fixtures/recordings and is the default (demo mode: free, deterministic, no
// network); gemini calls the Gemini free tier and fails over to replay.
export const LLM_PROVIDERS = ['replay', 'gemini'] as const;

// Upload limits (INGEST_*) take the ingest package's defaults and bounds, so a value outside the
// bounds stops start-up instead of disabling a limit.
const ingestLimit = (name: keyof IngestLimits) =>
  z.coerce
    .number()
    .int()
    .min(INGEST_LIMIT_BOUNDS[name].min)
    .max(INGEST_LIMIT_BOUNDS[name].max)
    .default(DEFAULT_INGEST_LIMITS[name]);

const ingestExpected = (name: keyof IngestLimits) =>
  `an integer between ${String(INGEST_LIMIT_BOUNDS[name].min)} and ${String(INGEST_LIMIT_BOUNDS[name].max)}`;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  INGEST_MAX_BYTES: ingestLimit('maxBytes'),
  INGEST_MAX_PAGES: ingestLimit('maxPages'),
  INGEST_PARSE_TIMEOUT_MS: ingestLimit('parseTimeoutMs'),
  INGEST_PARSE_MEMORY_MB: ingestLimit('parseMemoryMb'),
  INGEST_MIN_TEXT_CHARS: ingestLimit('minTextChars'),
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('replay'),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
    .default(DEFAULT_GEMINI_MODEL),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
});

export type ConfigKey = keyof typeof envSchema.shape;

const CONFIG_KEYS = Object.keys(envSchema.shape) as ConfigKey[];

// Error output is built only from these fixed strings. Zod's own messages are not used because
// some issue types can echo the received input, and a bad value may itself be a credential.
const EXPECTED: Record<ConfigKey, string> = {
  NODE_ENV: 'one of development, test, production',
  HOST: 'a non-empty host name or IP address',
  PORT: 'an integer between 1 and 65535',
  LOG_LEVEL: `one of ${LOG_LEVELS.join(', ')}`,
  DATABASE_URL: 'a postgres:// or postgresql:// connection URL',
  INGEST_MAX_BYTES: ingestExpected('maxBytes'),
  INGEST_MAX_PAGES: ingestExpected('maxPages'),
  INGEST_PARSE_TIMEOUT_MS: ingestExpected('parseTimeoutMs'),
  INGEST_PARSE_MEMORY_MB: ingestExpected('parseMemoryMb'),
  INGEST_MIN_TEXT_CHARS: ingestExpected('minTextChars'),
  LLM_PROVIDER: `one of ${LLM_PROVIDERS.join(', ')}`,
  GEMINI_API_KEY: 'a Gemini API key (required when LLM_PROVIDER is gemini)',
  GEMINI_MODEL: 'a model id such as gemini-3.5-flash-lite',
  LLM_TIMEOUT_MS: 'an integer between 1000 and 300000',
};

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly ingest: IngestLimits;
  readonly llm: {
    readonly provider: (typeof LLM_PROVIDERS)[number];
    // Never logged; config is never logged as a whole.
    readonly geminiApiKey: string | null;
    readonly geminiModel: string;
    readonly timeoutMs: number;
  };
}

export interface ConfigIssue {
  readonly key: ConfigKey;
  readonly problem: 'missing' | 'invalid';
  readonly expected: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

function isConfigKey(value: unknown): value is ConfigKey {
  return typeof value === 'string' && (CONFIG_KEYS as readonly string[]).includes(value);
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  // Only known keys are read, so unrelated environment variables are ignored and never inspected.
  // An empty string is treated as unset, which is how `KEY=` in a .env file reads.
  const known: Partial<Record<ConfigKey, string>> = {};
  for (const key of CONFIG_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') known[key] = value;
  }

  const parsed = envSchema.safeParse(known);
  if (
    parsed.success &&
    parsed.data.LLM_PROVIDER === 'gemini' &&
    parsed.data.GEMINI_API_KEY === undefined
  ) {
    return {
      ok: false,
      issues: [{ key: 'GEMINI_API_KEY', problem: 'missing', expected: EXPECTED.GEMINI_API_KEY }],
    };
  }
  if (parsed.success) {
    const values = parsed.data;
    return {
      ok: true,
      config: Object.freeze({
        nodeEnv: values.NODE_ENV,
        host: values.HOST,
        port: values.PORT,
        logLevel: values.LOG_LEVEL,
        databaseUrl: values.DATABASE_URL,
        ingest: Object.freeze({
          maxBytes: values.INGEST_MAX_BYTES,
          maxPages: values.INGEST_MAX_PAGES,
          parseTimeoutMs: values.INGEST_PARSE_TIMEOUT_MS,
          parseMemoryMb: values.INGEST_PARSE_MEMORY_MB,
          minTextChars: values.INGEST_MIN_TEXT_CHARS,
        }),
        llm: Object.freeze({
          provider: values.LLM_PROVIDER,
          geminiApiKey: values.GEMINI_API_KEY ?? null,
          geminiModel: values.GEMINI_MODEL,
          timeoutMs: values.LLM_TIMEOUT_MS,
        }),
      }),
    };
  }

  const failedKeys = new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(isConfigKey));
  const issues = CONFIG_KEYS.filter((key) => failedKeys.has(key)).map((key): ConfigIssue => ({
    key,
    problem: known[key] === undefined ? 'missing' : 'invalid',
    expected: EXPECTED[key],
  }));
  return { ok: false, issues };
}

export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  const lines = issues.map(
    (issue) => `  - ${issue.key} is ${issue.problem} (expected ${issue.expected})`,
  );
  return [
    'Invalid configuration. Fix these environment variables (values are not shown):',
    ...lines,
    '',
  ].join('\n');
}
