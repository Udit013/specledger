import type { Database } from '@specledger/db';
import type { IngestLimits } from '@specledger/ingest';

import { createIngestion } from '../ingestion.js';
import type { Worker } from '../worker/worker.js';
import type { DemoDocument } from './documents.js';

// The demo workspace: a database of its own (never the production one), its own extraction
// worker, and the curated documents it starts with. Visitors work only here. Seeding and resetting
// run one at a time; a reset stops the worker, wipes the database, seeds it again and restarts it.
export interface DemoWorkspace {
  readonly database: Database;
  start(): void;
  stop(): Promise<void>;
  // Seeds the curated documents if the workspace has no document yet; returns how many it queued.
  seedIfEmpty(): Promise<number>;
  // Removes everything visitors did and seeds the curated documents again.
  reset(): Promise<number>;
}

export interface DemoWorkspaceOptions {
  // Opened with `wipeable: true`; the production database never is.
  readonly database: Database;
  readonly limits: IngestLimits;
  readonly worker: Pick<Worker, 'start' | 'stop'>;
  readonly documents: () => Promise<readonly DemoDocument[]>;
}

export function createDemoWorkspace(options: DemoWorkspaceOptions): DemoWorkspace {
  const { database, worker } = options;
  const upload = createIngestion(database, options.limits);
  let running = false;
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  // Uploads go through the same ingestion as the API's, so each document is parsed, stored and
  // queued for extraction by the configured model exactly as a visitor's upload would be.
  async function seed(): Promise<number> {
    let queued = 0;
    for (const document of await options.documents()) {
      const stored = await upload({
        bytes: document.bytes,
        meta: {
          filename: document.filename,
          contentType: 'application/pdf',
          documentType: document.documentType,
          revision: document.revision,
        },
        equipment: { tag: document.equipmentTag, equipmentClass: document.equipmentClass },
        synthetic: true,
      });
      if (!stored.ok) throw new Error(`demo document ${document.id}: ${stored.error.code}`);
      if (!stored.value.duplicate) queued += 1;
    }
    return queued;
  }

  return {
    database,
    start() {
      running = true;
      worker.start();
    },
    async stop() {
      running = false;
      await worker.stop();
    },
    seedIfEmpty: () =>
      exclusive(async () =>
        (await database.documents.list({ limit: 1, offset: 0 })).length === 0 ? seed() : 0,
      ),
    reset: () =>
      exclusive(async () => {
        const wasRunning = running;
        await worker.stop();
        try {
          await database.wipe();
          return await seed();
        } finally {
          if (wasRunning) worker.start();
        }
      }),
  };
}
