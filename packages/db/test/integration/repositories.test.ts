import { describe, expect, it } from 'vitest';

import { StoredRowInvalidError } from '../../src/repositories.js';
import { newDocument, SHA_B, seedField } from '../support/fixtures.js';
import { withTestDb } from '../support/test-db.js';

const testDb = withTestDb();

describe('repository round trips', () => {
  it('returns the same document it stored, and stores bytes and pages apart from it', async () => {
    const repos = testDb.database;
    const inserted = await repos.documents.insert(newDocument({ sha256: SHA_B, revision: null }));
    await repos.documents.putBlob(inserted.id, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await repos.documents.insertPages(inserted.id, [
      { pageNumber: 2, content: 'Head: 45 m' },
      { pageNumber: 1, content: 'Rated flow: 500 gpm' },
    ]);

    expect(await repos.documents.getById(inserted.id)).toEqual(inserted);
    expect(inserted).toMatchObject({
      sha256: SHA_B,
      originalFilename: 'P-101 datasheet.pdf',
      byteSize: 2048,
      pageCount: 2,
      documentType: 'datasheet',
      revision: null,
    });
    expect(await repos.documents.getBlob(inserted.id)).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(await repos.documents.listPages(inserted.id)).toEqual([
      { documentId: inserted.id, pageNumber: 1, content: 'Rated flow: 500 gpm' },
      { documentId: inserted.id, pageNumber: 2, content: 'Head: 45 m' },
    ]);
  });

  it('returns the same equipment, run, field, conflict and event it stored', async () => {
    const repos = testDb.database;
    const { equipment, run, field } = await seedField(repos);

    expect(await repos.equipment.getByTag(equipment.tag)).toEqual(equipment);
    expect(await repos.extractionRuns.getById(run.id)).toEqual(run);
    expect(await repos.fields.getById(field.id)).toEqual(field);
    expect(field).toMatchObject({
      verificationStatus: 'verified',
      verificationReasons: [],
      reviewStatus: 'pending',
      version: 1,
    });

    const unverified = await repos.fields.insert({
      extractionRunId: run.id,
      equipmentId: equipment.id,
      name: 'rated_head',
      value: '45',
      unit: 'm',
      quote: 'Head: 45 m',
      page: 99,
      verificationStatus: 'unverified',
      verificationReasons: ['QUOTE_NOT_FOUND', 'OUT_OF_RANGE'],
    });
    expect(await repos.fields.getById(unverified.id)).toEqual(unverified);
    expect(unverified.verificationReasons).toEqual(['QUOTE_NOT_FOUND', 'OUT_OF_RANGE']);

    const conflict = await repos.conflicts.insert({
      equipmentId: equipment.id,
      fieldName: 'rated_head',
    });
    expect(await repos.conflicts.getById(conflict.id)).toEqual(conflict);
    expect(conflict).toMatchObject({ status: 'open', resolution: null, resolvedAt: null });

    const event = await repos.reviewEvents.append({
      subject: { kind: 'conflict', conflictId: conflict.id },
      actor: 'engineer',
      action: 'resolve',
      before: null,
      after: { value: '45', unit: 'm' },
      reason: 'Rev B supersedes Rev A',
    });
    expect(
      await repos.reviewEvents.listForSubject({ kind: 'conflict', conflictId: conflict.id }),
    ).toEqual([event]);
    expect(event.subject).toEqual({ kind: 'conflict', conflictId: conflict.id });
  });

  it('returns null for rows that do not exist', async () => {
    const missing = '00000000-0000-4000-8000-00000000beef';
    expect(await testDb.database.documents.getById(missing)).toBeNull();
    expect(await testDb.database.fields.getById(missing)).toBeNull();
    expect(await testDb.database.documents.getBlob(missing)).toBeNull();
  });
});

describe('transactions', () => {
  it('commit every write together', async () => {
    const sha = 'e'.repeat(64);
    const id = await testDb.database.transaction(async (tx) => {
      const doc = await tx.documents.insert(newDocument({ sha256: sha }));
      await tx.documents.putBlob(doc.id, new Uint8Array([1]));
      return doc.id;
    });
    expect(await testDb.database.documents.getBlob(id)).toEqual(new Uint8Array([1]));
  });

  it('leave nothing behind when the work fails after a partial write', async () => {
    const sha = 'f'.repeat(64);
    const countBlobs = async () =>
      (await testDb.query('select count(*)::int as n from document_blobs')).rows[0];
    const blobsBefore = await countBlobs();
    await expect(
      testDb.database.transaction(async (tx) => {
        const doc = await tx.documents.insert(newDocument({ sha256: sha }));
        await tx.documents.putBlob(doc.id, new Uint8Array([1, 2, 3]));
        throw new Error('injected failure after the blob insert');
      }),
    ).rejects.toThrow('injected failure after the blob insert');

    const { rows } = await testDb.query(
      'select count(*)::int as n from documents where sha256 = $1',
      [sha],
    );
    expect(rows[0]).toEqual({ n: 0 });
    expect(await countBlobs()).toEqual(blobsBefore);
  });
});

describe('rows entering the domain are validated', () => {
  it('reports a stored row that breaks a domain rule without echoing its content', async () => {
    const { equipment, run } = await seedField(testDb.database, '9'.repeat(64));
    // An over-long value is allowed by the column but not by the domain schema.
    const secretLike = `SECRET-${'x'.repeat(100)}`;
    const { rows } = await testDb.query(
      `insert into fields (extraction_run_id, equipment_id, name, value, unit, quote, page, verification_status)
       values ($1, $2, 'rated_head', $3, 'm', 'Head', 1, 'verified') returning id`,
      [run.id, equipment.id, secretLike],
    );
    const id = String(rows[0]?.id);

    const read = testDb.database.fields.getById(id);
    await expect(read).rejects.toBeInstanceOf(StoredRowInvalidError);
    await expect(read).rejects.toThrow('stored field row failed validation at: value');
    await expect(read).rejects.not.toThrow(/SECRET/);
  });
});
