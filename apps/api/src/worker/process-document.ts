import { equipmentClassSchema, TEXT_LIMITS } from '@specledger/core';
import type { Candidate, VerificationResult } from '@specledger/core';
import type { Database } from '@specledger/db';
import type { LlmLogger, LlmProvider } from '@specledger/llm';
import { z } from 'zod';

import { notImplemented } from './not-implemented.js';
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

export interface VerifiedCandidate {
  readonly candidate: Candidate;
  readonly verdict: VerificationResult;
}

export interface PickedField extends VerifiedCandidate {
  // Other candidates for the same field in this extraction, not stored as fields.
  readonly dropped: number;
}

// A run stores one field per name. Per field: the first verified candidate in the model's order,
// otherwise the first candidate; the rest are counted, not lost silently. Sorted by field name.
export function pickFields(candidates: readonly VerifiedCandidate[]): PickedField[] {
  return notImplemented('pickFields', candidates);
}

// process_document: load the document's pages, extract candidates with the LlmProvider, verify
// each one (core), then in one transaction lock the equipment row, write the extraction run (once
// per job), its fields and their audit events, reconcile the equipment's latest fields from every
// document (core) and open a conflict, with its audit event, for each field that is in conflict.
// A re-run of a job whose run was already written changes nothing. Failures are JobErrors:
// an invalid payload, a missing document or an equipment tag of another class are permanent; LLM
// failures are classified by jobErrorFromLlm.
export function createProcessDocumentHandler(deps: ProcessDocumentDeps): JobHandler {
  return notImplemented('createProcessDocumentHandler', deps);
}
