import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  environmentReportingWorker,
  exhaustingWorker,
  fakeWorkers,
  malformedReplyWorker,
  spinningWorker,
  throwingWorker,
} from '../test/support/fake-workers.js';
import { buildPdf, ownerPasswordOnlyPdf, userPasswordPdf } from '../test/support/pdfs.js';
import { INGEST_ERROR_CODES, ingestError } from './errors.js';
import type { IngestErrorCode } from './errors.js';
import { hasValidCrossReference } from './extract-worker.js';
import { createWorkerExtractor, extractPages } from './extractor.js';
import { DEFAULT_INGEST_LIMITS } from './limits.js';
import type { IngestLimits } from './limits.js';
import { validateUpload } from './validate-upload.js';

const CORPUS = new URL('../../../fixtures/corpus/', import.meta.url);
const corpusPdf = (id: string) => readFileSync(new URL(`pdf/${id}.pdf`, CORPUS));

const LIMITS: IngestLimits = { ...DEFAULT_INGEST_LIMITS, maxBytes: 1024 * 1024, maxPages: 3 };
const META = { filename: 'upload.pdf', documentType: 'datasheet', revision: null } as const;

// The whole path an upload takes before storage: byte checks, then extraction in the worker.
async function admit(bytes: Uint8Array, limits = LIMITS) {
  const upload = validateUpload(bytes, META, limits);
  if (!upload.ok) return upload;
  return extractPages(upload.value.bytes, { limits });
}

async function rejectionCode(bytes: Uint8Array): Promise<IngestErrorCode | 'accepted'> {
  const result = await admit(bytes);
  return result.ok ? 'accepted' : result.error.code;
}

const valid = buildPdf({ pages: ['Rated flow: 500 gpm (113.6 m3/h)'] });
// Offset of the cross-reference table (not the "xref" inside "startxref").
const xrefAt = valid.toString('latin1').indexOf('\nxref\n') + 1;

