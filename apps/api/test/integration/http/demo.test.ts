import { readFileSync } from 'node:fs';

import { demoSessionSchema } from '@specledger/core';
import { manifestSchema } from '@specledger/eval';
import { describe, expect, it } from 'vitest';

import { loadDemoDocuments } from '../../../src/demo/documents.js';
import { createDemoSessions } from '../../../src/demo/session.js';
import { createDemoWorkspace } from '../../../src/demo/workspace.js';
import type { DemoDeps } from '../../../src/http/app.js';
import { DEFAULT_INGEST_LIMITS } from '@specledger/ingest';
import {
  bearer,
  corpusPdf,
  multipart,
  processQueued,
  truthOf,
  truthProvider,
  withApp,
} from '../../support/http.js';
import { withTestDatabase } from '../../support/test-db.js';
import type { TestDatabase } from '../../support/test-db.js';

// The demo workspace: visitors get a signed session from POST /demo/session and use it on the
// /demo routes, which are bound to a database of their own. Neither credential works on the other
// side, so nothing a visitor does reaches the production data, and the role tokens never leave
// the operator.

const ROOT = new URL('../../../../../', import.meta.url).pathname;
const SECRET = 'demo-session-secret-for-integration-tests-0123';
const HOUR = 3_600_000;
const corpus = new Set(
  manifestSchema
    .parse(JSON.parse(readFileSync(`${ROOT}fixtures/corpus/manifest.json`, 'utf8')))
    .documents.map((d) => d.pdfSha256),
);

function demoSuite() {
  const demoDb = withTestDatabase({ wipeable: true });
  const clock = { now: Date.now() };
  const worker = { calls: [] as string[] };
  const sessions = createDemoSessions({ secret: SECRET, ttlMs: HOUR, now: () => clock.now });
  let workspace: ReturnType<typeof createDemoWorkspace> | undefined;
  const ctx = withApp({
    deps: {
      // Read in withApp's beforeAll, after the demo database exists.
      get demo(): DemoDeps {
        workspace ??= createDemoWorkspace({
          database: demoDb.database,
          limits: DEFAULT_INGEST_LIMITS,
          worker: {
            start: () => {
              worker.calls.push('start');
            },
            stop: () => {
              worker.calls.push('stop');
              return Promise.resolve();
            },
          },
          // Two of the curated documents keep the reset test quick.
          documents: async () => (await loadDemoDocuments(ROOT)).slice(0, 2),
        });
        const ws = workspace;
        return {
          database: demoDb.database,
          sessions,
          uploadAllowlist: corpus,
          reset: () => ws.reset(),
        };
      },
    },
  });
  const startSession = async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/demo/session' });
    expect(response.statusCode).toBe(201);
    return response.json<{ token: string; expiresAt: string }>();
  };
  return { ...ctx, demoDb, clock, worker, startSession };
}

const count = async (db: TestDatabase, table: string) =>
  (await db.query(`select count(*)::int as n from ${table}`)).rows[0]?.n;

function uploadBody(id: string, tag: string) {
  return multipart(
    {
      documentType: truthOf(id).sourceType,
      equipmentTag: tag,
      equipmentClass: truthOf(id).equipmentClass,
      synthetic: 'true',
    },
    { content: corpusPdf(id), filename: `${id}.pdf` },
  );
}

