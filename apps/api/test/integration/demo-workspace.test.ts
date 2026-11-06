import { randomBytes } from 'node:crypto';

import { DEFAULT_INGEST_LIMITS } from '@specledger/ingest';
import { describe, expect, it } from 'vitest';

import { DEMO_DOCUMENTS, loadDemoDocuments } from '../../src/demo/documents.js';
import { createSandboxes, DemoFullError, schemaFor } from '../../src/demo/sandboxes.js';
import { createDemoWorkspace } from '../../src/demo/workspace.js';
import { withTestDatabase } from '../support/test-db.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const url = () => process.env.DATABASE_URL ?? '';

describe('the demo showcase seeding', () => {
  const db = withTestDatabase({ wipeable: true });
  const calls: string[] = [];
  const workspace = () =>
    createDemoWorkspace({
      database: db.database,
      limits: DEFAULT_INGEST_LIMITS,
      worker: {
        start: () => {
          calls.push('start');
        },
        stop: () => {
          calls.push('stop');
          return Promise.resolve();
        },
      },
      documents: () => loadDemoDocuments(ROOT),
    });

  it('completes the curated set without queueing anything twice', async () => {
    const ws = workspace();
    // A restart in the middle of seeding: some documents are already stored.
    const partial = createDemoWorkspace({
      database: db.database,
      limits: DEFAULT_INGEST_LIMITS,
      worker: { start: () => undefined, stop: () => Promise.resolve() },
      documents: async () => (await loadDemoDocuments(ROOT)).slice(0, 3),
    });
    expect(await partial.ensureSeeded()).toBe(3);
    expect(await ws.ensureSeeded()).toBe(DEMO_DOCUMENTS.length - 3);
    // Concurrent runs, as on two instances: still one document and one job per file.
    expect(await Promise.all([ws.ensureSeeded(), workspace().ensureSeeded()])).toEqual([0, 0]);
    const { rows } = await db.query(
      `select d.document_type, d.revision, j.payload->>'equipmentTag' as tag, j.status
         from documents d
         join jobs j on j.idempotency_key like 'process_document:' || d.sha256 || ':%'
        order by d.original_filename`,
    );
    expect(rows).toHaveLength(DEMO_DOCUMENTS.length);
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
    expect(rows.map((r) => [r.tag, r.document_type, r.revision])).toContainEqual([
      'M-201',
      'datasheet',
      'Rev B',
    ]);
    expect(await ws.isReady()).toBe(false);
  });

  it('restarts a running worker after a reset, and runs resets one at a time', async () => {
    const ws = workspace();
    ws.start();
    calls.length = 0;
    const [first, second] = await Promise.all([ws.reset(), ws.reset()]);
    expect([first, second]).toEqual([DEMO_DOCUMENTS.length, DEMO_DOCUMENTS.length]);
    expect(calls).toEqual(['stop', 'start', 'stop', 'start']);
    const { rows } = await db.query('select count(*)::int as n from documents');
    expect(rows).toEqual([{ n: DEMO_DOCUMENTS.length }]);
  });
});

describe('demo sandboxes', () => {
  const db = withTestDatabase();

  it('are dropped once they have expired, and not before', async () => {
    const at = { now: Date.now() };
    const sandboxes = createSandboxes({
      connectionString: url(),
      source: db.schema,
      maxSandboxes: 100,
      now: () => at.now,
    });
    const id = randomBytes(8).toString('hex');
    const expiresAt = new Date(at.now + 60_000);
    await sandboxes.create(id, expiresAt);
    const schema = schemaFor(id, expiresAt);
    const exists = async () =>
      (await db.query('select 1 from pg_namespace where nspname = $1', [schema])).rows.length;
    expect(await sandboxes.open(schema).documents.list({ limit: 1, offset: 0 })).toEqual([]);
    expect(await sandboxes.cleanup()).toBe(0);
    expect(await exists()).toBe(1);
    at.now += 60_000 + 5 * 60_000 + 1_000;
    expect(await sandboxes.cleanup()).toBeGreaterThanOrEqual(1);
    expect(await exists()).toBe(0);
    await sandboxes.close();
  });

  it('refuses a new sandbox at the limit', async () => {
    const sandboxes = createSandboxes({
      connectionString: url(),
      source: db.schema,
      maxSandboxes: 0,
    });
    await expect(
      sandboxes.create(randomBytes(8).toString('hex'), new Date(Date.now() + 60_000)),
    ).rejects.toBeInstanceOf(DemoFullError);
  });

  it('refuses to open anything but a sandbox schema', () => {
    const sandboxes = createSandboxes({
      connectionString: url(),
      source: db.schema,
      maxSandboxes: 1,
    });
    expect(() => sandboxes.open('public')).toThrow(/sandbox/);
    expect(() => sandboxes.open(db.schema)).toThrow(/sandbox/);
  });
});
