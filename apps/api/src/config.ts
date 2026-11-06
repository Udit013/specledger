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

// API bearer tokens: long random strings (openssl rand -hex 32), one per role.
const apiToken = z
  .string()
  .regex(/^[A-Za-z0-9._~+/=-]{32,256}$/)
  .optional();

// A comma-separated list of exact origins (scheme, host and optional port; no path).
const corsOrigins = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .pipe(z.array(z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/)).max(20));

// false (the default: X-Forwarded-For is ignored), true, or how many proxy hops to trust.
const trustProxy = z
  .string()
  .default('false')
  .pipe(z.union([z.enum(['true', 'false']), z.string().regex(/^[1-9]$/)]))
  .transform((value) => (value === 'true' ? true : value === 'false' ? false : Number(value)));

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
  API_ENGINEER_TOKEN: apiToken,
  API_APPROVER_TOKEN: apiToken,
  CORS_ORIGINS: corsOrigins,
  TRUST_PROXY: trustProxy,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
  UPLOAD_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  JSON_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
  UPLOAD_ALLOWLIST: z.enum(['none', 'corpus']).default('none'),
  DEMO_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  DEMO_SESSION_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9._~+/=-]{32,256}$/)
    .optional(),
  DEMO_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(120),
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
  API_ENGINEER_TOKEN: 'a token of 32 to 256 URL-safe characters, unlike the approver token',
  API_APPROVER_TOKEN: 'a token of 32 to 256 URL-safe characters, unlike the engineer token',
  CORS_ORIGINS: 'a comma-separated list of origins such as https://review.example.com',
  TRUST_PROXY: 'true, false or a hop count from 1 to 9',
  RATE_LIMIT_PER_MINUTE: 'an integer between 1 and 100000',
  UPLOAD_RATE_LIMIT_PER_MINUTE: 'an integer between 1 and 10000',
  REQUEST_TIMEOUT_MS: 'an integer between 1000 and 600000',
  JSON_BODY_LIMIT_BYTES: 'an integer between 1024 and 10485760',
  UPLOAD_ALLOWLIST: 'none, or corpus to accept only the synthetic corpus PDFs',
  DEMO_DATABASE_URL: 'a postgres:// URL of a database other than DATABASE_URL, for the demo',
  DEMO_SESSION_SECRET: 'a secret of 32 to 256 URL-safe characters (required with the demo)',
  DEMO_SESSION_TTL_MINUTES: 'an integer between 5 and 1440',
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
  readonly http: {
    // Never logged. Optional here (the worker needs none); the API refuses to start without both.
    readonly engineerToken: string | null;
    readonly approverToken: string | null;
    readonly corsOrigins: readonly string[];
    readonly trustProxy: boolean | number;
    readonly rateLimitPerMinute: number;
    readonly uploadRateLimitPerMinute: number;
    readonly requestTimeoutMs: number;
    readonly bodyLimitBytes: number;
  };
  // 'corpus' accepts only uploads whose sha256 is in fixtures/corpus/manifest.json: a public demo
  // then never stores or sends to the model anything but the synthetic test documents.
  readonly uploadAllowlist: 'none' | 'corpus';
  // The public demo workspace, or null when DEMO_DATABASE_URL is unset (no /demo routes).
  readonly demo: {
    // A different database from databaseUrl: visitors never touch production data.
    readonly databaseUrl: string;
    // Signs visitor sessions; never logged.
    readonly sessionSecret: string;
    readonly sessionTtlMs: number;
  } | null;
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
  if (
    parsed.success &&
    parsed.data.API_ENGINEER_TOKEN !== undefined &&
    parsed.data.API_ENGINEER_TOKEN === parsed.data.API_APPROVER_TOKEN
  ) {
    // One token for both roles would make every engineer an approver.
    return {
      ok: false,
      issues: [
        { key: 'API_APPROVER_TOKEN', problem: 'invalid', expected: EXPECTED.API_APPROVER_TOKEN },
      ],
    };
  }
  if (parsed.success && parsed.data.DEMO_DATABASE_URL !== undefined) {
    if (sameDatabase(parsed.data.DEMO_DATABASE_URL, parsed.data.DATABASE_URL)) {
      return {
        ok: false,
        issues: [
          { key: 'DEMO_DATABASE_URL', problem: 'invalid', expected: EXPECTED.DEMO_DATABASE_URL },
        ],
      };
    }
    if (parsed.data.DEMO_SESSION_SECRET === undefined) {
      return {
        ok: false,
        issues: [
          {
            key: 'DEMO_SESSION_SECRET',
            problem: 'missing',
            expected: EXPECTED.DEMO_SESSION_SECRET,
          },
        ],
      };
    }
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
        http: Object.freeze({
          engineerToken: values.API_ENGINEER_TOKEN ?? null,
          approverToken: values.API_APPROVER_TOKEN ?? null,
          corsOrigins: Object.freeze(values.CORS_ORIGINS),
          trustProxy: values.TRUST_PROXY,
          rateLimitPerMinute: values.RATE_LIMIT_PER_MINUTE,
          uploadRateLimitPerMinute: values.UPLOAD_RATE_LIMIT_PER_MINUTE,
          requestTimeoutMs: values.REQUEST_TIMEOUT_MS,
          bodyLimitBytes: values.JSON_BODY_LIMIT_BYTES,
        }),
        uploadAllowlist: values.UPLOAD_ALLOWLIST,
        demo:
          values.DEMO_DATABASE_URL === undefined || values.DEMO_SESSION_SECRET === undefined
            ? null
            : Object.freeze({
                databaseUrl: values.DEMO_DATABASE_URL,
                sessionSecret: values.DEMO_SESSION_SECRET,
                sessionTtlMs: values.DEMO_SESSION_TTL_MINUTES * 60_000,
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

// Whether two connection URLs name the same database on the same server, whatever their
// credentials or options: the demo must never share the production database.
function sameDatabase(a: string, b: string): boolean {
  const key = (url: string) => {
    const parsed = new URL(url);
    const port = parsed.port === '' ? '5432' : parsed.port;
    return `${parsed.hostname.toLowerCase()}:${port}${decodeURIComponent(parsed.pathname)}`;
  };
  return key(a) === key(b);
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
