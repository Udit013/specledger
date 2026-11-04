import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { newDocument } from '../support/fixtures.js';
import { pgFailure, withTestDb } from '../support/test-db.js';

const testDb = withTestDb();
const freshSha = () => randomBytes(32).toString('hex');

describe('documents.insertIfAbsent', () => {
  it('creates a document once, then returns the stored one unchanged', async () => {
    const sha256 = freshSha();
    const first = await testDb.database.documents.insertIfAbsent(newDocument({ sha256 }));
    const second = await testDb.database.documents.insertIfAbsent(
      newDocument({ sha256, originalFilename: 'other name.pdf', revision: 'Rev B' }),
    );
    expect(first.created).toBe(true);
    expect(second).toEqual({ document: first.document, created: false });
  });

  it('stores exactly one row when 20 transactions insert the same hash at once', async () => {
    const sha256 = freshSha();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        testDb.database.transaction(async (tx) => {
          const stored = await tx.documents.insertIfAbsent(
            newDocument({ sha256, originalFilename: `upload-${String(index)}.pdf` }),
          );
          if (stored.created) await tx.documents.putBlob(stored.document.id, new Uint8Array([1]));
          return stored;
        }),
      ),
    );
    const ids = new Set(results.map((result) => result.document.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const rows = await testDb.query('select id from documents where sha256 = $1', [sha256]);
    expect(rows.rows).toEqual([{ id: [...ids][0] }]);
  });

  it('still refuses rows that break other constraints', async () => {
    expect(
      await pgFailure(
        testDb.database.documents.insertIfAbsent(
          newDocument({ sha256: freshSha(), originalFilename: '' }),
        ),
      ),
    ).toEqual({ code: '23514', constraint: 'documents_original_filename_length' });
  });

  it('rolls back the document and its blob when a later write in the transaction fails', async () => {
    const sha256 = freshSha();
    const failure = await pgFailure(
      testDb.database.transaction(async (tx) => {
        const { document } = await tx.documents.insertIfAbsent(newDocument({ sha256 }));
        await tx.documents.putBlob(document.id, new Uint8Array([0x25, 0x50]));
        await tx.documents.insertPages(document.id, [{ pageNumber: 0, content: 'x' }]);
      }),
    );
    expect(failure).toEqual({ code: '23514', constraint: 'document_pages_page_number_positive' });
    const left = await testDb.query(
      `select (select count(*) from documents where sha256 = $1)::int as documents,
              (select count(*) from document_blobs b join documents d on d.id = b.document_id
                where d.sha256 = $1)::int as blobs`,
      [sha256],
    );
    expect(left.rows).toEqual([{ documents: 0, blobs: 0 }]);
  });
});
