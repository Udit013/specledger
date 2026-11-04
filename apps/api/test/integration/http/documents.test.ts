import { randomUUID } from 'node:crypto';

import { sha256Hex } from '@specledger/ingest';
import { PROMPT_VERSION } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

import {
  buildPdf,
  ownerPasswordOnlyPdf,
} from '../../../../../packages/ingest/test/support/pdfs.js';
import {
  bearer,
  corpusPdf,
  multipart,
  processQueued,
  truthProvider,
  uniqueTag,
  upload,
  withApp,
} from '../../support/http.js';

const { app, testDb } = withApp({ limits: { maxBytes: 2 * 1024 * 1024 } });
const FIELDS = {
  documentType: 'datasheet',
  revision: 'Rev A',
  equipmentTag: 'P-1',
  equipmentClass: 'centrifugal_pump',
};

const post = (
  fields: Record<string, string>,
  file?: Parameters<typeof multipart>[1],
  headers = {},
) => {
  const body = multipart(fields, file);
  return app.inject({
    method: 'POST',
    url: '/documents',
    ...body,
    headers: { ...body.headers, ...bearer('engineer'), ...headers },
  });
};

describe('POST /documents', () => {
  it('stores the document, enqueues its job with the request id, and returns 202', async () => {
    const requestId = 'upload-test-0001';
    const response = await upload(
      app,
      'p-108-datasheet',
      uniqueTag('P-108'),
      {},
      { 'x-request-id': requestId },
    );
    expect(response.statusCode).toBe(202);
    expect(response.headers['x-request-id']).toBe(requestId);
    const body = response.json<{
      document: { id: string; sha256: string; processing: unknown };
      duplicate: boolean;
    }>();
    expect(body).toMatchObject({
      duplicate: false,
      document: { processing: { status: 'queued', attempts: 0 } },
    });
    expect(body.document.sha256).toBe(sha256Hex(corpusPdf('p-108-datasheet')));
    const { rows } = await testDb.query(
      `select idempotency_key, correlation_id::text from jobs where payload->>'documentId' = $1`,
      [body.document.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe(
      `process_document:${body.document.sha256}:${PROMPT_VERSION}`,
    );
    expect(rows[0]?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 200 with the existing document for the same bytes', async () => {
    const tag = uniqueTag('P-105');
    const first = await upload(app, 'p-105-datasheet', tag);
    const again = await upload(app, 'p-105-datasheet', tag);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      duplicate: true,
      document: { id: first.json<{ document: { id: string } }>().document.id },
    });
  });

  it.each([
    ['a missing equipment tag', { ...FIELDS, equipmentTag: '' }],
    ['an unknown equipment class', { ...FIELDS, equipmentClass: 'compressor' }],
    ['an unknown document type', { ...FIELDS, documentType: 'invoice' }],
    ['an unknown field', { ...FIELDS, comment: 'hello' }],
  ])('rejects %s with 400 VALIDATION_FAILED', async (_case, fields) => {
    const response = await post(fields, {
      content: buildPdf({ pages: ['Rated flow: 500 gpm, rated head 45 m'] }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects a request without a file part', async () => {
    const response = await post(FIELDS);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects a body that is not multipart with 415', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { ...bearer('engineer'), 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  // The Phase 3 rejection matrix, over HTTP.
  it.each<[string, Uint8Array, number, string]>([
    ['a text file named .pdf', Buffer.from('Rated flow: 500 gpm\n'), 400, 'NOT_A_PDF'],
    ['zero bytes', new Uint8Array(0), 400, 'EMPTY'],
    ['a file over the size limit', Buffer.alloc(3 * 1024 * 1024, 0x25), 413, 'TOO_LARGE'],
    ['an encrypted PDF', ownerPasswordOnlyPdf(), 422, 'ENCRYPTED'],
    ['a truncated PDF', buildPdf().subarray(0, 200), 422, 'CORRUPT'],
    ['an image-only scan', corpusPdf('p-104-datasheet-scan'), 422, 'NO_TEXT_LAYER'],
  ])('rejects %s with %i %s', async (_case, content, status, code) => {
    const response = await post(FIELDS, { content, contentType: 'application/pdf' });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
  });
});

describe('GET /documents and GET /documents/:id', () => {
  it('lists documents newest first with their processing status, and reads one', async () => {
    const tag = uniqueTag('P-113');
    const uploaded = await upload(app, 'p-113-datasheet', tag);
    const id = uploaded.json<{ document: { id: string } }>().document.id;
    await processQueued(
      testDb,
      truthProvider(['p-113-datasheet', 'p-108-datasheet', 'p-105-datasheet']),
    );

    const list = await app.inject({
      method: 'GET',
      url: '/documents?limit=100',
      headers: bearer('approver'),
    });
    expect(list.statusCode).toBe(200);
    const documents = list.json<{ documents: { id: string; processing: { status: string } }[] }>()
      .documents;
    expect(documents.find((d) => d.id === id)).toMatchObject({
      processing: { status: 'succeeded', attempts: 1, lastErrorCode: null },
    });

    const one = await app.inject({
      method: 'GET',
      url: `/documents/${id}`,
      headers: bearer('engineer'),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({
      id,
      originalFilename: 'p-113-datasheet.pdf',
      documentType: 'datasheet',
      revision: 'Rev A',
    });
  });

  it.each([
    '/documents?limit=0',
    '/documents?limit=101',
    '/documents?offset=-1',
    '/documents?page=2',
    '/documents/not-a-uuid',
  ])('rejects %s with 400', async (url) => {
    const response = await app.inject({ method: 'GET', url, headers: bearer('engineer') });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('returns 404 for an unknown document', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/documents/${randomUUID()}`,
      headers: bearer('engineer'),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('GET /documents/:id/pages/:n and /fields', () => {
  it('returns a page and the fields of the latest run', async () => {
    const tag = uniqueTag('P-110');
    const uploaded = await upload(app, 'p-110-datasheet', tag);
    const id = uploaded.json<{ document: { id: string } }>().document.id;
    await processQueued(testDb, truthProvider(['p-110-datasheet']));

    const page = await app.inject({
      method: 'GET',
      url: `/documents/${id}/pages/1`,
      headers: bearer('engineer'),
    });
    expect(page.statusCode).toBe(200);
    const pageBody = page.json<{ documentId: string; pageNumber: number; content: string }>();
    expect(pageBody).toMatchObject({ documentId: id, pageNumber: 1 });
    expect(pageBody.content).toContain('SYNTHETIC TEST DOCUMENT');

    const fields = await app.inject({
      method: 'GET',
      url: `/documents/${id}/fields`,
      headers: bearer('approver'),
    });
    expect(fields.statusCode).toBe(200);
    const list = fields.json<{
      fields: { name: string; verificationStatus: string; reviewStatus: string; version: number }[];
    }>().fields;
    expect(list.length).toBeGreaterThan(0);
    expect(
      list.every(
        (f) =>
          f.verificationStatus === 'verified' && f.reviewStatus === 'pending' && f.version === 1,
      ),
    ).toBe(true);
    expect(list.map((f) => f.name)).toEqual([...list.map((f) => f.name)].sort());
  });

  it('returns 404 for a page beyond the document and 400 for a bad page number', async () => {
    const uploaded = await upload(app, 'm-210-datasheet', uniqueTag('M-210'));
    const id = uploaded.json<{ document: { id: string } }>().document.id;
    const missing = await app.inject({
      method: 'GET',
      url: `/documents/${id}/pages/99`,
      headers: bearer('engineer'),
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'GET',
      url: `/documents/${id}/pages/0`,
      headers: bearer('engineer'),
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'GET',
      url: `/documents/${randomUUID()}/fields`,
      headers: bearer('engineer'),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('upload rate limit', () => {
  const limited = withApp({ http: { uploadRateLimitPerMinute: 2 } });

  it('answers 429 once the upload limit is reached, while reads stay open', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const body = multipart(FIELDS, { content: Buffer.from('not a pdf') });
      const response = await limited.app.inject({
        method: 'POST',
        url: '/documents',
        ...body,
        headers: { ...body.headers, ...bearer('engineer') },
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429)
        expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    }
    expect(statuses).toEqual([400, 400, 429]);
    const read = await limited.app.inject({
      method: 'GET',
      url: '/documents',
      headers: bearer('engineer'),
    });
    expect(read.statusCode).toBe(200);
  });
});
