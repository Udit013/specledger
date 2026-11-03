import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
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
};

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
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
