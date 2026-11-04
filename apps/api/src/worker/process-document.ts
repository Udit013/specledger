import {
  equipmentClassSchema,
  pickFields,
  FIELD_DEFINITIONS,
  reconcile,
  TEXT_LIMITS,
  verifyCandidate,
} from '@specledger/core';
import type { FieldDefinition, VerifiedCandidate } from '@specledger/core';
import type { Database, Repositories } from '@specledger/db';
import { PROMPT_VERSION } from '@specledger/llm';
import type { ExtractionResponse, LlmLogger, LlmProvider } from '@specledger/llm';
import { z } from 'zod';

import { reconcileCandidates, verifiedByVerifier } from '../services/candidates.js';
import { decisionsFrom } from '../services/decisions.js';
import { JobError, jobErrorFromLlm } from './job-error.js';
import type { JobHandler } from './worker.js';

export const PROCESS_DOCUMENT = 'process_document';

// What an upload enqueues. The document table holds the file; the equipment it describes and
// whether it is synthetic come from the uploader.
export const processDocumentPayloadSchema = z.strictObject({
  documentId: z.uuid(),
  equipmentTag: z.string().trim().min(1).max(TEXT_LIMITS.tag),
  equipmentClass: equipmentClassSchema,
  // Only synthetic documents may go to the Gemini free tier; Replay ignores it.
  synthetic: z.boolean(),
});
export type ProcessDocumentPayload = z.infer<typeof processDocumentPayloadSchema>;

// The audit actor for everything the worker writes.
export const WORKER_ACTOR = 'system:worker';

// The database as the handler needs it: reads, and one transaction for every write.
export type PipelineStore = Pick<Database, 'documents' | 'transaction'>;

export interface ProcessDocumentDeps {
  readonly store: PipelineStore;
  readonly provider: LlmProvider;
  readonly llmTimeoutMs: number;
  readonly logger: LlmLogger;
}

const aborted = () =>
  new JobError('ABORTED', true, 'The job was cancelled before its results were written.');

const totalTokens = ({ usage }: ExtractionResponse) =>
  usage.inputTokens === null || usage.outputTokens === null
    ? null
    : usage.inputTokens + usage.outputTokens;

// process_document: load the document's pages, extract candidates with the LlmProvider, verify
// each one (core), then in one transaction lock the equipment row, write the extraction run (once
// per job), its fields and their audit events, reconcile the equipment's latest fields from every
// document (core) and open a conflict, with its audit event, for each field that is in conflict.
// A re-run of a job whose run was already written changes nothing. Failures are JobErrors:
// an invalid payload, a missing document or an equipment tag of another class are permanent; LLM
// failures are classified by jobErrorFromLlm.
export function createProcessDocumentHandler(deps: ProcessDocumentDeps): JobHandler {
  return async (job, { signal }) => {
    const parsed = processDocumentPayloadSchema.safeParse(job.payload);
    if (!parsed.success)
      throw new JobError('INVALID_PAYLOAD', false, 'The job payload is invalid.');
    const payload = parsed.data;
    const document = await deps.store.documents.getById(payload.documentId);
    if (document === null) {
      throw new JobError('DOCUMENT_NOT_FOUND', false, 'The document to process does not exist.');
    }
    const pages = await deps.store.documents.listPages(document.id);
    const fieldList = FIELD_DEFINITIONS[payload.equipmentClass];
    const definitions = new Map(fieldList.map((field) => [field.name, field]));

    // The model call is outside the transaction: a slow model never holds database locks.
    const started = performance.now();
    const extracted = await deps.provider.extract(
      {
        equipmentClass: payload.equipmentClass,
        fields: [...fieldList],
        pages: pages.map((page) => ({ pageNumber: page.pageNumber, text: page.content })),
        promptVersion: PROMPT_VERSION,
        synthetic: payload.synthetic,
      },
      { signal, timeoutMs: deps.llmTimeoutMs, requestId: job.correlationId },
    );
    const latencyMs = Math.round(performance.now() - started);
    if (!extracted.ok) throw jobErrorFromLlm(extracted.error);
    if (signal.aborted) throw aborted();

    const pageText = new Map(pages.map((page) => [page.pageNumber, page.content]));
    const verified = extracted.value.candidates.flatMap((candidate) => {
      const definition = definitions.get(candidate.fieldName);
      if (definition === undefined) return [];
      const text = pageText.get(candidate.page) ?? '';
      return [{ candidate, verdict: verifyCandidate(candidate, text, definition) }];
    });

    const outcome = await deps.store.transaction((tx) =>
      persist(tx, {
        job,
        payload,
        documentId: document.id,
        extracted: extracted.value,
        latencyMs,
        verified,
        definitions,
        signal,
      }),
    );
    deps.logger.info(
      { jobId: job.id, correlationId: job.correlationId, documentId: document.id, ...outcome },
      'process_document finished',
    );
  };
}

