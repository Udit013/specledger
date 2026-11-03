import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER } from './connection.js';

interface Journal {
  entries: { idx: number; tag: string }[];
}

const sqlFiles = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as Journal;

describe('committed migrations', () => {
  it('match the journal one to one, in order', () => {
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(sqlFiles);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(sqlFiles.map((_, i) => i));
  });

  // Unqualified names let the same migrations run into any schema (one per test file in
  // integration tests); a hard-coded "public" would silently point foreign keys elsewhere.
  it.each(sqlFiles)('%s contains no schema-qualified names', (file) => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8');
    expect(sql).not.toMatch(/"public"\.|\bpublic\./i);
  });
});
