import { normalizeValue, reconcile } from '@specledger/core';
import type {
  EquipmentRecord,
  FieldDefinition,
  PublishBlocker,
  ReconcileCandidate,
  RegisterItemValues,
  RegisterVersionRecord,
} from '@specledger/core';
import type { Database, ReconcileSourceRow, Repositories } from '@specledger/db';

import { ApiError } from '../http/errors.js';
import { decisionsFrom, definitionsFor, lineageOf } from './decisions.js';

export interface PublishInput {
  readonly actor: string;
  readonly now: Date;
}

export interface Published {
  readonly version: RegisterVersionRecord;
  readonly items: readonly { readonly tag: string; readonly values: RegisterItemValues }[];
}

interface Item {
  readonly equipment: EquipmentRecord;
  readonly values: RegisterItemValues;
}

// Reviewed fields as reconciliation candidates: only accepted and edited ones count, a human
// having vouched for them, and each competes if its value reads for the field. Rejected fields are
// left out; pending ones block the publish before this runs.
function reviewedCandidates(
  rows: readonly ReconcileSourceRow[],
  tag: string,
  definitions: ReadonlyMap<string, FieldDefinition>,
): ReconcileCandidate[] {
  return rows.flatMap((row) => {
    const definition = definitions.get(row.name);
    if (definition === undefined) return [];
    if (row.reviewStatus !== 'accepted' && row.reviewStatus !== 'edited') return [];
    const value = normalizeValue(row.value, row.unit, definition);
    return [
      {
        id: row.fieldId,
        fieldName: row.name,
        lineage: lineageOf(tag, row.documentType),
        sourceType: row.documentType,
        revision: row.revision,
        verification: value === null ? 'unverified' : 'verified',
        value,
      },
    ];
  });
}

// One equipment's register item: per field, the selected reviewed value as stored, or the human
// decision's value. A conflict, or a decision a later revision calls into question, is a blocker.
async function itemFor(tx: Repositories, equipment: EquipmentRecord) {
  const definitions = definitionsFor(equipment.equipmentClass);
  const rows = await tx.fields.listLatestForEquipment(equipment.id);
  const resolved = await tx.conflicts.listDecisions(equipment.id);
  const reconciled = reconcile({
    candidates: reviewedCandidates(rows, equipment.tag, definitions),
    decisions: decisionsFrom(resolved, definitions),
  });
  if (!reconciled.ok) throw new Error(`reconciliation rejected ${reconciled.error.code}`);
  const byId = new Map(rows.map((row) => [row.fieldId, row]));
  const byField = new Map(resolved.map((conflict) => [conflict.fieldName, conflict]));
  const values: RegisterItemValues = {};
  const blockers: PublishBlocker[] = [];
  for (const outcome of reconciled.value.fields) {
    if (outcome.status === 'selected') {
      const row = byId.get(outcome.selectedCandidateId);
      if (row !== undefined) values[outcome.fieldName] = { value: row.value, unit: row.unit };
    } else if (outcome.status === 'decided') {
      const decision = byField.get(outcome.fieldName);
      if (decision?.decidedValue != null && decision.decidedUnit != null) {
        values[outcome.fieldName] = { value: decision.decidedValue, unit: decision.decidedUnit };
      }
    } else if (outcome.status === 'conflict' || outcome.status === 'needs_re_review') {
      blockers.push({
        kind: 'UNRESOLVED_DISAGREEMENT',
        subjectId: equipment.id,
        equipmentTag: equipment.tag,
        fieldName: outcome.fieldName,
      });
    }
  }
  return { item: { equipment, values } satisfies Item, blockers };
}

const blocked = (blockers: readonly PublishBlocker[]) =>
  new ApiError(409, 'PUBLISH_BLOCKED', 'The register cannot be published yet.', { blockers });

// Publishes the next register version in one transaction: lock the counter row, collect the
// blockers (a document still processing, a field pending review, an open conflict, accepted values
// of equal rank that disagree with no decision) and refuse with 409 PUBLISH_BLOCKED and the list
// if there are any, creating nothing; otherwise create the version with one item per equipment
// holding its reconciled accepted values (decisions included, rejected fields left out) and
// publish it. 409 NOTHING_TO_PUBLISH when no equipment has an accepted value.
export function publishRegister(database: Database, input: PublishInput): Promise<Published> {
  return database.transaction(async (tx) => {
    // First, so publishes run one at a time: the number is taken under the counter's row lock
    // and given back if this transaction rolls back.
    const number = await tx.register.takeNextNumber();
    const stored = await tx.register.blockers();
    const blockers: PublishBlocker[] = [
      ...stored.jobsInProgress.map((job) => ({
        kind: 'JOB_IN_PROGRESS' as const,
        subjectId: job.jobId,
        equipmentTag: null,
        fieldName: null,
      })),
      ...stored.pendingFields.map((field) => ({
        kind: 'FIELD_PENDING_REVIEW' as const,
        subjectId: field.fieldId,
        equipmentTag: field.equipmentTag,
        fieldName: field.fieldName,
      })),
      ...stored.openConflicts.map((conflict) => ({
        kind: 'CONFLICT_OPEN' as const,
        subjectId: conflict.conflictId,
        equipmentTag: conflict.equipmentTag,
        fieldName: conflict.fieldName,
      })),
    ];
    const items: Item[] = [];
    for (const equipment of await tx.register.listEquipment()) {
      const { item, blockers: found } = await itemFor(tx, equipment);
      blockers.push(...found);
      if (Object.keys(item.values).length > 0) items.push(item);
    }
    if (blockers.length > 0) throw blocked(blockers);
    if (items.length === 0) {
      throw new ApiError(409, 'NOTHING_TO_PUBLISH', 'No equipment has an accepted value yet.');
    }

    const draft = await tx.register.createDraftVersion(number);
    for (const { equipment, values } of items) {
      await tx.register.addItem({
        registerVersionId: draft.id,
        equipmentId: equipment.id,
        tag: equipment.tag,
        values,
      });
    }
    const version = await tx.register.publishVersion(draft.id, input.actor, input.now);
    if (version === null) throw new Error('the new register version was published already');
    await tx.reviewEvents.append({
      subject: { kind: 'register_version', registerVersionId: version.id },
      actor: input.actor,
      action: 'publish',
      before: null,
      after: { number, itemCount: items.length },
      reason: null,
    });
    return {
      version,
      items: items.map(({ equipment, values }) => ({ tag: equipment.tag, values })),
    };
  });
}

export type { PublishBlocker };
