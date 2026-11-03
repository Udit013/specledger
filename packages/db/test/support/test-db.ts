import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { connect, runMigrations } from '../../src/connection.js';
import { databaseFor } from '../../src/database.js';
import type { Database } from '../../src/database.js';

export type Row = Record<string, unknown>;

export interface TestDb {
  // Unique per test file, e.g. test_3f2a...; tables, triggers and the migrations table live in it.
  readonly schema: string;
  readonly database: Database;
  // Raw SQL against the test schema, for asserting what the database itself allows or refuses.
  query(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<Row>>;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is required for integration tests (see .env.example)');
  }
  return url;
}

// Gives the calling test file its own schema: created and migrated before the file's tests run,
// dropped afterwards. Files therefore run in parallel against one Postgres without sharing rows.
export function withTestDb(): TestDb {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let state: { pool: pg.Pool; database: Database } | undefined;
  // Kept apart from `state` so cleanup still runs when setup fails halfway, e.g. in a migration.
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    const connectionString = databaseUrl();
    admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`create schema "${schema}"`);
    const connection = connect({ connectionString, schema, maxConnections: 4 });
    pool = connection.pool;
    await runMigrations(connection);
    state = { pool: connection.pool, database: databaseFor(connection) };
  });

  afterAll(async () => {
    await pool?.end();
    if (admin !== undefined) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  function current() {
    if (state === undefined) throw new Error('withTestDb is used before its beforeAll hook ran');
    return state;
  }

  return {
    schema,
    get database() {
      return current().database;
    },
    query: (text, params) => current().pool.query<Row>(text, params ? [...params] : undefined),
  };
}

export interface PgFailure {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

// Runs a write that must be refused and returns the Postgres SQLSTATE and constraint name.
// Errors raised through Drizzle carry the driver error as `cause`.
export async function pgFailure(write: Promise<unknown>): Promise<PgFailure> {
  try {
    await write;
  } catch (error: unknown) {
    const driverError = findDriverError(error);
    if (driverError !== undefined) return driverError;
    throw error;
  }
  throw new Error('expected the database to refuse this write, but it succeeded');
}

function findDriverError(error: unknown): PgFailure | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (current instanceof pg.DatabaseError) {
      return { code: current.code, constraint: current.constraint };
    }
    current = current.cause;
  }
  return undefined;
}
