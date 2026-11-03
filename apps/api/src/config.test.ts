import { describe, expect, it } from 'vitest';

import { formatConfigIssues, parseConfig } from './config.js';
import type { ConfigIssue, ConfigResult } from './config.js';

const VALID_ENV = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  PORT: '8080',
  LOG_LEVEL: 'warn',
  DATABASE_URL: 'postgres://app:pw@db.internal:5432/specledger',
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
        'logLevel',
        'nodeEnv',
        'port',
      ]);
  });

  it('returns frozen config', () => {
    const result = parseConfig(VALID_ENV);
    expect(result.ok && Object.isFrozen(result.config)).toBe(true);
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