interface PersistInput {
  readonly job: { readonly id: string };
  readonly payload: ProcessDocumentPayload;
  readonly documentId: string;
  readonly extracted: ExtractionResponse;
  readonly latencyMs: number;
  readonly verified: readonly VerifiedCandidate[];
  readonly definitions: ReadonlyMap<string, FieldDefinition>;
  readonly signal: AbortSignal;
}

// Everything the job writes, in the caller's transaction: all of it commits, or none of it does.
async function persist(tx: Repositories, input: PersistInput) {
  const { payload } = input;
  const { equipment } = await tx.equipment.getOrCreate({
    tag: payload.equipmentTag,
    equipmentClass: payload.equipmentClass,
  });
  if (equipment.equipmentClass !== payload.equipmentClass) {
    throw new JobError(
      'EQUIPMENT_CLASS_MISMATCH',
      false,
      'The equipment tag is registered with another equipment class.',
    );
  }
  // One transaction at a time per piece of equipment, so reconciliation sees every committed
  // document of the tag and two documents processed at once cannot each miss the other.
  await tx.equipment.lockForUpdate(equipment.id);

  const { run, created } = await tx.extractionRuns.insertForJob({
    jobId: input.job.id,
    documentId: input.documentId,
    model: input.extracted.modelId,
    promptVersion: input.extracted.promptVersion,
    tokens: totalTokens(input.extracted),
    latencyMs: input.latencyMs,
  });
  // The job already committed its results on an earlier attempt: nothing more to write.
  if (!created) return { alreadyPersisted: true, fields: 0, conflictsOpened: 0 };

  const picked = pickFields(input.verified);
  for (const { candidate, verdict, dropped } of picked) {
    const field = await tx.fields.insert({
      extractionRunId: run.id,
      equipmentId: equipment.id,
      name: candidate.fieldName,
      value: candidate.value,
      unit: candidate.unit,
      quote: candidate.quote,
      page: candidate.page,
      verificationStatus: verdict.status,
      verificationReasons: verdict.reasons,
    });
    await tx.reviewEvents.append({
      subject: { kind: 'field', fieldId: field.id },
      actor: WORKER_ACTOR,
      action: 'extract',
      before: null,
      after: {
        value: candidate.value,
        unit: candidate.unit,
        page: candidate.page,
        verificationStatus: verdict.status,
        verificationReasons: verdict.reasons,
        droppedCandidates: dropped,
      },
      reason: null,
    });
  }

  const rows = await tx.fields.listLatestForEquipment(equipment.id);
  // Standing human decisions take part: a decided field stays decided, unless a later revision in
  // a lineage the decision was based on arrived, which calls for another look.
  const decisions = decisionsFrom(
    await tx.conflicts.listDecisions(equipment.id),
    input.definitions,
  );
  const reconciled = reconcile({
    candidates: reconcileCandidates(
      rows,
      payload.equipmentTag,
      input.definitions,
      verifiedByVerifier,
    ),
    decisions,
  });
  if (!reconciled.ok) {
    throw new JobError('RECONCILE_FAILED', false, 'Reconciliation rejected the stored fields.');
  }
  const toReview = [
    ...reconciled.value.conflicts.map((conflict) => ({
      fieldName: conflict.fieldName,
      candidateIds: conflict.candidateIds,
      reason: 'CONFLICT' as const,
    })),
    ...reconciled.value.fields.flatMap((field) =>
      field.status === 'needs_re_review'
        ? [
            {
              fieldName: field.fieldName,
              candidateIds: field.newCandidateIds,
              reason: 'NEEDS_RE_REVIEW' as const,
            },
          ]
        : [],
    ),
  ];
  let conflictsOpened = 0;
  for (const conflict of toReview) {
    const opened = await tx.conflicts.openIfAbsent({
      equipmentId: equipment.id,
      fieldName: conflict.fieldName,
    });
    if (!opened.created) continue;
    conflictsOpened += 1;
    await tx.reviewEvents.append({
      subject: { kind: 'conflict', conflictId: opened.conflict.id },
      actor: WORKER_ACTOR,
      action: 'extract',
      before: null,
      after: { status: 'open', candidateIds: conflict.candidateIds, reason: conflict.reason },
      reason: null,
    });
  }
  // A handler must not write after its signal fires: throwing here rolls everything back.
  if (input.signal.aborted) throw aborted();
  return { alreadyPersisted: false, fields: picked.length, conflictsOpened };
}
