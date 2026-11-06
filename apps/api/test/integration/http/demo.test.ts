import { demoSessionSchema } from '@specledger/core';
import { DEFAULT_INGEST_LIMITS } from '@specledger/ingest';
import { dropSandbox } from '@specledger/db';
import { afterAll, describe, expect, it } from 'vitest';

import { loadDemoDocuments } from '../../../src/demo/documents.js';
import { createSandboxes, DemoFullError, schemaFor } from '../../../src/demo/sandboxes.js';
import type { Sandboxes } from '../../../src/demo/sandboxes.js';
import { createDemoSessions } from '../../../src/demo/session.js';
import { createDemoWorkspace } from '../../../src/demo/workspace.js';
import type { DemoDeps } from '../../../src/http/app.js';
import { bearer, processQueued, truthProvider, withApp } from '../../support/http.js';
import { withTestDatabase } from '../../support/test-db.js';
import type { TestDatabase } from '../../support/test-db.js';

// The public demo: a read-only showcase anyone can browse under /showcase, and a private sandbox
// per visitor under /demo, a copy of the showcase that only that visitor's session can use. No
// demo route can upload, requeue or administer, so visitors cannot cause model calls, and nothing
// a visitor does reaches another visitor, the showcase or the real workspace.

const ROOT = new URL('../../../../../', import.meta.url).pathname;
const SECRET = 'demo-session-secret-for-integration-tests-0123';
const HOUR = 3_600_000;
const SHOWCASE_DOCUMENTS = ['p-106-datasheet', 'p-106-brochure'];
// The showcase used by these tests: two curated documents, extracted by a model that reads them
// correctly.
const provider = truthProvider(SHOWCASE_DOCUMENTS);

function demoSuite(options: { full?: boolean } = {}) {
  const showcaseDb = withTestDatabase({ wipeable: true });
  const clock = { now: Date.now() };
  const workerCalls: string[] = [];
  const sessions = createDemoSessions({ secret: SECRET, ttlMs: HOUR, now: () => clock.now });
  let deps: DemoDeps | undefined;
  const created: string[] = [];
  const real = () =>
    createSandboxes({
      connectionString: process.env.DATABASE_URL ?? '',
      source: showcaseDb.schema,
      maxSandboxes: 1_000,
      now: () => clock.now,
    });
  let inner: Sandboxes | undefined;
  // The real sandboxes, remembering what they created so the suite can drop it afterwards.
  const sandboxes: Sandboxes = {
    create: async (id, expiresAt) => {
      inner ??= real();
      await inner.create(id, expiresAt);
      created.push(schemaFor(id, expiresAt));
    },
    open: (schema) => {
      inner ??= real();
      return inner.open(schema);
    },
    cleanup: () => Promise.resolve(0),
    close: () => inner?.close() ?? Promise.resolve(),
  };
  // A demo at its sandbox limit.
  const fullSandboxes: Sandboxes = {
    ...sandboxes,
    create: () => Promise.reject(new DemoFullError()),
  };
  afterAll(async () => {
    await sandboxes.close();
    for (const schema of created) {
      await dropSandbox({ connectionString: process.env.DATABASE_URL ?? '', schema });
    }
  });
  const ctx = withApp({
    deps: {
      // Read in withApp's beforeAll, after the showcase database exists.
      get demo(): DemoDeps {
        if (deps !== undefined) return deps;
        const workspace = createDemoWorkspace({
          database: showcaseDb.database,
          limits: DEFAULT_INGEST_LIMITS,
          worker: {
            start: () => {
              workerCalls.push('start');
            },
            stop: () => {
              workerCalls.push('stop');
              return Promise.resolve();
            },
          },
          documents: async () =>
            (await loadDemoDocuments(ROOT)).filter((d) => SHOWCASE_DOCUMENTS.includes(d.id)),
        });
        deps = {
          showcase: showcaseDb.database,
          sessions,
          sandboxes: options.full === true ? fullSandboxes : sandboxes,
          isReady: () => workspace.isReady(),
          reset: async () => {
            const queued = await workspace.reset();
            await processQueued(showcaseDb, provider);
            return queued;
          },
        };
        // Seeding is idempotent: a second run (a restart mid-seed) queues nothing more.
        seed = async () => {
          const first = await workspace.ensureSeeded();
          const second = await workspace.ensureSeeded();
          await processQueued(showcaseDb, provider);
          return [first, second];
        };
        return deps;
      },
    },
  });
  let seed: () => Promise<number[]> = () => Promise.reject(new Error('not built'));
  const startSession = async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/demo/session' });
    expect(response.statusCode, response.body).toBe(201);
    const { token } = demoSessionSchema.parse(response.json());
    return { authorization: `Bearer ${token}` };
  };
  return { ...ctx, showcaseDb, clock, workerCalls, startSession, seed: () => seed() };
}

