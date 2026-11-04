import { randomUUID } from 'node:crypto';

import type { Database } from '@specledger/db';
import { describe, expect, it } from 'vitest';

import { bearer, upload, uniqueTag, withApp } from '../../support/http.js';

const { app, testDb } = withApp();

describe('POST /admin/jobs/:id/requeue', () => {
  it('moves a dead job back to the queue', async () => {
    const uploaded = await upload(app, 'p-108-datasheet', uniqueTag('P-108'));
    const documentId = uploaded.json<{ document: { id: string } }>().document.id;
    const { rows } = await testDb.query(`select id from jobs where payload->>'documentId' = $1`, [
      documentId,
    ]);
    const jobId = String(rows[0]?.id);
    await testDb.query(
      `update jobs set status = 'dead', attempts = max_attempts, last_error = 'LLM_TIMEOUT: x' where id = $1`,
      [jobId],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${jobId}/requeue`,
      headers: bearer('approver'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId, status: 'queued' });
    expect((await testDb.database.jobs.getById(jobId))?.attempts).toBe(0);

    const again = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${jobId}/requeue`,
      headers: bearer('approver'),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'JOB_NOT_DEAD' } });
  });

  it('returns 404 for an unknown job and 400 for a bad id', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/jobs/${randomUUID()}/requeue`,
          headers: bearer('approver'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/jobs/42/requeue',
          headers: bearer('approver'),
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('probes', () => {
  it('answers /health without a token or the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers /ready when the database responds', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  describe('when the database hangs', () => {
    const hanging = withApp({
      http: { readyTimeoutMs: 200 },
      deps: {
        get database(): Database {
          return { ...testDb.database, ping: () => new Promise<void>(() => undefined) };
        },
      },
    });

    it('answers /ready with 503 NOT_READY within its timeout, and /health still with 200', async () => {
      const started = Date.now();
      const ready = await hanging.app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ error: { code: 'NOT_READY' } });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((await hanging.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });
  });
});
