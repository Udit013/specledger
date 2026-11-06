import {
  createSandbox,
  dropSandbox,
  listSandboxes,
  openDatabase,
  SANDBOX_SCHEMA,
} from '@specledger/db';
import type { Database } from '@specledger/db';

// Demo visitors' sandboxes: one schema per visitor session in the demo database, a copy of the
// showcase made when the session starts, dropped after the session expires. The schema name
// carries the expiry ("sandbox_<session id>_<expiry, seconds>"), so cleanup needs no bookkeeping
// and survives restarts.

export class DemoFullError extends Error {
  constructor() {
    super('the demo has as many sandboxes as it allows');
    this.name = 'DemoFullError';
  }
}

export interface Sandboxes {
  // Creates the visitor's sandbox; throws DemoFullError at the limit.
  create(sessionId: string, expiresAt: Date): Promise<void>;
  // A sandbox schema's database (pools are kept for the most recently used sandboxes only).
  open(schema: string): Database;
  // Drops sandboxes that expired more than the grace period ago; resolves to how many.
  cleanup(): Promise<number>;
  close(): Promise<void>;
}

export interface SandboxOptions {
  readonly connectionString: string;
  // The schema copied into each sandbox: the showcase.
  readonly source: string;
  readonly maxSandboxes: number;
  // Open pools at most (two connections each).
  readonly maxOpen?: number;
  readonly now?: () => number;
}

// Requests still in flight when a session expires finish against a schema that still exists.
const GRACE_MS = 5 * 60_000;

export const schemaFor = (sessionId: string, expiresAt: Date): string =>
  `sandbox_${sessionId}_${String(Math.floor(expiresAt.getTime() / 1000))}`;

const expiryOf = (schema: string): number => Number(schema.split('_').at(-1)) * 1000;

export function createSandboxes(options: SandboxOptions): Sandboxes {
  const now = options.now ?? Date.now;
  const maxOpen = options.maxOpen ?? 8;
  const open = new Map<string, Database>();
  // Creations run one at a time: the limit check and the copy cannot interleave, and a burst of
  // new visitors does not hit the database with many schema copies at once.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const live = async () =>
    (await listSandboxes(options.connectionString)).filter((name) => expiryOf(name) > now());

  return {
    create: (sessionId, expiresAt) =>
      exclusive(async () => {
        if ((await live()).length >= options.maxSandboxes) throw new DemoFullError();
        await createSandbox({
          connectionString: options.connectionString,
          source: options.source,
          target: schemaFor(sessionId, expiresAt),
        });
      }),
    open(schema) {
      if (!SANDBOX_SCHEMA.test(schema)) throw new Error('not a sandbox schema');
      let database = open.get(schema);
      if (database === undefined) {
        database = openDatabase({
          connectionString: options.connectionString,
          schema,
          maxConnections: 2,
        });
      }
      open.delete(schema);
      open.set(schema, database);
      while (open.size > maxOpen) {
        const [oldest, pool] = open.entries().next().value as [string, Database];
        open.delete(oldest);
        void pool.close();
      }
      return database;
    },
    cleanup: () =>
      exclusive(async () => {
        const expired = (await listSandboxes(options.connectionString)).filter(
          (name) => expiryOf(name) + GRACE_MS < now(),
        );
        for (const schema of expired) {
          const pool = open.get(schema);
          open.delete(schema);
          await pool?.close();
          await dropSandbox({ connectionString: options.connectionString, schema });
        }
        return expired.length;
      }),
    async close() {
      const pools = [...open.values()];
      open.clear();
      await Promise.allSettled(pools.map((pool) => pool.close()));
    },
  };
}
