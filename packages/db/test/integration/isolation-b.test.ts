import { describe, expect, it } from 'vitest';

import { newDocument, SHA_A } from '../support/fixtures.js';
import { withTestDb } from '../support/test-db.js';

// isolation-a and isolation-b write identical rows (same sha256, same equipment tag). Both are
// unique keys, so if the two files shared a schema while running in parallel, one would fail.
const testDb = withTestDb();

describe('per-file schema isolation (file b)', () => {
  it('runs in its own schema', async () => {
    const { rows } = await testDb.query('select current_schema() as schema');
    expect(rows[0]).toEqual({ schema: testDb.schema });
  });

  it('writes rows that the other file also writes, without a unique violation', async () => {
    await testDb.database.transaction(async (tx) => {
      await tx.documents.insert(newDocument({ sha256: SHA_A }));
      await tx.equipment.insert({ tag: 'P-101', equipmentClass: 'centrifugal_pump' });
      // Hold the transaction open briefly so the two files overlap in time.
      await testDb.query('select pg_sleep(0.3)');
    });
    const { rows } = await testDb.query('select count(*)::int as n from documents');
    expect(rows[0]).toEqual({ n: 1 });
  });
});
