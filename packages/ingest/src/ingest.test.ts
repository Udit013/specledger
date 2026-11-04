import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { err, ok } from '@specledger/core';
import type { DocumentRecord } from '@specledger/core';
import { afterAll, describe, expect, it } from 'vitest';

import { fakeWorkers, spinningWorker } from '../test/support/fake-workers.js';
import { buildPdf } from '../test/support/pdfs.js';
import { ingestError } from './errors.js';
import { createWorkerExtractor } from './extractor.js';
import type { PageExtractor } from './extractor.js';
import { ingestDocument, sha256Hex } from './ingest.js';
import type { IngestStore, IngestTransaction, NewStoredDocument } from './ingest.js';
import { DEFAULT_INGEST_LIMITS } from './limits.js';

interface Tables {
  documents: DocumentRecord[];
  blobs: Map<string, Uint8Array>;
  pages: { documentId: string; pageNumber: number; content: string }[];
}

// Holds rows in memory and applies a transaction's writes only if it completes, like Postgres.
// Concurrency is not modelled here; the race is tested against real Postgres (apps/api).
function memoryStore(failAfterBlob = false) {
  const tables: Tables = { documents: [], blobs: new Map(), pages: [] };
  let transactions = 0;
  const store: IngestStore = {
    async transaction(work) {
      transactions += 1;
      const staged: Tables = {
        documents: [...tables.documents],
        blobs: new Map(tables.blobs),
        pages: [...tables.pages],
      };
      const tx: IngestTransaction = {
        documents: {
          insertIfAbsent(input: NewStoredDocument) {
            const existing = staged.documents.find((d) => d.sha256 === input.sha256);
            if (existing) return Promise.resolve({ document: existing, created: false });
            const document = { ...input, id: randomUUID(), createdAt: new Date() };
            staged.documents.push(document);
            return Promise.resolve({ document, created: true });
          },
          putBlob(documentId, content) {
            staged.blobs.set(documentId, content);
            if (failAfterBlob) return Promise.reject(new Error('disk full'));
            return Promise.resolve();
          },
          insertPages(documentId, pages) {
            staged.pages.push(...pages.map((page) => ({ documentId, ...page })));
            return Promise.resolve();
          },
        },
      };
      const result = await work(tx);
      Object.assign(tables, staged);
      return result;
    },
  };
  return { store, tables, transactions: () => transactions };
}

const pdf = buildPdf({ pages: ['Rated flow: 500 gpm', 'Rated head: 45 m (147.6 ft)'] });
const META = { filename: 'P-101 Rev A.pdf', documentType: 'datasheet', revision: 'Rev A' } as const;

// Returns fixed pages without a worker, and counts calls.
function fixedExtractor(): PageExtractor & { calls: number } {
  return {
    calls: 0,
    extract() {
      this.calls += 1;
      return Promise.resolve(
        ok({
          pages: [
            { pageNumber: 1, text: 'Rated flow: 500 gpm', charCount: 19 },
            { pageNumber: 2, text: 'Rated head: 45 m (147.6 ft)', charCount: 27 },
          ],
        }),
      );
    },
  };
}

