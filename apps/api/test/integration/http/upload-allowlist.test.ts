import { sha256Hex } from '@specledger/ingest';
import { describe, expect, it } from 'vitest';

import { corpusAllowlist } from '../../../src/http/server.js';
import { corpusPdf, upload, uniqueTag, withApp } from '../../support/http.js';

// A public demo accepts only the synthetic corpus: nothing else is stored, queued or sent to the
// model, whatever the uploader claims about it.
const allowed = sha256Hex(corpusPdf('p-108-datasheet'));
const { app, testDb } = withApp({ deps: { uploadAllowlist: new Set([allowed]) } });

describe('upload allowlist', () => {
  it('accepts a document on the list', async () => {
    const response = await upload(app, 'p-108-datasheet', uniqueTag('P-108'));
    expect(response.statusCode).toBe(202);
  });

  it('refuses any other document with 403 UPLOAD_NOT_ALLOWED, storing and queuing nothing', async () => {
    const before = await testDb.query('select count(*)::int as n from documents');
    const response = await upload(app, 'p-105-datasheet', uniqueTag('P-105'));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'UPLOAD_NOT_ALLOWED' } });
    const after = await testDb.query('select count(*)::int as n from documents');
    expect(after.rows).toEqual(before.rows);
    const jobs = await testDb.query(
      `select count(*)::int as n from jobs where payload->>'equipmentTag' like 'P-105%'`,
    );
    expect(jobs.rows).toEqual([{ n: 0 }]);
  });
});

describe('corpusAllowlist', () => {
  it('lists the sha256 of every corpus PDF', async () => {
    const list = await corpusAllowlist();
    expect(list.size).toBe(45);
    expect(list.has(allowed)).toBe(true);
    expect(list.has(sha256Hex(corpusPdf('p-105-datasheet')))).toBe(true);
  });
});
