import type { Database } from '@specledger/db';
import { createWorkerExtractor, ingestDocument } from '@specledger/ingest';
import type { IngestInput, IngestLimits, IngestStore } from '@specledger/ingest';

// Composition root for uploads: Postgres is the store, the worker-thread extractor parses, and the
// limits come from configuration. Passing `database` as an IngestStore is also the compile-time
// check that the db adapter implements the port ingest defines.
export function createIngestion(database: Database, limits: IngestLimits) {
  const store: IngestStore = database;
  const deps = { store, extractor: createWorkerExtractor(), limits };
  return (input: IngestInput) => ingestDocument(deps, input);
}