describe('ingestDocument', () => {
  it('stores the document, its bytes and its pages together', async () => {
    const { store, tables } = memoryStore();
    const result = await ingestDocument(
      { store, extractor: fixedExtractor(), limits: DEFAULT_INGEST_LIMITS },
      { bytes: pdf, meta: META },
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.duplicate).toBe(false);
    expect(result.value.document).toMatchObject({
      sha256: sha256Hex(pdf),
      originalFilename: 'P-101 Rev A.pdf',
      byteSize: pdf.length,
      pageCount: 2,
      documentType: 'datasheet',
      revision: 'Rev A',
    });
    expect(tables.documents).toHaveLength(1);
    expect(tables.blobs.get(result.value.document.id)).toEqual(pdf);
    expect(tables.pages.map((page) => [page.pageNumber, page.content])).toEqual([
      [1, 'Rated flow: 500 gpm'],
      [2, 'Rated head: 45 m (147.6 ft)'],
    ]);
  });

  it('returns the stored document with a duplicate flag for the same bytes', async () => {
    const { store, tables } = memoryStore();
    const deps = { store, extractor: fixedExtractor(), limits: DEFAULT_INGEST_LIMITS };
    const first = await ingestDocument(deps, { bytes: pdf, meta: META });
    const again = await ingestDocument(deps, {
      bytes: Buffer.from(pdf),
      meta: { ...META, filename: 'renamed copy.pdf', revision: 'Rev Z' },
    });
    if (!first.ok || !again.ok) throw new Error('expected both uploads to succeed');
    expect(again.value).toEqual({ document: first.value.document, duplicate: true });
    expect(tables.documents).toHaveLength(1);
    expect(tables.pages).toHaveLength(2);
  });

  it('leaves nothing behind when a write fails after the blob', async () => {
    const { store, tables } = memoryStore(true);
    await expect(
      ingestDocument(
        { store, extractor: fixedExtractor(), limits: DEFAULT_INGEST_LIMITS },
        { bytes: pdf, meta: META },
      ),
    ).rejects.toThrow('disk full');
    expect(tables).toEqual({ documents: [], blobs: new Map(), pages: [] });
  });

  it('rejects before extracting or storing anything', async () => {
    const { store, transactions } = memoryStore();
    const extractor = fixedExtractor();
    const result = await ingestDocument(
      { store, extractor, limits: DEFAULT_INGEST_LIMITS },
      { bytes: Buffer.from('MZ\x90\x00'), meta: { ...META, filename: 'setup.pdf' } },
    );
    expect(result).toEqual({ ok: false, error: ingestError('NOT_A_PDF') });
    expect(extractor.calls).toBe(0);
    expect(transactions()).toBe(0);
  });

  it('stores nothing when extraction fails', async () => {
    const { store, transactions } = memoryStore();
    const failing: PageExtractor = {
      extract: () => Promise.resolve(err(ingestError('NO_TEXT_LAYER', { limit: 20, actual: 0 }))),
    };
    const result = await ingestDocument(
      { store, extractor: failing, limits: DEFAULT_INGEST_LIMITS },
      { bytes: pdf, meta: META },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_TEXT_LAYER' } });
    expect(transactions()).toBe(0);
  });

  it('stores a path-like file name as text', async () => {
    const { store, tables } = memoryStore();
    const result = await ingestDocument(
      { store, extractor: fixedExtractor(), limits: DEFAULT_INGEST_LIMITS },
      { bytes: pdf, meta: { ...META, filename: '../../etc/passwd' } },
    );
    expect(result.ok).toBe(true);
    expect(tables.documents[0]?.originalFilename).toBe('../../etc/passwd');
  });

  it('runs onCreated in the same transaction, for new documents only', async () => {
    const { store, tables } = memoryStore();
    const seen: string[] = [];
    const deps = {
      store,
      extractor: fixedExtractor(),
      limits: DEFAULT_INGEST_LIMITS,
      onCreated: (_tx: IngestTransaction, document: DocumentRecord) => {
        seen.push(document.id);
        return Promise.resolve();
      },
    };
    const first = await ingestDocument(deps, { bytes: pdf, meta: META });
    await ingestDocument(deps, { bytes: pdf, meta: META });
    if (!first.ok) throw new Error(first.error.code);
    expect(seen).toEqual([first.value.document.id]);
    expect(tables.documents).toHaveLength(1);
  });

  it('rolls the document back when onCreated fails', async () => {
    const { store, tables } = memoryStore();
    await expect(
      ingestDocument(
        {
          store,
          extractor: fixedExtractor(),
          limits: DEFAULT_INGEST_LIMITS,
          onCreated: () => Promise.reject(new Error('enqueue failed')),
        },
        { bytes: pdf, meta: META },
      ),
    ).rejects.toThrow('enqueue failed');
    expect(tables).toEqual({ documents: [], blobs: new Map(), pages: [] });
  });

  describe('with a parser that never returns', () => {
    const workers = fakeWorkers();
    afterAll(() => {
      workers.remove();
    });

    it('returns PARSE_TIMEOUT and stores nothing', async () => {
      const { store, transactions } = memoryStore();
      const extractor = createWorkerExtractor({
        workerUrl: workers.write('spin', spinningWorker(join(workers.dir, 'beat'))),
      });
      const result = await ingestDocument(
        { store, extractor, limits: { ...DEFAULT_INGEST_LIMITS, parseTimeoutMs: 200 } },
        { bytes: pdf, meta: META },
      );
      expect(result).toEqual({ ok: false, error: ingestError('PARSE_TIMEOUT', { limit: 200 }) });
      expect(transactions()).toBe(0);
    });
  });
});
