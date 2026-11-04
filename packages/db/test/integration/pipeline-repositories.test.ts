import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { newDocument } from '../support/fixtures.js';
import { withTestDb } from '../support/test-db.js';

const testDb = withTestDb({ maxConnections: 12 });
const repos = () => testDb.database;
const sha = () => randomBytes(32).toString('hex');
const tag = () => `P-${randomUUID().slice(0, 8)}`;

async function job() {
  const { job: created } = await repos().jobs.enqueue(
    {
      type: 'process_document',
      payload: {},
      idempotencyKey: randomUUID(),
      maxAttempts: 3,
      runAt: new Date(0),
      correlationId: randomUUID(),
    },
    new Date(0),
  );
  return created;
}

describe('equipment.getOrCreate', () => {
  it('creates the equipment once and then returns it unchanged', async () => {
    const t = tag();
    const first = await repos().equipment.getOrCreate({
      tag: t,
      equipmentClass: 'centrifugal_pump',
    });
    const again = await repos().equipment.getOrCreate({ tag: t, equipmentClass: 'electric_motor' });
    expect(first.created).toBe(true);
    expect(again).toEqual({ equipment: first.equipment, created: false });
    expect(again.equipment.equipmentClass).toBe('centrifugal_pump');
  });

  it('stores one row when the same tag is created concurrently', async () => {
    const t = tag();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repos().equipment.getOrCreate({ tag: t, equipmentClass: 'centrifugal_pump' }),
      ),
    );
    expect(new Set(results.map((r) => r.equipment.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });
});

describe('equipment.lockForUpdate', () => {
  it('makes a second transaction wait until the first commits', async () => {
    const { equipment } = await repos().equipment.getOrCreate({
      tag: tag(),
      equipmentClass: 'centrifugal_pump',
    });
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const first = repos().transaction(async (tx) => {
      await tx.equipment.lockForUpdate(equipment.id);
      order.push('first locked');
      firstLocked();
      await firstHolds;
      order.push('first commits');
    });
    await locked;
    const second = repos().transaction(async (tx) => {
      await tx.equipment.lockForUpdate(equipment.id);
      order.push('second locked');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    order.push('released');
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first locked', 'released', 'first commits', 'second locked']);
  });
});

describe('extractionRuns.insertForJob', () => {
  it('writes one run per job and returns it on a repeat', async () => {
    const document = await repos().documents.insert(newDocument({ sha256: sha() }));
    const { id: jobId } = await job();
    const input = {
      jobId,
      documentId: document.id,
      model: 'replay',
      promptVersion: 'v1',
      tokens: 10,
      latencyMs: 5,
    };
    const first = await repos().extractionRuns.insertForJob(input);
    const again = await repos().extractionRuns.insertForJob({ ...input, model: 'other' });
    expect(first.created).toBe(true);
    expect(first.run).toMatchObject({ jobId, documentId: document.id, model: 'replay' });
    expect(again).toEqual({ run: first.run, created: false });
  });
});

describe('conflicts.openIfAbsent', () => {
  it('keeps one open conflict per field, and opens a new one after resolution', async () => {
    const { equipment } = await repos().equipment.getOrCreate({
      tag: tag(),
      equipmentClass: 'centrifugal_pump',
    });
    const input = { equipmentId: equipment.id, fieldName: 'rated_head' };
    const first = await repos().conflicts.openIfAbsent(input);
    const again = await repos().conflicts.openIfAbsent(input);
    expect(first.created).toBe(true);
    expect(again).toEqual({ conflict: first.conflict, created: false });
    expect(await repos().conflicts.listOpen(equipment.id)).toEqual([first.conflict]);

    await testDb.query(
      `update conflicts set status = 'resolved', resolution = 'datasheet value', resolved_at = now(),
         resolved_by = 'role:engineer', decided_value = '45', decided_unit = 'm', based_on = '[]'
       where id = $1`,
      [first.conflict.id],
    );
    const reopened = await repos().conflicts.openIfAbsent(input);
    expect(reopened.created).toBe(true);
    expect(reopened.conflict.id).not.toBe(first.conflict.id);
    expect(await repos().conflicts.listOpen(equipment.id)).toEqual([reopened.conflict]);
  });
});

describe('fields.listLatestForEquipment', () => {
  it('reads only the latest run of each document of the equipment, with document metadata', async () => {
    const { equipment } = await repos().equipment.getOrCreate({
      tag: tag(),
      equipmentClass: 'centrifugal_pump',
    });
    const { equipment: other } = await repos().equipment.getOrCreate({
      tag: tag(),
      equipmentClass: 'centrifugal_pump',
    });
    const docA = await repos().documents.insert(
      newDocument({ sha256: sha(), documentType: 'datasheet', revision: 'Rev B' }),
    );
    const docB = await repos().documents.insert(
      newDocument({ sha256: sha(), documentType: 'brochure', revision: null }),
    );
    const field = (runId: string, equipmentId: string, value: string) =>
      repos().fields.insert({
        extractionRunId: runId,
        equipmentId,
        name: 'rated_head',
        value,
        unit: 'm',
        quote: `Rated head: ${value} m`,
        page: 1,
        verificationStatus: 'verified',
        verificationReasons: [],
      });
    const run = (documentId: string) =>
      repos().extractionRuns.insert({
        documentId,
        model: 'replay',
        promptVersion: 'v1',
        tokens: null,
        latencyMs: null,
      });

    const oldA = await run(docA.id);
    await field(oldA.id, equipment.id, '40');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newA = await run(docA.id);
    const latestA = await field(newA.id, equipment.id, '45');
    const runB = await run(docB.id);
    const latestB = await field(runB.id, equipment.id, '44');
    await field(runB.id, other.id, '99');

    const rows = await repos().fields.listLatestForEquipment(equipment.id);
    const expected = [
      {
        fieldId: latestA.id,
        name: 'rated_head',
        value: '45',
        unit: 'm',
        quote: 'Rated head: 45 m',
        page: 1,
        verificationStatus: 'verified',
        reviewStatus: 'pending',
        documentId: docA.id,
        documentType: 'datasheet',
        revision: 'Rev B',
      },
      {
        fieldId: latestB.id,
        name: 'rated_head',
        value: '44',
        unit: 'm',
        quote: 'Rated head: 44 m',
        page: 1,
        verificationStatus: 'verified',
        reviewStatus: 'pending',
        documentId: docB.id,
        documentType: 'brochure',
        revision: null,
      },
    ].sort((x, y) => (x.fieldId < y.fieldId ? -1 : 1));
    expect(rows).toEqual(expected);
  });
});
