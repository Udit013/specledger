import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { seedField } from '../support/fixtures.js';
import { withTestDb } from '../support/test-db.js';

const testDb = withTestDb({ maxConnections: 24 });
const repos = () => testDb.database;
const seed = () => seedField(repos(), randomBytes(32).toString('hex'));

describe('fields.review (optimistic concurrency)', () => {
  it('updates the field and bumps its version when the expected version matches', async () => {
    const { field } = await seed();
    const outcome = await repos().fields.review({
      id: field.id,
      expectedVersion: 1,
      reviewStatus: 'edited',
      value: '46',
      unit: 'm',
    });
    expect(outcome).toMatchObject({
      kind: 'updated',
      field: { id: field.id, reviewStatus: 'edited', value: '46', unit: 'm', version: 2 },
    });
  });

  it('returns the current state, changing nothing, for a stale version', async () => {
    const { field } = await seed();
    await repos().fields.review({ id: field.id, expectedVersion: 1, reviewStatus: 'accepted' });
    const stale = await repos().fields.review({
      id: field.id,
      expectedVersion: 1,
      reviewStatus: 'rejected',
    });
    expect(stale).toMatchObject({
      kind: 'stale',
      current: { reviewStatus: 'accepted', version: 2 },
    });
  });

  it('lets exactly one of two concurrent reviews of one version win', async () => {
    const { field } = await seed();
    const outcomes = await Promise.all(
      (['accepted', 'rejected'] as const).map((reviewStatus) =>
        repos().fields.review({ id: field.id, expectedVersion: 1, reviewStatus }),
      ),
    );
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['stale', 'updated']);
  });

  it('reports a missing field', async () => {
    expect(
      await repos().fields.review({
        id: '00000000-0000-4000-8000-00000000beef',
        expectedVersion: 1,
        reviewStatus: 'accepted',
      }),
    ).toEqual({ kind: 'missing' });
  });
});

describe('register.takeNextNumber', () => {
  it('hands out consecutive numbers to concurrent transactions, with no gap or duplicate', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () => repos().transaction((tx) => tx.register.takeNextNumber())),
    );
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(12);
    expect(sorted).toEqual(Array.from({ length: 12 }, (_, i) => (sorted[0] ?? 0) + i));
  });

  it('gives a number back when its transaction rolls back', async () => {
    const before = await repos().transaction((tx) => tx.register.takeNextNumber());
    await expect(
      repos().transaction(async (tx) => {
        await tx.register.takeNextNumber();
        throw new Error('publish failed');
      }),
    ).rejects.toThrow('publish failed');
    expect(await repos().transaction((tx) => tx.register.takeNextNumber())).toBe(before + 1);
  });
});

describe('conflicts.resolve', () => {
  it('records the decision once, and refuses to resolve a resolved conflict', async () => {
    const { equipment } = await seed();
    const { conflict } = await repos().conflicts.openIfAbsent({
      equipmentId: equipment.id,
      fieldName: 'rated_head',
    });
    const input = {
      id: conflict.id,
      resolvedBy: 'role:engineer',
      reason: 'datasheet is authoritative',
      resolvedAt: new Date('2030-01-01T00:00:00Z'),
      chosenFieldId: null,
      decidedValue: '45',
      decidedUnit: 'm',
      basedOn: [],
    };
    expect(await repos().conflicts.resolve(input)).toMatchObject({
      status: 'resolved',
      resolution: 'datasheet is authoritative',
      resolvedBy: 'role:engineer',
      decidedValue: '45',
      basedOn: [],
    });
    expect(await repos().conflicts.resolve({ ...input, decidedValue: '99' })).toBeNull();
    expect(await repos().conflicts.listDecisions(equipment.id)).toMatchObject([
      { id: conflict.id, decidedValue: '45' },
    ]);
  });
});
