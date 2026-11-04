import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  DEFAULT_INGEST_LIMITS,
  ingestDocument,
  createWorkerExtractor,
  sha256Hex,
} from '@specledger/ingest';
import type { IngestStore } from '@specledger/ingest';
import { PROMPT_VERSION } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

import { createIngestion } from '../../src/ingestion.js';
import { withTestDatabase } from '../support/test-db.js';

const testDb = withTestDatabase();
const corpusPdf = (id: string) =>
  readFileSync(new URL(`../../../../fixtures/corpus/pdf/${id}.pdf`, import.meta.url));
const META = {
  filename: 'P-106 datasheet.pdf',
  documentType: 'datasheet',
  revision: 'Rev A',
} as const;
// What the uploader states besides the file: the equipment, and that it is a corpus document.
const PROCESSING = {
  equipment: { tag: 'P-106', equipmentClass: 'centrifugal_pump' },
  synthetic: true,
} as const;

async function rowsFor(sha256: string) {
  const result = await testDb.query(
    `select (select count(*) from documents where sha256 = $1)::int as documents,
            (select count(*) from document_blobs b join documents d on d.id = b.document_id
              where d.sha256 = $1)::int as blobs,
            (select count(*) from document_pages p join documents d on d.id = p.document_id
              where d.sha256 = $1)::int as pages,
            (select count(*) from jobs j join documents d on j.payload->>'documentId' = d.id::text
              where d.sha256 = $1)::int as jobs`,
    [sha256],
  );
  return result.rows[0] as { documents: number; blobs: number; pages: number; jobs: number };
}

