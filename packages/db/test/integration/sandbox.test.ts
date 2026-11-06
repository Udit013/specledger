import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/database.js';
import {
  COPIED_TABLES,
  createSandbox,
  dropSandbox,
  listSandboxes,
  NOT_COPIED_TABLES,
} from '../../src/sandbox.js';
import { seedField } from '../support/fixtures.js';
import { withTestDb } from '../support/test-db.js';

const testDb = withTestDb();
const url = () => process.env.DATABASE_URL ?? '';
const counts = async (schema: string) => {
  const result: Record<string, number> = {};
  for (const table of COPIED_TABLES) {
    const { rows } = await testDb.query(`select count(*)::int as n from "${schema}"."${table}"`);
    result[table] = (rows[0] as { n: number }).n;
  }
  return result;
};

describe('sandboxes', () => {
  it('names every table as copied or deliberately not copied', async () => {
    const { rows } = await testDb.query(
      `select table_name as name from information_schema.tables
        where table_schema = $1 and table_name <> '__migrations' order by 1`,
      [testDb.schema],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...COPIED_TABLES, ...NOT_COPIED_TABLES].sort());
  });

  it('copies all data, including a published version, and stays independent', async () => {
    await seedField(testDb.database);
    const draft = await testDb.database.register.createDraftVersion(1);
    await testDb.database.register.publishVersion(draft.id, 'user:a@example.com', new Date());
    const target = `sandbox_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await createSandbox({ connectionString: url(), source: testDb.schema, target });
    try {
      expect(await counts(target)).toEqual(await counts(testDb.schema));
      const sandbox = openDatabase({ connectionString: url(), schema: target });
      try {
        const version = await sandbox.register.getVersion(draft.id);
        expect(version?.publishedAt).not.toBeNull();
        // A write in the sandbox leaves the source as it was.
        const before = await counts(testDb.schema);
        const next = await sandbox.register.createDraftVersion(2);
        expect(next.number).toBe(2);
        expect(await counts(testDb.schema)).toEqual(before);
      } finally {
        await sandbox.close();
      }
      expect(await listSandboxes(url())).toContain(target);
    } finally {
      await dropSandbox({ connectionString: url(), schema: target });
    }
    expect(await listSandboxes(url())).not.toContain(target);
  });

  it('refuses any schema that is not a sandbox', async () => {
    await expect(dropSandbox({ connectionString: url(), schema: 'public' })).rejects.toThrow(
      /sandbox/,
    );
    await expect(
      createSandbox({ connectionString: url(), source: testDb.schema, target: 'public' }),
    ).rejects.toThrow(/sandbox/);
  });
});