describe('rejection matrix', () => {
  it.each<[string, () => Uint8Array, IngestErrorCode]>([
    ['a text file renamed to .pdf', () => Buffer.from('Rated flow: 500 gpm\n'), 'NOT_A_PDF'],
    ['an HTML page sent as application/pdf', () => Buffer.from('<!doctype html>'), 'NOT_A_PDF'],
    [
      'a PDF header after leading bytes',
      () => Buffer.concat([Buffer.from(' '), valid]),
      'NOT_A_PDF',
    ],
    ['zero bytes', () => new Uint8Array(0), 'EMPTY'],
    ['a file over the size limit', () => Buffer.alloc(LIMITS.maxBytes + 1, 0x25), 'TOO_LARGE'],
    [
      'more pages than the limit',
      () => buildPdf({ pages: ['a', 'b', 'c', 'd'] }),
      'TOO_MANY_PAGES',
    ],
    ['a file that needs a password', userPasswordPdf, 'ENCRYPTED'],
    ['a file encrypted with only an owner password', ownerPasswordOnlyPdf, 'ENCRYPTED'],
    ['a file truncated before %%EOF', () => valid.subarray(0, valid.length - 7), 'CORRUPT'],
    ['a file truncated to half', () => valid.subarray(0, valid.length / 2), 'CORRUPT'],
    [
      'a corpus file (cross-reference stream) truncated to half',
      () => corpusPdf('p-102-datasheet').subarray(0, 1500),
      'CORRUPT',
    ],
    ['an image-only scanned page', () => corpusPdf('p-104-datasheet-scan'), 'NO_TEXT_LAYER'],
    [
      'cross-reference offsets that point at the wrong bytes',
      () => buildPdf({ editXref: (t) => t.replace(/\d{10} 00000 n/g, '0000000003 00000 n') }),
      'CORRUPT',
    ],
    [
      'a cross-reference table overwritten with garbage',
      () => buildPdf({ editXref: (t) => t.replace(/0000/g, 'zz@#') }),
      'CORRUPT',
    ],
    [
      'startxref pointing past the end of the file',
      () =>
        Buffer.from(
          valid.toString('latin1').replace(`startxref\n${String(xrefAt)}`, 'startxref\n999999'),
          'latin1',
        ),
      'CORRUPT',
    ],
    [
      'startxref pointing into a cross-reference stream PDF at the wrong place',
      () => {
        const text = corpusPdf('p-102-datasheet').toString('latin1');
        return Buffer.from(text.replace(/startxref\n\d+/, 'startxref\n20'), 'latin1');
      },
      'CORRUPT',
    ],
    ['a PDF header followed by text', () => Buffer.from('%PDF-1.7\nnot a document\n'), 'CORRUPT'],
  ])('rejects %s', async (_case, bytes, code) => {
    expect(await rejectionCode(bytes())).toBe(code);
  });

  it('rejects the owner-password file through its permissions, not a password failure', async () => {
    const task = getDocument({ data: new Uint8Array(ownerPasswordOnlyPdf()), verbosity: 0 });
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    expect(await pdf.getPermissions()).not.toBeNull();
    await task.destroy();
  });

  it('accepts the undamaged versions of the inputs above', async () => {
    expect(await rejectionCode(valid)).toBe('accepted');
    expect(
      await rejectionCode(
        buildPdf({ pages: ['Rated flow: 500 gpm', 'Rated head: 45 m', 'Efficiency: 78 %'] }),
      ),
    ).toBe('accepted');
    expect(await rejectionCode(corpusPdf('p-102-datasheet'))).toBe('accepted');
  });

  it('reports limits as numbers and never echoes the input', async () => {
    const pages = await admit(buildPdf({ pages: ['secret one', 'two', 'three', 'four'] }));
    expect(pages).toEqual({
      ok: false,
      error: ingestError('TOO_MANY_PAGES', { limit: 3, actual: 4 }),
    });
    const scan = await admit(corpusPdf('p-104-datasheet-scan'));
    expect(scan).toEqual({
      ok: false,
      error: ingestError('NO_TEXT_LAYER', { limit: 20, actual: 0 }),
    });
    const text = await admit(Buffer.from('%PDF-1.7\nsecret page text here\n'));
    expect(JSON.stringify(text)).not.toMatch(/secret|\n\s+at /);
  });

  it('gives every error code a fixed message without stack traces or placeholders', () => {
    for (const code of INGEST_ERROR_CODES) {
      const { message } = ingestError(code);
      expect(message).toMatch(/^[A-Z][^\n]+\.$/);
      expect(message).not.toMatch(/\bat \S+:\d+|\$\{|undefined/);
    }
  });

  it('applies the configured text threshold to the whole document', async () => {
    const sparse = buildPdf({ pages: ['Page 1'] });
    expect(await admit(sparse, { ...LIMITS, minTextChars: 6 })).toMatchObject({ ok: false });
    expect(await admit(sparse, { ...LIMITS, minTextChars: 5 })).toMatchObject({ ok: true });
  });
});

describe('cross-reference check', () => {
  it('accepts every corpus PDF and a handcrafted table, and follows /Prev sections', () => {
    const manifest = z
      .object({ documents: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(readFileSync(new URL('manifest.json', CORPUS), 'utf8')));
    for (const { id } of manifest.documents)
      expect(hasValidCrossReference(corpusPdf(id))).toBe(true);
    expect(hasValidCrossReference(valid)).toBe(true);
  });

  it('rejects a /Prev chain that loops or points nowhere', () => {
    const looped = buildPdf({ trailerExtra: `/Prev ${String(xrefAt)} ` });
    const loopAt = looped.toString('latin1').indexOf('\nxref\n') + 1;
    expect(
      hasValidCrossReference(
        Buffer.from(
          looped.toString('latin1').replace(`/Prev ${String(xrefAt)}`, `/Prev ${String(loopAt)}`),
          'latin1',
        ),
      ),
    ).toBe(false);
    expect(hasValidCrossReference(buildPdf({ trailerExtra: '/Prev 5 ' }))).toBe(false);
  });
});

describe('extracted text', () => {
  it('returns per-page text and code-point counts', async () => {
    const result = await extractPages(
      buildPdf({ pages: ['Rated flow: 500 gpm', 'Efficiency: 80 %'] }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        pages: [
          { pageNumber: 1, text: 'Rated flow: 500 gpm', charCount: 19 },
          { pageNumber: 2, text: 'Efficiency: 80 %', charCount: 16 },
        ],
      },
    });
  });

  // The Phase 2 corpus is the reference: ingestion must store page text in which every
  // ground-truth quote is found on its stated page, or the verifier could never confirm a value.
  it('finds every ground-truth quote of the corpus on its stated page', async () => {
    const truthSchema = z.object({
      documentId: z.string(),
      pageCount: z.number(),
      textLayer: z.boolean(),
      fields: z.record(z.string(), z.object({ page: z.number(), quote: z.string() }).nullable()),
    });
    const manifest = z
      .object({ documents: z.array(z.object({ id: z.string(), truth: z.string() })) })
      .parse(JSON.parse(readFileSync(new URL('manifest.json', CORPUS), 'utf8')));
    expect(manifest.documents.length).toBeGreaterThanOrEqual(30);
    let quotes = 0;
    for (const entry of manifest.documents) {
      const truth = truthSchema.parse(
        JSON.parse(readFileSync(new URL(entry.truth, CORPUS), 'utf8')),
      );
      const result = await extractPages(corpusPdf(entry.id));
      if (!truth.textLayer) {
        expect(result.ok ? 'accepted' : result.error.code, entry.id).toBe('NO_TEXT_LAYER');
        continue;
      }
      if (!result.ok) throw new Error(`${entry.id}: ${result.error.code}`);
      expect(result.value.pages, entry.id).toHaveLength(truth.pageCount);
      for (const [name, field] of Object.entries(truth.fields)) {
        if (field === null) continue;
        quotes += 1;
        expect(result.value.pages[field.page - 1]?.text, `${entry.id} ${name}`).toContain(
          field.quote,
        );
      }
    }
    expect(quotes).toBeGreaterThan(200);
  }, 30_000);
});

describe('worker isolation', () => {
  const workers = fakeWorkers();
  afterAll(() => {
    workers.remove();
  });

  it('terminates a parser that never returns at the time limit', async () => {
    const heartbeat = join(workers.dir, 'heartbeat');
    const extractor = createWorkerExtractor({
      workerUrl: workers.write('spin', spinningWorker(heartbeat)),
    });
    const started = performance.now();
    const result = await extractor.extract(valid, { ...LIMITS, parseTimeoutMs: 300 });
    const elapsed = performance.now() - started;

    expect(result).toEqual({ ok: false, error: ingestError('PARSE_TIMEOUT', { limit: 300 }) });
    expect(elapsed).toBeGreaterThanOrEqual(295);
    expect(elapsed).toBeLessThan(2_000);
    // The thread was running (it wrote heartbeats) and has stopped: no beat after the result.
    expect(existsSync(heartbeat)).toBe(true);
    const beats = readFileSync(heartbeat, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(heartbeat, 'utf8')).toBe(beats);
    expect(Number(beats)).toBeGreaterThan(0);
  });

  it('stops a parser that exceeds its memory limit', async () => {
    const extractor = createWorkerExtractor({ workerUrl: workers.write('oom', exhaustingWorker) });
    expect(await extractor.extract(valid, { ...LIMITS, parseMemoryMb: 32 })).toEqual({
      ok: false,
      error: ingestError('RESOURCE_LIMIT', { limit: 32 }),
    });
  }, 15_000);

  it('reports a crashing parser as CORRUPT without its error text', async () => {
    const extractor = createWorkerExtractor({ workerUrl: workers.write('throw', throwingWorker) });
    const result = await extractor.extract(valid, LIMITS);
    expect(result).toEqual({ ok: false, error: ingestError('CORRUPT') });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects a reply that does not match the protocol', async () => {
    const extractor = createWorkerExtractor({
      workerUrl: workers.write('malformed', malformedReplyWorker),
    });
    expect(await extractor.extract(valid, LIMITS)).toEqual({
      ok: false,
      error: ingestError('CORRUPT'),
    });
  });

  it('gives the parser no environment variables', async () => {
    const report = join(workers.dir, 'env.json');
    process.env.SPECLEDGER_CANARY = 'must-not-leak';
    try {
      const extractor = createWorkerExtractor({
        workerUrl: workers.write('env', environmentReportingWorker(report)),
      });
      expect(await extractor.extract(valid, LIMITS)).toMatchObject({ ok: true });
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual([]);
    } finally {
      delete process.env.SPECLEDGER_CANARY;
    }
  });
});
