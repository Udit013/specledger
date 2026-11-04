import { createHash } from 'node:crypto';

import { ok } from '@specledger/core';
import type { DocumentRecord, DocumentType, Result } from '@specledger/core';

import type { IngestError } from './errors.js';
import type { PageExtractor } from './extractor.js';
import type { IngestLimits } from './limits.js';
import { validateUpload } from './validate-upload.js';
import type { UploadMeta } from './validate-upload.js';

export interface NewStoredDocument {
  readonly sha256: string;
  readonly originalFilename: string;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly documentType: DocumentType;
  readonly revision: string | null;
}

// Storage as ingestion needs it. @specledger/db implements it; ingest does not import db, so the
// composition root (apps/api) passes the database in.
export interface IngestTransaction {
  readonly documents: {
    // Insert unless a document with the same sha256 exists, decided by the unique constraint
    // (insert ... on conflict do nothing, then select), never by a separate check beforehand.
    insertIfAbsent(
      input: NewStoredDocument,
    ): Promise<{ readonly document: DocumentRecord; readonly created: boolean }>;
    putBlob(documentId: string, content: Uint8Array): Promise<void>;
    insertPages(
      documentId: string,
      pages: readonly { pageNumber: number; content: string }[],
    ): Promise<void>;
  };
}

export interface IngestStore {
  transaction<T>(work: (tx: IngestTransaction) => Promise<T>): Promise<T>;
}

export interface IngestDeps {
  readonly store: IngestStore;
  readonly extractor: PageExtractor;
  readonly limits: IngestLimits;
}

export interface IngestInput {
  readonly bytes: Uint8Array;
  readonly meta: UploadMeta;
}

export interface IngestedDocument {
  readonly document: DocumentRecord;
  // True when these bytes were already stored: `document` is the earlier one, unchanged, and its
  // file name, type and revision are those of the first upload.
  readonly duplicate: boolean;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

// Validates, extracts and stores one upload. The document row, its bytes and its pages are written
// in one transaction, so a failure part way leaves nothing behind. Expected rejections are
// returned; database failures propagate as thrown errors.
export async function ingestDocument(
  deps: IngestDeps,
  input: IngestInput,
): Promise<Result<IngestedDocument, IngestError>> {
  const upload = validateUpload(input.bytes, input.meta, deps.limits);
  if (!upload.ok) return upload;
  const { bytes } = upload.value;

  const extracted = await deps.extractor.extract(bytes, deps.limits);
  if (!extracted.ok) return extracted;
  const { pages } = extracted.value;

  const stored = await deps.store.transaction(async (tx) => {
    const { document, created } = await tx.documents.insertIfAbsent({
      sha256: sha256Hex(bytes),
      originalFilename: upload.value.displayFilename,
      byteSize: bytes.byteLength,
      pageCount: pages.length,
      documentType: upload.value.documentType,
      revision: upload.value.revision,
    });
    if (!created) return { document, duplicate: true };
    await tx.documents.putBlob(document.id, bytes);
    await tx.documents.insertPages(
      document.id,
      pages.map((page) => ({ pageNumber: page.pageNumber, content: page.text })),
    );
    return { document, duplicate: false };
  });
  return ok(stored);
}
