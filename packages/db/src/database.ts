import { connect, runMigrations } from './connection.js';
import type { Connection, ConnectionOptions } from './connection.js';
import { createRepositories } from './repositories.js';
import type { Repositories } from './repositories.js';

// The public face of the package: repositories that speak core domain types, a transaction
// boundary, migrations and shutdown. Drizzle and pg types stay inside this package.
export interface Database extends Repositories {
  transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export type DatabaseOptions = ConnectionOptions;

export function openDatabase(options: DatabaseOptions): Database {
  return databaseFor(connect(options));
}

// Not exported from the package entry point; the test harness uses it to share one pool.
export function databaseFor(connection: Connection): Database {
  return {
    ...createRepositories(connection.db),
    transaction: (work) => connection.db.transaction((tx) => work(createRepositories(tx))),
    migrate: () => runMigrations(connection),
    async ping() {
      await connection.pool.query('select 1');
    },
    close: () => connection.pool.end(),
  };
}