describe('demo sessions', () => {
  const s = demoSuite();

  it('are issued to anyone, are not cached, and expire', async () => {
    const response = await s.app.inject({ method: 'POST', url: '/demo/session' });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    // The response is the shared contract the web app parses.
    const { token, expiresAt } = demoSessionSchema.parse(response.json());
    expect(token).toMatch(/^demo\./);
    expect(new Date(expiresAt).getTime()).toBe(s.clock.now + HOUR);
  });

  it('open the demo routes, and only those', async () => {
    const { token } = await s.startSession();
    const visitor = { authorization: `Bearer ${token}` };
    expect((await s.app.inject({ url: '/demo/documents', headers: visitor })).statusCode).toBe(200);
    for (const url of ['/documents', '/conflicts', '/audit?entity=document:x']) {
      const response = await s.app.inject({ url, headers: visitor });
      expect(response.statusCode, url).toBe(401);
    }
    const reset = await s.app.inject({
      method: 'POST',
      url: '/admin/demo/reset',
      headers: visitor,
    });
    expect(reset.statusCode).toBe(401);
  });

  it('refuse the role tokens on the demo routes', async () => {
    for (const role of ['engineer', 'approver'] as const) {
      const response = await s.app.inject({ url: '/demo/documents', headers: bearer(role) });
      expect(response.statusCode, role).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('refuse a forged or expired session', async () => {
    const { token } = await s.startSession();
    const forged = createDemoSessions({ secret: `${SECRET}-forged`, ttlMs: HOUR }).issue().token;
    for (const bad of [forged, `${token.slice(0, -2)}xx`, 'demo']) {
      const response = await s.app.inject({
        url: '/demo/documents',
        headers: { authorization: `Bearer ${bad}` },
      });
      expect(response.statusCode).toBe(401);
    }
    s.clock.now += HOUR;
    const expired = await s.app.inject({
      url: '/demo/documents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expired.statusCode).toBe(401);
    s.clock.now -= HOUR;
  });

  it('mount every API route under /demo with the same declared auth', () => {
    const production = s.app.routeTable.filter(
      (r) => !r.url.startsWith('/demo') && r.url !== '/admin/demo/reset',
    );
    const demo = new Map(
      s.app.routeTable
        .filter((r) => r.url.startsWith('/demo/'))
        .map((r) => [`${r.method} ${r.url}`, r.auth]),
    );
    for (const route of production) {
      expect(demo.get(`${route.method} /demo${route.url}`), route.url).toEqual(route.auth);
    }
    expect(demo.get('POST /demo/session')).toBe('public');
    expect(s.app.routeTable).toContainEqual({
      method: 'POST',
      url: '/admin/demo/reset',
      auth: ['approver'],
    });
  });
});

describe('the demo workspace', () => {
  const s = demoSuite();
  const provider = truthProvider(['p-106-datasheet']);

  it('keeps everything a visitor does out of the production database', async () => {
    const { token } = await s.startSession();
    const visitor = { authorization: `Bearer ${token}` };
    const body = uploadBody('p-106-datasheet', 'P-106');
    const uploaded = await s.app.inject({
      method: 'POST',
      url: '/demo/documents',
      ...body,
      headers: { ...body.headers, ...visitor },
    });
    expect(uploaded.statusCode).toBe(202);
    await processQueued(s.demoDb, provider);

    // The visitor reviews every field and publishes, acting as both roles.
    const id = uploaded.json<{ document: { id: string } }>().document.id;
    const fields = (
      await s.app.inject({ url: `/demo/documents/${id}/fields`, headers: visitor })
    ).json<{ fields: { id: string; version: number }[] }>().fields;
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const reviewed = await s.app.inject({
        method: 'PATCH',
        url: `/demo/fields/${field.id}`,
        headers: visitor,
        payload: { action: 'accept', expectedVersion: field.version, reason: 'checked' },
      });
      expect(reviewed.statusCode).toBe(200);
    }
    const published = await s.app.inject({
      method: 'POST',
      url: '/demo/register/publish',
      headers: visitor,
    });
    expect(published.statusCode).toBe(201);

    const audit = await s.app.inject({
      url: `/demo/audit?entity=field:${fields[0]?.id ?? ''}`,
      headers: visitor,
    });
    const actors = audit.json<{ events: { actor: string }[] }>().events.map((e) => e.actor);
    // The extraction is the worker's; the review is the visitor's, by session, not by role.
    expect(actors).toHaveLength(2);
    expect(actors).toContain('system:worker');
    expect(actors.find((a) => a !== 'system:worker')).toMatch(/^demo:[A-Za-z0-9_-]{16}$/);

    for (const table of ['documents', 'fields', 'review_events', 'register_versions', 'jobs']) {
      expect(await count(s.testDb, table), table).toBe(0);
    }
    expect(await count(s.demoDb, 'register_versions')).toBe(1);
    // The production routes see none of it.
    const list = await s.app.inject({ url: '/documents', headers: bearer('engineer') });
    expect(list.json<{ documents: unknown[] }>().documents).toEqual([]);
  });

  it('accepts only the synthetic corpus PDFs, whatever the production allowlist', async () => {
    const { token } = await s.startSession();
    const body = multipart(
      {
        documentType: 'datasheet',
        equipmentTag: 'X-1',
        equipmentClass: 'centrifugal_pump',
        synthetic: 'true',
      },
      { content: new TextEncoder().encode('%PDF-1.7 not in the corpus'), filename: 'x.pdf' },
    );
    const response = await s.app.inject({
      method: 'POST',
      url: '/demo/documents',
      ...body,
      headers: { ...body.headers, authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'UPLOAD_NOT_ALLOWED' } });
  });

  it('is reset by an approver, and by nobody else', async () => {
    for (const [headers, status] of [
      [{}, 401],
      [bearer('engineer'), 403],
    ] as const) {
      const response = await s.app.inject({ method: 'POST', url: '/admin/demo/reset', headers });
      expect(response.statusCode).toBe(status);
    }
    expect(await count(s.demoDb, 'register_versions')).toBe(1);
    s.worker.calls.length = 0;

    const reset = await s.app.inject({
      method: 'POST',
      url: '/admin/demo/reset',
      headers: bearer('approver'),
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ status: 'reset', queued: 2 });
    // The worker is stopped while the database is wiped; it was never started in this test.
    expect(s.worker.calls).toEqual(['stop']);
    expect(await count(s.demoDb, 'register_versions')).toBe(0);
    expect(await count(s.demoDb, 'review_events')).toBe(0);
    const { rows } = await s.demoDb.query(
      'select original_filename as name from documents order by 1',
    );
    expect(rows.map((r) => r.name)).toEqual(['p-106-brochure.pdf', 'p-106-datasheet.pdf']);
    expect(await count(s.demoDb, 'jobs')).toBe(2);
  });
});

describe('without a demo database', () => {
  const { app } = withApp();

  it('has no demo routes at all', async () => {
    for (const [method, url] of [
      ['POST', '/demo/session'],
      ['GET', '/demo/documents'],
      ['POST', '/admin/demo/reset'],
    ] as const) {
      const response = await app.inject({ method, url, headers: bearer('approver') });
      expect(response.statusCode, url).toBe(404);
    }
  });
});

describe('demo session rate limit', () => {
  const s = demoSuite();

  it('limits how many sessions one client starts per minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await s.app.inject({ method: 'POST', url: '/demo/session' })).statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
