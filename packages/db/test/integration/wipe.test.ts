import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/database.js';
import { seedField } from '../support/fixtures.js';
import { withTestDb } from '../support/test-db.js';

const testDb = withTestDb();
const url = () => process.env.DATABASE_URL ?? '';

describe('wipe', () => {
  it('is refused by a database not opened as wipeable', async () => {
    await expect(testDb.database.wipe()).rejects.toThrow(/not opened as wipeable/);
  });

  it('empties every table, even a published register, and leaves the schema migrated', async () => {
    await seedField(testDb.database);
    const draft = await testDb.database.register.createDraftVersion(1);
    await testDb.database.register.publishVersion(draft.id, 'role:approver', new Date());
    const wipeable = openDatabase({
      connectionString: url(),
      schema: testDb.schema,
      wipeable: true,
    });
    try {
      await wipeable.wipe();
      for (const table of ['documents', 'fields', 'review_events', 'register_versions', 'jobs']) {
        const { rows } = await testDb.query(`select count(*)::int as n from ${table}`);
        expect(rows, table).toEqual([{ n: 0 }]);
      }
      // Migrated again: the tables, triggers and seeded counter row are back.
      await seedField(wipeable);
      const { rows } = await testDb.query('select last_number from register_counter');
      expect(rows).toEqual([{ last_number: 0 }]);
    } finally {
      await wipeable.close();
    }
  });
});
