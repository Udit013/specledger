import { DEFAULT_INGEST_LIMITS } from '@specledger/ingest';
import { describe, expect, it } from 'vitest';

import { loadDemoDocuments, DEMO_DOCUMENTS } from '../../src/demo/documents.js';
import { createDemoWorkspace } from '../../src/demo/workspace.js';
import { withTestDatabase } from '../support/test-db.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;

describe('the demo workspace seeding', () => {
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

  it('seeds every curated document into an empty workspace, once', async () => {
    const ws = workspace();
    expect(await ws.seedIfEmpty()).toBe(DEMO_DOCUMENTS.length);
    expect(await ws.seedIfEmpty()).toBe(0);
    const { rows } = await db.query(
      `select d.document_type, d.revision, j.payload->>'equipmentTag' as tag, j.status
         from documents d
         join jobs j on j.idempotency_key like 'process_document:' || d.sha256 || ':%'
        order by d.original_filename`,
    );
    expect(rows).toHaveLength(DEMO_DOCUMENTS.length);
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
    // Metadata comes from each document's ground truth, so the revision pair and the brochure
    // reconcile as the walkthrough describes.
    expect(rows.map((r) => [r.tag, r.document_type, r.revision])).toContainEqual([
      'M-201',
      'datasheet',
      'Rev B',
    ]);
    expect(rows.map((r) => [r.tag, r.document_type])).toContainEqual(['P-106', 'brochure']);
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
