import { randomUUID } from 'node:crypto';

import { openDatabase } from '@specledger/db';
import type { Database } from '@specledger/db';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

// A migrated schema of its own for one test file, through the db package's public API only.
export interface TestDatabase {
  readonly database: Database;
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<Record<string, unknown>>>;
}

// `wipeable` opens it as the demo workspace's database is opened, so Database.wipe works on it.
export function withTestDatabase(options: { readonly wipeable?: boolean } = {}): TestDatabase {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let database: Database | undefined;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString === undefined || connectionString === '') {
      throw new Error('DATABASE_URL is required for integration tests (see .env.example)');
    }
    admin = new pg.Pool({ connectionString, max: 2, options: `-c search_path="${schema}"` });
    await admin.query(`create schema "${schema}"`);
    database = openDatabase({
      connectionString,
      schema,
      maxConnections: 8,
      wipeable: options.wipeable === true,
    });
    await database.migrate();
  });

  afterAll(async () => {
    await database?.close();
    if (admin !== undefined) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  return {
    get database() {
      if (database === undefined) throw new Error('withTestDatabase is used before beforeAll');
      return database;
    },
    query: (text, params) => {
      if (admin === undefined) throw new Error('withTestDatabase is used before beforeAll');
      return admin.query<Record<string, unknown>>(text, params ? [...params] : undefined);
    },
  };
}
