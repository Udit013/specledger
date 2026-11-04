import { beforeAll, describe, expect, it } from 'vitest';

import { MISSING_ID, SHA_A, seedField } from '../support/fixtures.js';
import type { Seeded } from '../support/fixtures.js';
import { pgFailure, withTestDb } from '../support/test-db.js';

// Every write below must be refused by Postgres itself. Each test asserts the SQLSTATE and the
// name of the constraint that refused it, so a test cannot pass because of some unrelated error.
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const CHECK = '23514';
const NOT_NULL = '23502';

const testDb = withTestDb();
let seeded: Seeded;

beforeAll(async () => {
  seeded = await seedField(testDb.database);
});

const insertField = (overrides: Record<string, unknown> = {}) => {
  const row = {
    extraction_run_id: seeded.run.id,
    equipment_id: seeded.equipment.id,
    name: 'rated_head',
    value: '45',
    unit: 'm',
    quote: 'Head 45 m',
    page: 1,
    verification_status: 'verified',
    verification_reasons: [] as string[],
    ...overrides,
  };
  const columns = Object.keys(row);
  return testDb.query(
    `insert into fields (${columns.join(', ')}) values (${columns.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
    Object.values(row),
  );
};

const insertDocument = (overrides: Record<string, unknown> = {}) => {
  const row = {
    sha256: 'c'.repeat(64),
    original_filename: 'x.pdf',
    byte_size: 10,
    page_count: 1,
    document_type: 'datasheet',
    ...overrides,
  };
  const columns = Object.keys(row);
  return testDb.query(
    `insert into documents (${columns.join(', ')}) values (${columns.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
    Object.values(row),
  );
};

describe('documents', () => {
  it('refuses a duplicate sha256', async () => {
    expect(await pgFailure(insertDocument({ sha256: SHA_A }))).toEqual({
      code: UNIQUE,
      constraint: 'documents_sha256_key',
    });
  });

  it('refuses a sha256 that is not 64 lower-case hex characters', async () => {
    expect(await pgFailure(insertDocument({ sha256: 'ABC' }))).toEqual({
      code: CHECK,
      constraint: 'documents_sha256_format',
    });
  });

  it('refuses an unknown document type', async () => {
    expect(await pgFailure(insertDocument({ document_type: 'flyer' }))).toEqual({
      code: CHECK,
      constraint: 'documents_document_type_valid',
    });
  });

  it('refuses a zero page count', async () => {
    expect(await pgFailure(insertDocument({ page_count: 0 }))).toEqual({
      code: CHECK,
      constraint: 'documents_page_count_positive',
    });
  });

  it('refuses a missing file name', async () => {
    expect(await pgFailure(insertDocument({ original_filename: null }))).toMatchObject({
      code: NOT_NULL,
    });
  });

  it('refuses deleting a document that has pages, runs or a blob (ON DELETE RESTRICT)', async () => {
    const failure = await pgFailure(
      testDb.query('delete from documents where id = $1', [seeded.documentId]),
    );
    expect(failure).toEqual({
      code: FOREIGN_KEY,
      constraint: 'extraction_runs_document_id_documents_id_fk',
    });
  });
});

describe('document blobs and pages', () => {
  it('refuses an empty blob', async () => {
    const doc = await insertDocument({ sha256: 'd'.repeat(64) });
    expect(doc.rowCount).toBe(1);
    const { rows } = await testDb.query('select id from documents where sha256 = $1', [
      'd'.repeat(64),
    ]);
    expect(
      await pgFailure(
        testDb.query('insert into document_blobs (document_id, content) values ($1, $2)', [
          rows[0]?.id,
          Buffer.alloc(0),
        ]),
      ),
    ).toEqual({ code: CHECK, constraint: 'document_blobs_content_not_empty' });
  });

  it('refuses page number zero', async () => {
    expect(
      await pgFailure(
        testDb.query(
          'insert into document_pages (document_id, page_number, content) values ($1, 0, $2)',
          [seeded.documentId, 'text'],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'document_pages_page_number_positive' });
  });

  it('refuses the same page number twice for one document', async () => {
    const insert = () =>
      testDb.query(
        'insert into document_pages (document_id, page_number, content) values ($1, 7, $2)',
        [seeded.documentId, 'text'],
      );
    await insert();
    expect(await pgFailure(insert())).toEqual({
      code: UNIQUE,
      constraint: 'document_pages_document_page_key',
    });
  });

  it('refuses an orphan page', async () => {
    expect(
      await pgFailure(
        testDb.query(
          'insert into document_pages (document_id, page_number, content) values ($1, 1, $2)',
          [MISSING_ID, 'text'],
        ),
      ),
    ).toEqual({ code: FOREIGN_KEY, constraint: 'document_pages_document_id_documents_id_fk' });
  });
});

describe('fields', () => {
  it('refuses a second field with the same run, equipment and name', async () => {
    expect(await pgFailure(insertField({ name: 'rated_flow' }))).toEqual({
      code: UNIQUE,
      constraint: 'fields_run_equipment_name_key',
    });
  });

  it('refuses page zero', async () => {
    expect(await pgFailure(insertField({ page: 0 }))).toEqual({
      code: CHECK,
      constraint: 'fields_page_positive',
    });
  });

  it('refuses an unknown verification status', async () => {
    expect(await pgFailure(insertField({ verification_status: 'maybe' }))).toEqual({
      code: CHECK,
      constraint: 'fields_verification_status_valid',
    });
  });

  it('refuses an unknown review status', async () => {
    expect(await pgFailure(insertField({ review_status: 'approved' }))).toEqual({
      code: CHECK,
      constraint: 'fields_review_status_valid',
    });
  });

  it('refuses an unknown verification reason', async () => {
    expect(
      await pgFailure(
        insertField({ verification_status: 'unverified', verification_reasons: ['LOOKS_WRONG'] }),
      ),
    ).toEqual({ code: CHECK, constraint: 'fields_verification_reasons_valid' });
  });

  it('accepts LABEL_MISMATCH, the reason added by migration 0005', async () => {
    await insertField({
      verification_status: 'unverified',
      verification_reasons: ['LABEL_MISMATCH'],
    });
  });

  it('refuses a verified field that carries reasons', async () => {
    expect(await pgFailure(insertField({ verification_reasons: ['OUT_OF_RANGE'] }))).toEqual({
      code: CHECK,
      constraint: 'fields_verified_has_no_reasons',
    });
  });

  it('refuses an unverified field without any reason', async () => {
    expect(await pgFailure(insertField({ verification_status: 'unverified' }))).toEqual({
      code: CHECK,
      constraint: 'fields_verified_has_no_reasons',
    });
  });

  it('refuses version zero', async () => {
    expect(await pgFailure(insertField({ version: 0 }))).toEqual({
      code: CHECK,
      constraint: 'fields_version_positive',
    });
  });

  it('refuses a missing quote', async () => {
    expect(await pgFailure(insertField({ quote: null }))).toMatchObject({ code: NOT_NULL });
  });

  it('refuses an orphan extraction run', async () => {
    expect(await pgFailure(insertField({ extraction_run_id: MISSING_ID }))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'fields_extraction_run_id_extraction_runs_id_fk',
    });
  });

  it('defaults review status to pending and version to 1', async () => {
    await insertField({ name: 'npsh_required' });
    const { rows } = await testDb.query(
      "select review_status, version from fields where name = 'npsh_required'",
    );
    expect(rows).toEqual([{ review_status: 'pending', version: 1 }]);
  });
});

describe('equipment, conflicts and review events', () => {
  it('refuses a duplicate equipment tag', async () => {
    expect(
      await pgFailure(
        testDb.query("insert into equipment (tag, equipment_class) values ($1, 'electric_motor')", [
          seeded.equipment.tag,
        ]),
      ),
    ).toEqual({ code: UNIQUE, constraint: 'equipment_tag_key' });
  });

  it('refuses an unknown equipment class', async () => {
    expect(
      await pgFailure(
        testDb.query("insert into equipment (tag, equipment_class) values ('V-1', 'valve')"),
      ),
    ).toEqual({ code: CHECK, constraint: 'equipment_class_valid' });
  });

  it('refuses a resolved conflict without a resolution', async () => {
    expect(
      await pgFailure(
        testDb.query(
          "insert into conflicts (equipment_id, field_name, status) values ($1, 'rated_head', 'resolved')",
          [seeded.equipment.id],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'conflicts_resolution_matches_status' });
  });

  it('refuses a review event with no subject or with two subjects', async () => {
    expect(
      await pgFailure(
        testDb.query("insert into review_events (actor, action) values ('eng', 'accept')"),
      ),
    ).toEqual({ code: CHECK, constraint: 'review_events_exactly_one_subject' });

    const conflict = await testDb.database.conflicts.insert({
      equipmentId: seeded.equipment.id,
      fieldName: 'rated_head',
    });
    expect(
      await pgFailure(
        testDb.query(
          "insert into review_events (field_id, conflict_id, actor, action) values ($1, $2, 'eng', 'accept')",
          [seeded.field.id, conflict.id],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'review_events_exactly_one_subject' });
  });

  it('refuses an unknown review action', async () => {
    expect(
      await pgFailure(
        testDb.query(
          "insert into review_events (field_id, actor, action) values ($1, 'eng', 'approve')",
          [seeded.field.id],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'review_events_action_valid' });
  });

  it('refuses a review event for a field that does not exist', async () => {
    expect(
      await pgFailure(
        testDb.query(
          "insert into review_events (field_id, actor, action) values ($1, 'eng', 'accept')",
          [MISSING_ID],
        ),
      ),
    ).toEqual({ code: FOREIGN_KEY, constraint: 'review_events_field_id_fields_id_fk' });
  });
});

describe('register versions and items', () => {
  it('refuses a duplicate version number', async () => {
    await testDb.query('insert into register_versions (number) values (100)');
    expect(
      await pgFailure(testDb.query('insert into register_versions (number) values (100)')),
    ).toEqual({ code: UNIQUE, constraint: 'register_versions_number_key' });
  });

  it('refuses a published version without an approver', async () => {
    expect(
      await pgFailure(
        testDb.query('insert into register_versions (number, published_at) values (101, now())'),
      ),
    ).toEqual({ code: CHECK, constraint: 'register_versions_published_has_approver' });
  });

  it('refuses item values that are not a JSON object', async () => {
    const version = await testDb.database.register.createDraftVersion(102);
    expect(
      await pgFailure(
        testDb.query(
          "insert into register_items (register_version_id, equipment_id, tag, values) values ($1, $2, 'P-1', '[1,2]')",
          [version.id, seeded.equipment.id],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'register_items_values_object' });
  });
});

describe('text limits shared with the domain (TEXT_LIMITS in core)', () => {
  let conflictId: string;
  let versionId: string;

  beforeAll(async () => {
    conflictId = (
      await testDb.database.conflicts.insert({
        equipmentId: seeded.equipment.id,
        fieldName: 'rated_power',
      })
    ).id;
    versionId = (await testDb.database.register.createDraftVersion(200)).id;
  });

  it.each([
    ['a field name that is not snake_case', { name: 'Rated Flow' }, 'fields_name_format'],
    ['a field name over 64 characters', { name: `a${'b'.repeat(64)}` }, 'fields_name_format'],
    ['an empty value', { value: '' }, 'fields_value_length'],
    ['a value over 64 characters', { value: '1'.repeat(65) }, 'fields_value_length'],
    ['a unit over 32 characters', { unit: 'u'.repeat(33) }, 'fields_unit_length'],
    ['a quote over 1000 characters', { quote: 'q'.repeat(1001) }, 'fields_quote_length'],
  ])('fields: refuses %s', async (_label, override, constraint) => {
    expect(await pgFailure(insertField(override))).toEqual({ code: CHECK, constraint });
  });

  it('conflicts: refuses a malformed field name and an empty resolution', async () => {
    expect(
      await pgFailure(
        testDb.query("insert into conflicts (equipment_id, field_name) values ($1, 'Head!')", [
          seeded.equipment.id,
        ]),
      ),
    ).toEqual({ code: CHECK, constraint: 'conflicts_field_name_format' });
    expect(
      await pgFailure(
        testDb.query(
          "update conflicts set status = 'resolved', resolution = '', resolved_at = now() where id = $1",
          [conflictId],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'conflicts_resolution_not_empty' });
  });

  it('review_events: refuses an empty reason', async () => {
    expect(
      await pgFailure(
        testDb.query(
          "insert into review_events (field_id, actor, action, reason) values ($1, 'eng', 'edit', '')",
          [seeded.field.id],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'review_events_reason_not_empty' });
  });

  it('register_versions: refuses an approver name over 128 characters', async () => {
    expect(
      await pgFailure(
        testDb.query('update register_versions set approved_by = $1 where id = $2', [
          'a'.repeat(129),
          versionId,
        ]),
      ),
    ).toEqual({ code: CHECK, constraint: 'register_versions_approved_by_length' });
  });

  it('register_items: refuses a tag over 64 characters', async () => {
    expect(
      await pgFailure(
        testDb.query(
          "insert into register_items (register_version_id, equipment_id, tag, values) values ($1, $2, $3, '{}')",
          [versionId, seeded.equipment.id, 'T'.repeat(65)],
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'register_items_tag_length' });
  });
});
