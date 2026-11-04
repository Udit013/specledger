import { FIELD_DEFINITIONS, normalizeValue } from '@specledger/core';
import type {
  ConflictRecord,
  EquipmentClass,
  FieldDefinition,
  HumanDecision,
} from '@specledger/core';

import { ApiError } from '../http/errors.js';

// The lineage of a stored field for reconciliation: one series of revisions is the documents of
// one type for one tag.
export const lineageOf = (tag: string, documentType: string) => `${tag}:${documentType}`;

export const definitionsFor = (equipmentClass: EquipmentClass) =>
  new Map(FIELD_DEFINITIONS[equipmentClass].map((field) => [field.name, field]));

export const definitionOf = (equipmentClass: EquipmentClass, name: string) =>
  FIELD_DEFINITIONS[equipmentClass].find((field) => field.name === name);

// A reviewer's value the field cannot read: not a number, or a unit of another quantity.
export const invalidValue = () =>
  new ApiError(
    400,
    'INVALID_VALUE',
    'The value must be a number with a unit of the field’s quantity.',
  );

// Resolved conflicts as Phase 6 human decisions: the decided value normalized for its field, the
// chosen candidate if any, and the evidence the reviewer saw. A decision whose value no longer
// normalizes (a field definition changed) is skipped, so reconciliation treats the field as
// undecided rather than trusting a value it cannot read.
export function decisionsFrom(
  resolved: readonly ConflictRecord[],
  definitions: ReadonlyMap<string, FieldDefinition>,
): HumanDecision[] {
  return resolved.flatMap((conflict) => {
    const { decidedValue, decidedUnit, basedOn } = conflict;
    if (conflict.status !== 'resolved' || decidedValue === null || decidedUnit === null) return [];
    if (basedOn === null) return [];
    const definition = definitions.get(conflict.fieldName);
    if (definition === undefined) return [];
    const value = normalizeValue(decidedValue, decidedUnit, definition);
    if (value === null) return [];
    return [{ fieldName: conflict.fieldName, value, candidateId: conflict.chosenFieldId, basedOn }];
  });
}
