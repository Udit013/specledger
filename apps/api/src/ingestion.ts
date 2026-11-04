import { randomUUID } from 'node:crypto';

import { err, ok } from '@specledger/core';
import type { EquipmentClass, Result } from '@specledger/core';
import type { Database, JobRecord, Repositories } from '@specledger/db';
import { createWorkerExtractor, ingestDocument, ingestError } from '@specledger/ingest';
import type { IngestedDocument, IngestError, IngestInput, IngestLimits } from '@specledger/ingest';

import { PROCESS_DOCUMENT, processDocumentPayloadSchema } from './worker/process-document.js';

// How many times a document's processing is attempted before its job is dead-lettered.
export const PROCESS_DOCUMENT_MAX_ATTEMPTS = 5;

export interface UploadInput extends IngestInput {
  // The equipment the document describes, and whether it is a synthetic corpus document (only
  // those may go to the Gemini free tier). The uploader states both; the document does not.
  readonly equipment: { readonly tag: string; readonly equipmentClass: EquipmentClass };
  readonly synthetic: boolean;
}

export interface Uploaded extends IngestedDocument {
  // The processing job enqueued with a new document; null for a duplicate, whose job was
  // enqueued with the original upload.
  readonly job: JobRecord | null;
}

export interface IngestionOptions {
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

// Composition root for uploads: Postgres is the store, the worker-thread extractor parses, the
// limits come from configuration, and a new document is enqueued for processing in the same
// transaction as its bytes and pages, so a stored document always has its job and a rolled-back
// upload leaves neither. Passing `database` as the store also checks at compile time that the db
// adapter implements the port ingest defines.
export function createIngestion(
  database: Database,
  limits: IngestLimits,
  options: IngestionOptions = {},
) {
  const clock = options.clock ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const extractor = createWorkerExtractor();

  return async (input: UploadInput): Promise<Result<Uploaded, IngestError>> => {
    const payload = processDocumentPayloadSchema.omit({ documentId: true }).safeParse({
      equipmentTag: input.equipment.tag,
      equipmentClass: input.equipment.equipmentClass,
      synthetic: input.synthetic,
    });
    if (!payload.success) {
      const fields = [...new Set(payload.error.issues.map((issue) => issue.path.join('.')))];
      return err(ingestError('INVALID_METADATA', { fields }));
    }

    let job: JobRecord | null = null;
    const stored = await ingestDocument<Repositories>(
      {
        store: database,
        extractor,
        limits,
        onCreated: async (tx, document) => {
          const now = clock();
          ({ job } = await tx.jobs.enqueue(
            {
              type: PROCESS_DOCUMENT,
              payload: { ...payload.data, documentId: document.id },
              idempotencyKey: `${PROCESS_DOCUMENT}:${document.id}`,
              maxAttempts: PROCESS_DOCUMENT_MAX_ATTEMPTS,
              runAt: now,
              correlationId: newId(),
            },
            now,
          ));
        },
      },
      input,
    );
    return stored.ok ? ok({ ...stored.value, job }) : stored;
  };
}