describe('ingestion against Postgres', () => {
  it('stores one document when the same bytes are uploaded twice at once', async () => {
    const ingest = createIngestion(testDb.database, DEFAULT_INGEST_LIMITS);
    const bytes = corpusPdf('p-106-datasheet');
    const [a, b] = await Promise.all([
      ingest({ ...PROCESSING, bytes, meta: META }),
      ingest({ ...PROCESSING, bytes: Buffer.from(bytes), meta: { ...META, filename: 'copy.pdf' } }),
    ]);
    if (!a.ok || !b.ok) throw new Error('expected both uploads to succeed');

    expect(a.value.document.id).toBe(b.value.document.id);
    expect([a.value.duplicate, b.value.duplicate].sort()).toEqual([false, true]);
    expect(await rowsFor(sha256Hex(bytes))).toEqual({ documents: 1, blobs: 1, pages: 1, jobs: 1 });
    expect(await testDb.database.documents.getBlob(a.value.document.id)).toEqual(
      new Uint8Array(bytes),
    );
    const [page] = await testDb.database.documents.listPages(a.value.document.id);
    expect(page?.content).toContain('Rated head 260 ft');
  });

  it("enqueues a processing job for a new document, with the uploader's metadata", async () => {
    const at = new Date('2030-01-01T00:00:00.000Z');
    const ingest = createIngestion(testDb.database, DEFAULT_INGEST_LIMITS, {
      clock: () => at,
      newId: () => '00000000-0000-4000-8000-000000000001',
    });
    const result = await ingest({ ...PROCESSING, bytes: corpusPdf('p-108-datasheet'), meta: META });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.job).toMatchObject({
      type: 'process_document',
      status: 'queued',
      idempotencyKey: `process_document:${result.value.document.sha256}:${PROMPT_VERSION}`,
      payload: {
        documentId: result.value.document.id,
        equipmentTag: 'P-106',
        equipmentClass: 'centrifugal_pump',
        synthetic: true,
      },
      maxAttempts: 5,
      runAt: at,
      correlationId: '00000000-0000-4000-8000-000000000001',
    });
    const again = await ingest({ ...PROCESSING, bytes: corpusPdf('p-108-datasheet'), meta: META });
    expect(again).toMatchObject({ ok: true, value: { duplicate: true, job: null } });
  });

  it('rejects invalid equipment metadata before storing anything', async () => {
    const ingest = createIngestion(testDb.database, DEFAULT_INGEST_LIMITS);
    const bytes = corpusPdf('p-113-datasheet');
    const result = await ingest({
      bytes,
      meta: META,
      equipment: { tag: ' ', equipmentClass: 'centrifugal_pump' },
      synthetic: true,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_METADATA', details: { fields: ['equipmentTag'] } },
    });
    expect(await rowsFor(sha256Hex(bytes))).toEqual({ documents: 0, blobs: 0, pages: 0, jobs: 0 });
  });

  it('stores one document for ten simultaneous uploads of the same bytes', async () => {
    const ingest = createIngestion(testDb.database, DEFAULT_INGEST_LIMITS);
    const bytes = corpusPdf('m-203-datasheet');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ingest({ ...PROCESSING, bytes, meta: META })),
    );
    const ids = new Set(results.map((result) => (result.ok ? result.value.document.id : 'failed')));
    expect(ids.size).toBe(1);
    expect(ids.has('failed')).toBe(false);
    expect(await rowsFor(sha256Hex(bytes))).toEqual({ documents: 1, blobs: 1, pages: 1, jobs: 1 });
  });

  it('leaves no document, blob or page when a write fails after the blob insert', async () => {
    const bytes = corpusPdf('p-105-datasheet');
    let blobWasWritten = false;
    // The real Postgres transaction, with the page insert replaced by a failure. Before failing it
    // confirms the blob is already written inside the transaction.
    const failingAfterBlob: IngestStore = {
      transaction: (work) =>
        testDb.database.transaction((tx) => {
          let documentId: string | undefined;
          return work({
            documents: {
              ...tx.documents,
              async insertIfAbsent(input) {
                const stored = await tx.documents.insertIfAbsent(input);
                documentId = stored.document.id;
                return stored;
              },
              async insertPages() {
                if (documentId !== undefined) {
                  blobWasWritten = (await tx.documents.getBlob(documentId)) !== null;
                }
                throw new Error('forced failure after the blob insert');
              },
            },
          });
        }),
    };

    await expect(
      ingestDocument(
        {
          store: failingAfterBlob,
          extractor: createWorkerExtractor(),
          limits: DEFAULT_INGEST_LIMITS,
        },
        { bytes, meta: META },
      ),
    ).rejects.toThrow('forced failure after the blob insert');
    expect(blobWasWritten).toBe(true);
    expect(await rowsFor(sha256Hex(bytes))).toEqual({ documents: 0, blobs: 0, pages: 0, jobs: 0 });
  });

  it('stores a path-like file name as text and touches no file', async () => {
    const ingest = createIngestion(testDb.database, DEFAULT_INGEST_LIMITS);
    const target = join(tmpdir(), `specledger-${randomUUID()}`);
    const traversal = relative(process.cwd(), target);
    expect(traversal.startsWith('..')).toBe(true);
    for (const [id, filename] of [
      ['p-110-datasheet', '../../etc/passwd'],
      ['p-111-datasheet', traversal],
    ] as const) {
      const bytes = corpusPdf(id);
      const result = await ingest({ ...PROCESSING, bytes, meta: { ...META, filename } });
      if (!result.ok) throw new Error(result.error.code);
      const stored = await testDb.database.documents.getById(result.value.document.id);
      expect(stored?.originalFilename).toBe(filename);
    }
    expect(existsSync(target)).toBe(false);
  });

  it('stores nothing for a document without a text layer', async () => {
    const ingest = createIngestion(testDb.database, DEFAULT_INGEST_LIMITS);
    const bytes = corpusPdf('p-104-datasheet-scan');
    const result = await ingest({ ...PROCESSING, bytes, meta: META });
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_TEXT_LAYER' } });
    expect(await rowsFor(sha256Hex(bytes))).toEqual({ documents: 0, blobs: 0, pages: 0, jobs: 0 });
  });
});
