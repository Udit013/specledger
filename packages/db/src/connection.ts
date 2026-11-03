import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import * as schema from './schema.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATIONS_TABLE = '__migrations';
// Any fixed 64-bit number works; it only has to be the same for every process running migrations.
const MIGRATION_LOCK_KEY = 4_190_517_301;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface ConnectionOptions {
  readonly connectionString: string;
  // Schema that holds the tables. Tests use one schema per file; the application uses "public".
  readonly schema?: string;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export interface Connection {
  readonly pool: pg.Pool;
  readonly db: NodePgDatabase<typeof schema>;
  readonly schema: string;
}

export function connect(options: ConnectionOptions): Connection {
  const schemaName = options.schema ?? 'public';
  // The name is interpolated into a startup parameter, so only plain identifiers are accepted.
  if (!SCHEMA_NAME.test(schemaName)) {
    throw new Error('schema must be a lower-case identifier of at most 63 characters');
  }
  const maxConnections = options.maxConnections ?? 10;
  // runMigrations holds one connection for its lock while the migrator uses another.
  if (!Number.isInteger(maxConnections) || maxConnections < 2) {
    throw new Error('maxConnections must be an integer of at least 2');
  }
  const statementTimeoutMs = options.statementTimeoutMs ?? 10_000;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: maxConnections,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: statementTimeoutMs * 3,
    // Only sent when needed: some hosted connection poolers reject startup options.
    ...(schemaName === 'public' ? {} : { options: `-c search_path=${schemaName}` }),
  });
  return { pool, db: drizzle(pool, { schema }), schema: schemaName };
}

// Applies pending migrations into the connection's schema. Already-applied migrations are skipped,
// so running it again is a no-op. A session-level advisory lock serializes concurrent runners
// (several app instances starting at once); the migrator itself applies everything in one
// transaction, so a failure leaves the schema as it was.
export async function runMigrations(connection: Connection): Promise<void> {
  const lockClient = await connection.pool.connect();
  try {
    await lockClient.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(connection.db, {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: connection.schema,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } finally {
      await lockClient.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}
