import { DEFAULT_INGEST_LIMITS } from '@specledger/ingest';
import { describe, expect, it } from 'vitest';

import { formatConfigIssues, parseConfig } from './config.js';
import type { ConfigIssue, ConfigResult } from './config.js';

const VALID_ENV = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  PORT: '8080',
  LOG_LEVEL: 'warn',
  DATABASE_URL: 'postgres://app:pw@db.internal:5432/specledger',
  INGEST_MAX_BYTES: '2097152',
  INGEST_MAX_PAGES: '20',
  INGEST_PARSE_TIMEOUT_MS: '5000',
  INGEST_PARSE_MEMORY_MB: '128',
  INGEST_MIN_TEXT_CHARS: '40',
};

function expectIssues(result: ConfigResult): readonly ConfigIssue[] {
  if (result.ok) throw new Error('expected configuration to be rejected');
  return result.issues;
}

describe('parseConfig', () => {
  it('parses a complete, valid environment into typed config', () => {
    expect(parseConfig(VALID_ENV)).toEqual({
      ok: true,
      config: {
        nodeEnv: 'production',
        host: '0.0.0.0',
        port: 8080,
        logLevel: 'warn',
        databaseUrl: 'postgres://app:pw@db.internal:5432/specledger',
        ingest: {
          maxBytes: 2097152,
          maxPages: 20,
          parseTimeoutMs: 5000,
          parseMemoryMb: 128,
          minTextChars: 40,
        },
        llm: {
          provider: 'replay',
          geminiApiKey: null,
          geminiModel: 'gemini-3.5-flash-lite',
          timeoutMs: 60_000,
        },
      },
    });
  });

  it('applies defaults when only the required key is set', () => {
    expect(parseConfig({ DATABASE_URL: 'postgresql://localhost/specledger' })).toEqual({
      ok: true,
      config: {
        nodeEnv: 'development',
        host: '127.0.0.1',
        port: 3000,
        logLevel: 'info',
        databaseUrl: 'postgresql://localhost/specledger',
        ingest: DEFAULT_INGEST_LIMITS,
        llm: {
          provider: 'replay',
          geminiApiKey: null,
          geminiModel: 'gemini-3.5-flash-lite',
          timeoutMs: 60_000,
        },
      },
    });
  });

  it('reports a missing required key by name', () => {
    const withoutDatabaseUrl: Record<string, string> = { ...VALID_ENV };
    delete withoutDatabaseUrl.DATABASE_URL;
    expect(expectIssues(parseConfig(withoutDatabaseUrl))).toEqual([
      {
        key: 'DATABASE_URL',
        problem: 'missing',
        expected: 'a postgres:// or postgresql:// connection URL',
      },
    ]);
  });

  it('treats an empty string as missing', () => {
    const issues = expectIssues(parseConfig({ ...VALID_ENV, DATABASE_URL: '' }));
    expect(issues.map((issue) => [issue.key, issue.problem])).toEqual([
      ['DATABASE_URL', 'missing'],
    ]);
  });

  it.each(['0', '65536', '-1', '80.5', 'http', '3000abc'])('rejects invalid port %j', (port) => {
    const issues = expectIssues(parseConfig({ ...VALID_ENV, PORT: port }));
    expect(issues).toEqual([
      { key: 'PORT', problem: 'invalid', expected: 'an integer between 1 and 65535' },
    ]);
  });

  it.each(['mysql://user:pw@host/db', 'not a url', 'https://example.com'])(
    'rejects a non-postgres DATABASE_URL %j',
    (url) => {
      const issues = expectIssues(parseConfig({ ...VALID_ENV, DATABASE_URL: url }));
      expect(issues.map((issue) => [issue.key, issue.problem])).toEqual([
        ['DATABASE_URL', 'invalid'],
      ]);
    },
  );

  it('rejects values outside an enum', () => {
    const issues = expectIssues(
      parseConfig({ ...VALID_ENV, NODE_ENV: 'staging', LOG_LEVEL: 'verbose' }),
    );
    expect(issues.map((issue) => [issue.key, issue.problem])).toEqual([
      ['NODE_ENV', 'invalid'],
      ['LOG_LEVEL', 'invalid'],
    ]);
  });

  it('ignores unknown keys and does not copy them into config', () => {
    const result = parseConfig({ ...VALID_ENV, UNRELATED_SECRET: 'x', PATH: '/usr/bin' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(Object.keys(result.config).sort()).toEqual([
        'databaseUrl',
        'host',
        'ingest',
        'llm',
        'logLevel',
        'nodeEnv',
        'port',
      ]);
  });

  it('returns frozen config', () => {
    const result = parseConfig(VALID_ENV);
    expect(result.ok && Object.isFrozen(result.config)).toBe(true);
    expect(result.ok && Object.isFrozen(result.config.ingest)).toBe(true);
  });

  it.each([
    ['INGEST_MAX_BYTES', '0', 'an integer between 1024 and 104857600'],
    ['INGEST_MAX_BYTES', '104857601', 'an integer between 1024 and 104857600'],
    ['INGEST_MAX_PAGES', '0', 'an integer between 1 and 1000'],
    ['INGEST_PARSE_TIMEOUT_MS', '50', 'an integer between 100 and 120000'],
    ['INGEST_PARSE_TIMEOUT_MS', 'never', 'an integer between 100 and 120000'],
    ['INGEST_PARSE_MEMORY_MB', '4096', 'an integer between 32 and 2048'],
    ['INGEST_MIN_TEXT_CHARS', '0', 'an integer between 1 and 10000'],
  ])('refuses %s=%s, which would weaken or disable a limit', (key, value, expected) => {
    expect(expectIssues(parseConfig({ ...VALID_ENV, [key]: value }))).toEqual([
      { key, problem: 'invalid', expected },
    ]);
  });
});

describe('model provider configuration', () => {
  it('reads the Gemini settings when the provider is gemini', () => {
    const result = parseConfig({
      ...VALID_ENV,
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key-not-real',
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
      LLM_TIMEOUT_MS: '20000',
    });
    expect(result.ok && result.config.llm).toEqual({
      provider: 'gemini',
      geminiApiKey: 'test-key-not-real',
      geminiModel: 'gemini-3.1-flash-lite',
      timeoutMs: 20_000,
    });
    expect(result.ok && Object.isFrozen(result.config.llm)).toBe(true);
  });

  it('requires a key for gemini, reporting it by name only', () => {
    const result = parseConfig({ ...VALID_ENV, LLM_PROVIDER: 'gemini' });
    expect(expectIssues(result)).toEqual([
      {
        key: 'GEMINI_API_KEY',
        problem: 'missing',
        expected: 'a Gemini API key (required when LLM_PROVIDER is gemini)',
      },
    ]);
  });

  it.each([
    ['LLM_PROVIDER', 'openai'],
    ['GEMINI_MODEL', 'Gemini 3 Pro!'],
    ['LLM_TIMEOUT_MS', '50'],
  ])('refuses %s=%s', (key, value) => {
    expect(
      expectIssues(parseConfig({ ...VALID_ENV, [key]: value })).map((issue) => [
        issue.key,
        issue.problem,
      ]),
    ).toEqual([[key, 'invalid']]);
  });

  it('never prints a supplied key', () => {
    const output = formatConfigIssues(
      expectIssues(
        parseConfig({ ...VALID_ENV, LLM_PROVIDER: 'nope', GEMINI_API_KEY: 'PLANTED-gemini-key' }),
      ),
    );
    expect(output).not.toContain('PLANTED');
  });
});

describe('formatConfigIssues', () => {
  it('names every failing key and never prints the values that were supplied', () => {
    const planted = {
      NODE_ENV: 'PLANTED-node-env',
      PORT: 'PLANTED-port-99999',
      LOG_LEVEL: 'PLANTED-level',
      DATABASE_URL: 'mysql://admin:PLANTED-db-password@prod.example.com/db',
      UNRELATED: 'PLANTED-unrelated',
    };
    const output = formatConfigIssues(expectIssues(parseConfig(planted)));

    expect(output).toContain('NODE_ENV is invalid');
    expect(output).toContain('PORT is invalid');
    expect(output).toContain('LOG_LEVEL is invalid');
    expect(output).toContain('DATABASE_URL is invalid');
    expect(output).not.toMatch(/PLANTED|admin|prod\.example\.com/);
  });

  it('describes a missing key as missing', () => {
    const output = formatConfigIssues(expectIssues(parseConfig({})));
    expect(output).toBe(
      [
        'Invalid configuration. Fix these environment variables (values are not shown):',
        '  - DATABASE_URL is missing (expected a postgres:// or postgresql:// connection URL)',
        '',
      ].join('\n'),
    );
  });
});
