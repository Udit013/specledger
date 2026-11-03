import { beforeAll, describe, expect, it } from 'vitest';

import { seedField } from '../support/fixtures.js';
import type { Seeded } from '../support/fixtures.js';
import { pgFailure, withTestDb } from '../support/test-db.js';

// SQLSTATEs raised by the triggers in migrations/0001_immutability_triggers.sql.
const APPEND_ONLY = 'SL001';
const PUBLISHED_IMMUTABLE = 'SL002';

const testDb = withTestDb();
let seeded: Seeded;

beforeAll(async () => {
  seeded = await seedField(testDb.database);
});

describe('review_events is append-only', () => {
  let eventId: string;

  beforeAll(async () => {
    const event = await testDb.database.reviewEvents.append({
      subject: { kind: 'field', fieldId: seeded.field.id },
      actor: 'engineer',
      action: 'accept',
      before: { reviewStatus: 'pending' },
      after: { reviewStatus: 'accepted' },
      reason: null,
    });
    eventId = event.id;
  });

  it('accepts new events', async () => {
    const { rows } = await testDb.query('select count(*)::int as n from review_events');
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('refuses UPDATE', async () => {
    expect(
      await pgFailure(
        testDb.query("update review_events set actor = 'someone else' where id = $1", [eventId]),
      ),
    ).toMatchObject({ code: APPEND_ONLY });
  });

  it('refuses DELETE', async () => {
    expect(
      await pgFailure(testDb.query('delete from review_events where id = $1', [eventId])),
    ).toMatchObject({ code: APPEND_ONLY });
  });

  it('refuses TRUNCATE', async () => {
    expect(await pgFailure(testDb.query('truncate review_events'))).toMatchObject({
      code: APPEND_ONLY,
    });
  });

  it('still holds the original event after the refused writes', async () => {
    const events = await testDb.database.reviewEvents.listForSubject({
      kind: 'field',
      fieldId: seeded.field.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: eventId, actor: 'engineer', action: 'accept' });
  });
});

describe('register versions are immutable once published', () => {
  const values = { rated_flow: { value: '500', unit: 'gpm' } };
  let publishedId: string;
  let draftId: string;

  beforeAll(async () => {
    const register = testDb.database.register;
    const published = await register.createDraftVersion(1);
    await register.addItem({
      registerVersionId: published.id,
      equipmentId: seeded.equipment.id,
      tag: seeded.equipment.tag,
      values,
    });
    const result = await register.publishVersion(published.id, 'approver', new Date('2026-01-01'));
    expect(result?.publishedAt).toEqual(new Date('2026-01-01'));
    publishedId = published.id;
    draftId = (await register.createDraftVersion(2)).id;
  });

  it('lets a draft change and be deleted', async () => {
    const scratch = await testDb.database.register.createDraftVersion(50);
    await testDb.query('update register_versions set number = 51 where id = $1', [scratch.id]);
    const deleted = await testDb.query('delete from register_versions where id = $1', [scratch.id]);
    expect(deleted.rowCount).toBe(1);
  });

  it('refuses UPDATE of a published version, including un-publishing it', async () => {
    expect(
      await pgFailure(
        testDb.query("update register_versions set approved_by = 'x' where id = $1", [publishedId]),
      ),
    ).toMatchObject({ code: PUBLISHED_IMMUTABLE });
    expect(
      await pgFailure(
        testDb.query('update register_versions set published_at = null where id = $1', [
          publishedId,
        ]),
      ),
    ).toMatchObject({ code: PUBLISHED_IMMUTABLE });
  });

  it('refuses DELETE of a published version', async () => {
    expect(
      await pgFailure(testDb.query('delete from register_versions where id = $1', [publishedId])),
    ).toMatchObject({ code: PUBLISHED_IMMUTABLE });
  });

  it('refuses UPDATE and DELETE of items in a published version', async () => {
    expect(
      await pgFailure(
        testDb.query("update register_items set tag = 'X-1' where register_version_id = $1", [
          publishedId,
        ]),
      ),
    ).toMatchObject({ code: PUBLISHED_IMMUTABLE });
    expect(
      await pgFailure(
        testDb.query('delete from register_items where register_version_id = $1', [publishedId]),
      ),
    ).toMatchObject({ code: PUBLISHED_IMMUTABLE });
  });

  it('refuses adding an item to a published version', async () => {
    const other = await testDb.database.equipment.insert({
      tag: 'M-201',
      equipmentClass: 'electric_motor',
    });
    expect(
      await pgFailure(
        testDb.database.register.addItem({
          registerVersionId: publishedId,
          equipmentId: other.id,
          tag: other.tag,
          values,
        }),
      ),
    ).toMatchObject({ code: PUBLISHED_IMMUTABLE });
  });

  it('refuses moving an item from a draft into a published version', async () => {
    const item = await testDb.database.register.addItem({
      registerVersionId: draftId,
      equipmentId: seeded.equipment.id,
      tag: seeded.equipment.tag,
      values,
    });
    expect(
      await pgFailure(
        testDb.query('update register_items set register_version_id = $1 where id = $2', [
          publishedId,
          item.id,
        ]),
      ),
    ).toMatchObject({ code: PUBLISHED_IMMUTABLE });
  });

  it('refuses TRUNCATE of register tables while a published version exists', async () => {
    expect(await pgFailure(testDb.query('truncate register_items'))).toMatchObject({
      code: PUBLISHED_IMMUTABLE,
    });
    expect(await pgFailure(testDb.query('truncate register_versions cascade'))).toMatchObject({
      code: PUBLISHED_IMMUTABLE,
    });
  });

  it('publishing twice is a no-op that reports nothing published', async () => {
    expect(
      await testDb.database.register.publishVersion(publishedId, 'someone', new Date()),
    ).toBeNull();
    const version = await testDb.database.register.getVersion(publishedId);
    expect(version).toMatchObject({ approvedBy: 'approver', publishedAt: new Date('2026-01-01') });
    expect(await testDb.database.register.listItems(publishedId)).toHaveLength(1);
  });
});