const count = async (db: TestDatabase, table: string) =>
  (await db.query(`select count(*)::int as n from ${table}`)).rows[0]?.n;

interface Field {
  id: string;
  version: number;
  reviewStatus: string;
}

describe('the demo', () => {
  const s = demoSuite();

  it('starts no visitor session until the showcase has been extracted', async () => {
    const response = await s.app.inject({ method: 'POST', url: '/demo/session' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'DEMO_NOT_READY' } });
  });

  it('seeds the showcase idempotently', async () => {
    expect(await s.seed()).toEqual([2, 0]);
    expect(await count(s.showcaseDb, 'documents')).toBe(2);
    expect(await count(s.showcaseDb, 'jobs')).toBe(2);
  });

  it('shows the showcase to anyone, read-only', async () => {
    const list = await s.app.inject({ url: '/showcase/documents' });
    expect(list.statusCode).toBe(200);
    expect(list.headers['x-specledger-workspace']).toBe('demo-showcase');
    const documents = list.json<{ documents: { id: string }[] }>().documents;
    expect(documents).toHaveLength(2);
    const fields = await s.app.inject({
      url: `/showcase/documents/${documents[0]?.id ?? ''}/fields`,
    });
    expect(fields.json<{ fields: Field[] }>().fields.length).toBeGreaterThan(0);
    for (const [method, url] of [
      ['PATCH', `/showcase/fields/${documents[0]?.id ?? ''}`],
      ['POST', '/showcase/register/publish'],
      ['POST', '/showcase/documents'],
      ['POST', '/showcase/admin/demo/reset'],
    ] as const) {
      expect((await s.app.inject({ method, url, payload: {} })).statusCode, url).toBe(404);
    }
  });

  it('gives each visitor a private sandbox; nothing reaches anyone else', async () => {
    const first = await s.startSession();
    const second = await s.startSession();
    const documents = (await s.app.inject({ url: '/demo/documents', headers: first })).json<{
      documents: { id: string }[];
    }>().documents;
    const id = documents[0]?.id ?? '';
    const fieldsOf = async (headers: Record<string, string>) =>
      (await s.app.inject({ url: `/demo/documents/${id}/fields`, headers })).json<{
        fields: Field[];
      }>().fields;

    // The first visitor reviews every value of every document and publishes.
    for (const document of documents) {
      const fields = (
        await s.app.inject({ url: `/demo/documents/${document.id}/fields`, headers: first })
      ).json<{ fields: Field[] }>().fields;
      for (const field of fields) {
        const reviewed = await s.app.inject({
          method: 'PATCH',
          url: `/demo/fields/${field.id}`,
          headers: first,
          payload: { action: 'accept', expectedVersion: field.version, reason: 'checked' },
        });
        expect(reviewed.statusCode).toBe(200);
        expect(reviewed.headers['x-specledger-workspace']).toBe('demo-sandbox');
      }
    }
    const published = await s.app.inject({
      method: 'POST',
      url: '/demo/register/publish',
      headers: first,
    });
    expect(published.statusCode, published.body).toBe(201);
    const exported = await s.app.inject({
      url: '/demo/register/versions/1/export?format=csv',
      headers: first,
    });
    expect(exported.headers['content-disposition']).toContain('DEMO-register-v1.csv');

    // The audit log names the visitor's session, not a role or a person.
    const field = (await fieldsOf(first))[0];
    const audit = await s.app.inject({
      url: `/demo/audit?entity=field:${field?.id ?? ''}`,
      headers: first,
    });
    expect(audit.json<{ events: { actor: string }[] }>().events.map((e) => e.actor)).toContainEqual(
      expect.stringMatching(/^demo:[0-9a-f]{16}$/),
    );

    // The second visitor, the showcase and the real workspace see none of it.
    expect((await fieldsOf(second)).every((f) => f.reviewStatus === 'pending')).toBe(true);
    const showcase = (await s.app.inject({ url: `/showcase/documents/${id}/fields` })).json<{
      fields: Field[];
    }>().fields;
    expect(showcase.every((f) => f.reviewStatus === 'pending')).toBe(true);
    expect(await count(s.showcaseDb, 'register_versions')).toBe(0);
    expect(await count(s.showcaseDb, 'review_events')).toBeGreaterThan(0);
    for (const table of ['documents', 'fields', 'review_events', 'register_versions', 'jobs']) {
      expect(await count(s.testDb, table), table).toBe(0);
    }
  });

  it('offers visitors no uploads, no requeue and no administration', async () => {
    const visitor = await s.startSession();
    for (const [method, url] of [
      ['POST', '/demo/documents'],
      ['POST', '/demo/admin/jobs/00000000-0000-4000-8000-000000000001/requeue'],
      ['POST', '/demo/admin/demo/reset'],
      ['GET', '/demo/admin/users'],
      ['POST', '/demo/auth/login'],
    ] as const) {
      const response = await s.app.inject({ method, url, headers: visitor, payload: {} });
      expect(response.statusCode, url).toBe(404);
    }
    for (const [method, url] of [
      ['GET', '/documents'],
      ['GET', '/auth/me'],
      ['POST', '/admin/demo/reset'],
      ['POST', '/register/publish'],
    ] as const) {
      const response = await s.app.inject({ method, url, headers: visitor });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('refuses workspace sessions on the demo routes', async () => {
    for (const role of ['engineer', 'reviewer', 'approver', 'admin'] as const) {
      const response = await s.app.inject({ url: '/demo/documents', headers: bearer(role) });
      expect(response.statusCode, role).toBe(401);
    }
  });

  it('refuses a forged or expired visitor session', async () => {
    const visitor = await s.startSession();
    const forged = createDemoSessions({ secret: `${SECRET}-forged`, ttlMs: HOUR }).issue().token;
    for (const bad of [
      `Bearer ${forged}`,
      `${visitor.authorization.slice(0, -2)}xx`,
      'Bearer demo',
    ]) {
      const response = await s.app.inject({
        url: '/demo/documents',
        headers: { authorization: bad },
      });
      expect(response.statusCode).toBe(401);
    }
    s.clock.now += HOUR;
    expect((await s.app.inject({ url: '/demo/documents', headers: visitor })).statusCode).toBe(401);
    s.clock.now -= HOUR;
  });

  it('lets only an admin reset the showcase, which leaves sandboxes alone', async () => {
    const visitor = await s.startSession();
    for (const [headers, status] of [
      [{}, 401],
      [bearer('approver'), 403],
      [bearer('engineer'), 403],
    ] as const) {
      const response = await s.app.inject({ method: 'POST', url: '/admin/demo/reset', headers });
      expect(response.statusCode).toBe(status);
    }
    s.workerCalls.length = 0;
    const reset = await s.app.inject({
      method: 'POST',
      url: '/admin/demo/reset',
      headers: bearer('admin'),
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ status: 'reset', queued: 2 });
    expect(s.workerCalls).toEqual(['stop']);
    expect(await count(s.showcaseDb, 'documents')).toBe(2);
    expect(await count(s.showcaseDb, 'register_versions')).toBe(0);
    expect((await s.app.inject({ url: '/demo/documents', headers: visitor })).statusCode).toBe(200);
  });
});

describe('the demo sandbox limit', () => {
  const s = demoSuite({ full: true });

  it('answers 503 DEMO_FULL when the sandbox limit is reached', async () => {
    await s.seed();
    const full = await s.app.inject({ method: 'POST', url: '/demo/session' });
    expect(full.statusCode).toBe(503);
    expect(full.json()).toMatchObject({ error: { code: 'DEMO_FULL' } });
  });
});

describe('the demo session rate limit', () => {
  const s = demoSuite();

  it('limits how many sessions one client starts per minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await s.app.inject({ method: 'POST', url: '/demo/session' })).statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('without a demo database', () => {
  const { app } = withApp();

  it('has no demo routes at all', async () => {
    for (const [method, url] of [
      ['POST', '/demo/session'],
      ['GET', '/demo/documents'],
      ['GET', '/showcase/documents'],
      ['POST', '/admin/demo/reset'],
    ] as const) {
      const response = await app.inject({ method, url, headers: bearer('admin') });
      expect(response.statusCode, url).toBe(404);
    }
  });
});
