import { connect, runMigrations, wipeSchema } from './connection.js';
import type { Connection, ConnectionOptions } from './connection.js';
import { createRepositories } from './repositories.js';
import type { Repositories } from './repositories.js';

// The public face of the package: repositories that speak core domain types, a transaction
// boundary, migrations and shutdown. Drizzle and pg types stay inside this package.
export interface Database extends Repositories {
  transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  // Drops everything in the schema and migrates it again. Only a database opened with
  // `wipeable: true` allows it (the demo workspace); any other refuses, so a production
  // connection can never be wiped by mistake.
  wipe(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions extends ConnectionOptions {
  readonly wipeable?: boolean;
}

export function openDatabase(options: DatabaseOptions): Database {
  return databaseFor(connect(options), options.wipeable === true);
}

// Not exported from the package entry point; the test harness uses it to share one pool.
export function databaseFor(connection: Connection, wipeable = false): Database {
  return {
    ...createRepositories(connection.db),
    transaction: (work) => connection.db.transaction((tx) => work(createRepositories(tx))),
    migrate: () => runMigrations(connection),
    async wipe() {
      if (!wipeable) throw new Error('this database was not opened as wipeable');
      await wipeSchema(connection);
      await runMigrations(connection);
    },
    async ping() {
      await connection.pool.query('select 1');
    },
    close: () => connection.pool.end(),
  };
}
