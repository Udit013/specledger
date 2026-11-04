import { describe, expect, it } from 'vitest';

import { withTestDb } from '../support/test-db.js';

const testDb = withTestDb();

const EXPECTED_TABLES = [
  '__migrations',
  'conflicts',
  'document_blobs',
  'document_pages',
  'documents',
  'equipment',
  'extraction_runs',
  'fields',
  'jobs',
  'register_counter',
  'register_items',
  'register_versions',
  'review_events',
];

async function snapshot() {
  const tables = await testDb.query(
    'select table_name from information_schema.tables where table_schema = $1 order by table_name',
    [testDb.schema],
  );
  const applied = await testDb.query('select id, hash, created_at from __migrations order by id');
  const triggers = await testDb.query(
    `select event_object_table as table_name, trigger_name, event_manipulation
       from information_schema.triggers where trigger_schema = $1
      order by 1, 2, 3`,
    [testDb.schema],
  );
  return { tables: tables.rows, applied: applied.rows, triggers: triggers.rows };
}

describe('migrations', () => {
  it('apply cleanly into an empty schema', async () => {
    const { tables, applied } = await snapshot();
    expect(tables.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);
    expect(applied).toHaveLength(6);
  });

  it('install the immutability triggers', async () => {
    const { triggers } = await snapshot();
    const names = new Set(
      triggers.map((row) => `${String(row.table_name)}.${String(row.trigger_name)}`),
    );
    expect([...names].sort()).toEqual([
      'register_items.register_items_immutable_once_published',
      'register_versions.register_versions_immutable_once_published',
      'review_events.review_events_append_only',
    ]);
    // information_schema does not list TRUNCATE triggers; pg_trigger does.
    const truncate = await testDb.query(
      `select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and (t.tgtype & 32) <> 0 order by tgname`,
      [testDb.schema],
    );
    expect(truncate.rows.map((row) => row.tgname)).toEqual([
      'register_items_no_truncate',
      'register_versions_no_truncate',
      'review_events_no_truncate',
    ]);
  });

  it('are a no-op when run a second time', async () => {
    const before = await snapshot();
    await testDb.database.migrate();
    await testDb.database.migrate();
    expect(await snapshot()).toEqual(before);
  });

  it('create every table inside the test schema, never in public', async () => {
    const { rows } = await testDb.query(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = any($1)",
      [EXPECTED_TABLES],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});
