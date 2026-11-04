import { reconcile } from '@specledger/core';
import type {
  ConflictSuggestion,
  ConflictView,
  DecisionBasis,
  EquipmentClass,
  ResolveConflictBody,
} from '@specledger/core';
import type { ConflictWithTag, Database, ReconcileSourceRow, Repositories } from '@specledger/db';

import { ApiError, notFound } from '../http/errors.js';
import { reconcileCandidates, verifiedByVerifier } from './candidates.js';
import {
  acceptableValue,
  definitionOf,
  definitionsFor,
  invalidValue,
  lineageOf,
} from './decisions.js';

// The latest field of each document of the equipment for the conflict's field, by field id.
async function candidatesOf(
  repos: Pick<Repositories, 'fields'>,
  conflict: ConflictWithTag,
): Promise<ReconcileSourceRow[]> {
  const rows = await repos.fields.listLatestForEquipment(conflict.equipmentId);
  return rows.filter((row) => row.name === conflict.fieldName);
}

// What the rules alone would do with these candidates, with no human decision: the field they
// select, if any, and the rules they applied in order.
function suggestionFor(
  conflict: ConflictWithTag,
  candidates: readonly ReconcileSourceRow[],
  equipmentClass: EquipmentClass | undefined,
): ConflictSuggestion {
  if (equipmentClass === undefined) return { fieldId: null, rules: [] };
  const reconciled = reconcile({
    candidates: reconcileCandidates(
      candidates,
      conflict.equipmentTag,
      definitionsFor(equipmentClass),
      verifiedByVerifier,
    ),
    decisions: [],
  });
  if (!reconciled.ok) return { fieldId: null, rules: [] };
  const outcome = reconciled.value.fields.find((field) => field.fieldName === conflict.fieldName);
  const rules = [
    ...new Set(
      reconciled.value.log
        .filter((entry) => entry.fieldName === conflict.fieldName)
        .map((entry) => entry.rule),
    ),
  ];
  return { fieldId: outcome?.status === 'selected' ? outcome.selectedCandidateId : null, rules };
}

// A conflict with the latest field of each document of its equipment for the field, their
// evidence, and the rules' suggestion.
export async function conflictView(
  database: Database,
  conflict: ConflictWithTag,
): Promise<ConflictView> {
  const candidates = await candidatesOf(database, conflict);
  const equipment = await database.equipment.getById(conflict.equipmentId);
  const { resolvedAt, resolvedBy, resolution, decidedValue, decidedUnit } = conflict;
  return {
    id: conflict.id,
    equipmentTag: conflict.equipmentTag,
    fieldName: conflict.fieldName,
    status: conflict.status,
    createdAt: conflict.createdAt.toISOString(),
    candidates: candidates.map((row) => ({
      fieldId: row.fieldId,
      documentId: row.documentId,
      documentType: row.documentType,
      revision: row.revision,
      value: row.value,
      unit: row.unit,
      quote: row.quote,
      page: row.page,
      verificationStatus: row.verificationStatus,
      reviewStatus: row.reviewStatus,
    })),
    suggestion: suggestionFor(conflict, candidates, equipment?.equipmentClass),
    resolution:
      conflict.status === 'resolved' &&
      resolvedAt !== null &&
      resolvedBy !== null &&
      resolution !== null &&
      decidedValue !== null &&
      decidedUnit !== null
        ? {
            reason: resolution,
            resolvedAt: resolvedAt.toISOString(),
            resolvedBy,
            chosenFieldId: conflict.chosenFieldId,
            value: decidedValue,
            unit: decidedUnit,
          }
        : null,
  };
}

export interface ResolveInput {
  readonly conflictId: string;
  readonly body: ResolveConflictBody;
  readonly actor: string;
  readonly now: Date;
}

const alreadyResolved = () =>
  new ApiError(409, 'CONFLICT_ALREADY_RESOLVED', 'The conflict is already resolved.');

// Resolves an open conflict with a structured decision, in one transaction with its audit event:
// either one of its candidates (a field of the equipment for that field) or an entered value and
// unit that read as the field's quantity, with a reason. The decision records the candidates the
// reviewer saw, with their lineages and revisions, so reconciliation can tell when a later
// revision calls for another look. 404 for an unknown conflict, 409 CONFLICT_ALREADY_RESOLVED
// once resolved, 400 CANDIDATE_NOT_IN_CONFLICT or INVALID_VALUE for a bad choice.
export function resolveConflict(database: Database, input: ResolveInput): Promise<ConflictWithTag> {
  const { choice, reason } = input.body;
  return database.transaction(async (tx) => {
    const conflict = await tx.conflicts.getWithTag(input.conflictId);
    if (conflict === null) throw notFound('conflict');
    if (conflict.status !== 'open') throw alreadyResolved();
    // The worker writes an equipment's fields under this lock: the candidates read here are every
    // committed one, and no document can land between reading them and recording the decision.
    await tx.equipment.lockForUpdate(conflict.equipmentId);
    const equipment = await tx.equipment.getById(conflict.equipmentId);
    const definition =
      equipment === null ? undefined : definitionOf(equipment.equipmentClass, conflict.fieldName);
    const candidates = await candidatesOf(tx, conflict);

    let decided: { value: string; unit: string; chosenFieldId: string | null };
    if (choice.kind === 'candidate') {
      const chosen = candidates.find((row) => row.fieldId === choice.fieldId);
      if (chosen === undefined) {
        throw new ApiError(
          400,
          'CANDIDATE_NOT_IN_CONFLICT',
          'The chosen field is not a candidate of this conflict.',
        );
      }
      decided = { value: chosen.value, unit: chosen.unit, chosenFieldId: chosen.fieldId };
    } else {
      decided = { value: choice.value, unit: choice.unit, chosenFieldId: null };
    }
    // A decision reconciliation cannot read would be skipped there, and an implausible one is almost
    // certainly a typo: refuse both here instead.
    if (definition === undefined || !acceptableValue(decided.value, decided.unit, definition)) {
      throw invalidValue();
    }

    const basedOn: DecisionBasis[] = candidates.map((row) => ({
      candidateId: row.fieldId,
      lineage: lineageOf(conflict.equipmentTag, row.documentType),
      revision: row.revision,
    }));
    const resolved = await tx.conflicts.resolve({
      id: conflict.id,
      resolvedBy: input.actor,
      reason,
      resolvedAt: input.now,
      chosenFieldId: decided.chosenFieldId,
      decidedValue: decided.value,
      decidedUnit: decided.unit,
      basedOn,
    });
    // Another request resolved it between the read and the update.
    if (resolved === null) throw alreadyResolved();
    await tx.reviewEvents.append({
      subject: { kind: 'conflict', conflictId: conflict.id },
      actor: input.actor,
      action: 'resolve',
      before: { status: 'open' },
      after: {
        status: 'resolved',
        chosenFieldId: decided.chosenFieldId,
        value: decided.value,
        unit: decided.unit,
        basedOn,
      },
      reason,
    });
    return { ...resolved, equipmentTag: conflict.equipmentTag };
  });
}
