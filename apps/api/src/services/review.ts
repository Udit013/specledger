import { normalizeValue } from '@specledger/core';
import type { FieldRecord, ReviewFieldBody, ReviewStatus } from '@specledger/core';
import type { Database } from '@specledger/db';

import { ApiError, notFound } from '../http/errors.js';
import { fieldView } from '../http/views.js';
import { definitionOf, invalidValue } from './decisions.js';

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

// Applies a review action with optimistic concurrency, writing the field and its audit event in one
// transaction. accept and reject keep the value; edit replaces it, and the new value must be
// readable for the field (a number and a unit of the field's quantity). Accepting an unverified
// value requires a reason. A stale expectedVersion is a 409 VERSION_CONFLICT carrying the current
// field; an unknown field is a 404.
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
      if (definition === undefined || normalizeValue(body.value, body.unit, definition) === null) {
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
    return outcome.field;
  });
}
