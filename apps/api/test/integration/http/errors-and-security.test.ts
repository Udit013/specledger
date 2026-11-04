import { randomUUID } from 'node:crypto';

import type { Database } from '@specledger/db';
import { describe, expect, it } from 'vitest';

import { bearer, multipart, TOKENS, withApp } from '../../support/http.js';
import { buildPdf } from '../../../../../packages/ingest/test/support/pdfs.js';

const PLANTED = 'PLANTED-SECRET-7f3a';
const { app, testDb, logs } = withApp();

describe('error shape', () => {
  it('answers an unknown route with 404 NOT_FOUND in the error shape', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nowhere',
      headers: bearer('engineer'),
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: Record<string, unknown> }>();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
  });

  it('answers malformed JSON with 400 VALIDATION_FAILED', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/fields/${randomUUID()}`,
      headers: { ...bearer('engineer'), 'content-type': 'application/json' },
      payload: '{"action": "accept", ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('answers a JSON body over the limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/fields/${randomUUID()}`,
      headers: { ...bearer('engineer'), 'content-type': 'application/json' },
      payload: JSON.stringify({
        action: 'accept',
        expectedVersion: 1,
        reason: 'x'.repeat(100_000),
      }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('reports validation problems by path, never echoing the input', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/fields/${randomUUID()}`,
      headers: bearer('engineer'),
      payload: { action: PLANTED, expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(PLANTED);
  });
});

describe('correlation id', () => {
  it('echoes a valid X-Request-Id and replaces an invalid one', async () => {
    const valid = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-123_abc.DEF' },
    });
    expect(valid.headers['x-request-id']).toBe('req-123_abc.DEF');
    for (const invalid of ['bad id with spaces', 'x'.repeat(200), '<script>']) {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': invalid },
      });
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('unexpected errors', () => {
  const broken = withApp({
    deps: {
      get database(): Database {
        const failing = () =>
          Promise.reject(
            new Error(
              `select * from documents where secret = '${PLANTED}' -- at Object.<anonymous> (/srv/app.js:1:1)`,
            ),
          );
        return {
          ...testDb.database,
          documents: { ...testDb.database.documents, list: failing, getWithProcessing: failing },
        };
      },
    },
  });

  it('answers 500 INTERNAL with only the correlation id, and logs no secret, SQL or stack', async () => {
    const response = await broken.app.inject({
      method: 'GET',
      url: '/documents',
      headers: { ...bearer('engineer'), 'x-request-id': 'trace-500' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected error occurred.',
        details: { correlationId: 'trace-500' },
      },
    });
    for (const text of [response.body, ...broken.logs]) {
      expect(text).not.toContain(PLANTED);
      expect(text).not.toMatch(/select \*|at Object\.<anonymous>/);
    }
    expect(broken.logs.join('')).toContain('trace-500');
  });
});

describe('secrets and document text never reach responses or logs', () => {
  it('keeps tokens, page text and bodies out of every log line', async () => {
    const body = multipart(
      {
        documentType: 'datasheet',
        equipmentTag: 'P-777',
        equipmentClass: 'centrifugal_pump',
        synthetic: 'true',
      },
      { content: buildPdf({ pages: [`Rated flow: 500 gpm ${PLANTED} rated head 45 m`] }) },
    );
    const uploaded = await app.inject({
      method: 'POST',
      url: '/documents',
      ...body,
      headers: { ...body.headers, ...bearer('engineer') },
    });
    expect(uploaded.statusCode).toBe(202);
    const id = uploaded.json<{ document: { id: string } }>().document.id;
    await app.inject({
      method: 'GET',
      url: `/documents/${id}/pages/1`,
      headers: bearer('approver'),
    });
    await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${PLANTED}` },
    });
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(PLANTED);
    expect(all).not.toContain(TOKENS.engineer);
    expect(all).not.toContain(TOKENS.approver);
  });

  it('sends security headers and honours the CORS allowlist', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://review.example.test' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://review.example.test');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    const denied = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
