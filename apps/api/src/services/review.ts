import { supersedes } from '@specledger/core';
import type { FieldRecord, ReviewFieldBody, ReviewStatus } from '@specledger/core';
import type { Database, ReconcileSourceRow, Repositories } from '@specledger/db';

import { ApiError, notFound } from '../http/errors.js';
import { fieldView } from '../http/views.js';
import { acceptableValue, definitionOf, invalidValue, lineageOf } from './decisions.js';

export interface ReviewInput {
  readonly fieldId: string;
  readonly body: ReviewFieldBody;
  readonly actor: string;
}

const STATUS_FOR: Readonly<Record<ReviewFieldBody['action'], ReviewStatus>> = {
  accept: 'accepted',
  reject: 'rejected',
  edit: 'edited',
};

const stale = (current: FieldRecord) =>
  new ApiError(409, 'VERSION_CONFLICT', 'The field changed since it was read.', {
    current: fieldView(current),
  });

const audited = (field: FieldRecord) => ({
  reviewStatus: field.reviewStatus,
  value: field.value,
  unit: field.unit,
  version: field.version,
});

// Rejecting the value of the document that takes precedence for a field (a later revision, or a
// higher-ranked source) would let publishing fall back to a value it supersedes: the rejection says
// the extraction is wrong, not that the document has no value, and the newer document may state
// something else. When some remaining candidate is superseded by the rejected one and no human
// decision covers the field, a conflict is opened, so publishing waits for a person to choose.
// Runs under the equipment lock, as the worker and resolution do, so it sees every committed field.
async function guardRejectedPrecedence(
  tx: Repositories,
  field: FieldRecord,
  actor: string,
  reason: string | null,
): Promise<void> {
  await tx.equipment.lockForUpdate(field.equipmentId);
  const equipment = await tx.equipment.getById(field.equipmentId);
  if (equipment === null) return;
  const rows = (await tx.fields.listLatestForEquipment(field.equipmentId)).filter(
    (row) => row.name === field.name,
  );
  const rejected = rows.find((row) => row.fieldId === field.id);
  // A field of an older extraction run of its document no longer competes.
  if (rejected === undefined) return;
  const keyOf = (row: ReconcileSourceRow) => ({
    lineage: lineageOf(equipment.tag, row.documentType),
    sourceType: row.documentType,
    revision: row.revision,
  });
  const superseded = rows.filter(
    (row) =>
      row.fieldId !== field.id &&
      row.reviewStatus !== 'rejected' &&
      supersedes(keyOf(rejected), keyOf(row)),
  );
  if (superseded.length === 0) return;
  const decided = await tx.conflicts.listDecisions(field.equipmentId);
  if (decided.some((decision) => decision.fieldName === field.name)) return;
  const opened = await tx.conflicts.openIfAbsent({
    equipmentId: field.equipmentId,
    fieldName: field.name,
  });
  if (!opened.created) return;
  await tx.reviewEvents.append({
    subject: { kind: 'conflict', conflictId: opened.conflict.id },
    actor,
    action: 'reject',
    before: null,
    after: {
      status: 'open',
      reason: 'PRECEDENCE_REJECTED',
      rejectedFieldId: field.id,
      supersededFieldIds: superseded.map((row) => row.fieldId),
    },
    reason,
  });
}

// Applies a review action with optimistic concurrency, writing the field and its audit event in one
// transaction. accept and reject keep the value; edit replaces it, and the new value must be
// readable for the field (a number and a unit of the field's quantity). Accepting an unverified
// value requires a reason. A stale expectedVersion is a 409 VERSION_CONFLICT carrying the current
// field; an unknown field is a 404. A rejection that would let a superseded value through opens a
// conflict (guardRejectedPrecedence).
export function reviewField(database: Database, input: ReviewInput): Promise<FieldRecord> {
  const { body } = input;
  return database.transaction(async (tx) => {
    const field = await tx.fields.getById(input.fieldId);
    if (field === null) throw notFound('field');
    if (body.action === 'accept' && field.verificationStatus !== 'verified' && !body.reason) {
      throw new ApiError(
        400,
        'REASON_REQUIRED',
        'Accepting a value the verifier could not confirm requires a reason.',
      );
    }
    if (body.action === 'edit') {
      const equipment = await tx.equipment.getById(field.equipmentId);
      const definition =
        equipment === null ? undefined : definitionOf(equipment.equipmentClass, field.name);
      if (definition === undefined || !acceptableValue(body.value, body.unit, definition)) {
        throw invalidValue();
      }
    }
    if (field.version !== body.expectedVersion) throw stale(field);

    // The version condition is the concurrency control: of two reviews of one version, the
    // second matches no row and gets the winner's state back.
    const outcome = await tx.fields.review({
      id: field.id,
      expectedVersion: body.expectedVersion,
      reviewStatus: STATUS_FOR[body.action],
      ...(body.action === 'edit' ? { value: body.value, unit: body.unit } : {}),
    });
    if (outcome.kind === 'missing') throw notFound('field');
    if (outcome.kind === 'stale') throw stale(outcome.current);
    await tx.reviewEvents.append({
      subject: { kind: 'field', fieldId: field.id },
      actor: input.actor,
      action: body.action,
      before: audited(field),
      after: audited(outcome.field),
      reason: body.reason ?? null,
    });
    if (body.action === 'reject') {
      await guardRejectedPrecedence(tx, outcome.field, input.actor, body.reason ?? null);
    }
    return outcome.field;
  });
}
