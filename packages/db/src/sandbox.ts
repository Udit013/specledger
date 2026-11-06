import { connect, runMigrations } from './connection.js';

// Demo sandboxes: a private copy of the showcase's data in a schema of its own, so a visitor can
// review, resolve and publish without touching anyone else's data. Only schemas named
// "sandbox_..." can be created or dropped here, never "public".
export const SANDBOX_SCHEMA = /^sandbox_[a-z0-9_]{1,50}$/;

// Every table, in an order that satisfies the foreign keys. users and sessions are deliberately
// not copied: a sandbox has no accounts. A test fails if a table is missing from both lists.
export const COPIED_TABLES = [
  'equipment',
  'documents',
  'document_blobs',
  'document_pages',
  'jobs',
  'extraction_runs',
  'fields',
  'conflicts',
  'register_versions',
  'register_items',
  'review_events',
  'register_counter',
] as const;
export const NOT_COPIED_TABLES = ['users', 'sessions'] as const;

function checkName(schema: string) {
  if (!SANDBOX_SCHEMA.test(schema)) throw new Error('not a sandbox schema name');
}

// Creates `target`, migrates it, and copies the data of `source` into it in one transaction that
// reads one consistent snapshot of the source. Published register versions are copied unpublished,
// given their items, then published, which is the only order the immutability triggers allow.
export async function createSandbox(options: {
  readonly connectionString: string;
  readonly source: string;
  readonly target: string;
}): Promise<void> {
  checkName(options.target);
  const { source, target } = options;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(source) || source === target) {
    throw new Error('invalid source schema');
  }
  const connection = connect({
    connectionString: options.connectionString,
    schema: target,
    maxConnections: 2,
    statementTimeoutMs: 30_000,
  });
  try {
    await connection.pool.query(`create schema "${target}"`);
    await runMigrations(connection);
    const client = await connection.pool.connect();
    const q = (table: string, at: string) => `"${at}"."${table}"`;
    try {
      await client.query('begin isolation level repeatable read');
      for (const table of COPIED_TABLES) {
        if (table === 'register_counter') {
          await client.query(
            `update ${q(table, target)} set last_number = (select last_number from ${q(table, source)} where id = 1) where id = 1`,
          );
        } else if (table === 'register_versions') {
          await client.query(
            `insert into ${q(table, target)} (id, number, approved_by, published_at, created_at)
             select id, number, null, null, created_at from ${q(table, source)}`,
          );
        } else {
          await client.query(`insert into ${q(table, target)} select * from ${q(table, source)}`);
        }
      }
      await client.query(
        `update ${q('register_versions', target)} t set approved_by = s.approved_by,
           published_at = s.published_at
         from ${q('register_versions', source)} s where s.id = t.id and s.published_at is not null`,
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await connection.pool.query(`drop schema if exists "${target}" cascade`).catch(() => undefined);
    throw error;
  } finally {
    await connection.pool.end();
  }
}

export async function dropSandbox(options: {
  readonly connectionString: string;
  readonly schema: string;
}): Promise<void> {
  checkName(options.schema);
  const connection = connect({ connectionString: options.connectionString, maxConnections: 2 });
  try {
    await connection.pool.query(`drop schema if exists "${options.schema}" cascade`);
  } finally {
    await connection.pool.end();
  }
}

export async function listSandboxes(connectionString: string): Promise<string[]> {
  const connection = connect({ connectionString, maxConnections: 2 });
  try {
    const { rows } = await connection.pool.query<{ name: string }>(
      `select nspname as name from pg_namespace where nspname like 'sandbox\\_%' order by 1`,
    );
    return rows.map((row) => row.name).filter((name) => SANDBOX_SCHEMA.test(name));
  } finally {
    await connection.pool.end();
  }
}
