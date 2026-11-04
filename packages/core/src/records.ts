import { z } from 'zod';

import { candidateSchema } from './candidate.js';
import { equipmentClassSchema, fieldNameSchema, TEXT_LIMITS } from './equipment.js';
import {
  conflictStatusSchema,
  documentTypeSchema,
  reviewActionSchema,
  reviewStatusSchema,
  verificationReasonSchema,
  verificationStatusSchema,
} from './status.js';

// Shapes of persisted records as the rest of the system sees them. The database package parses
// every row through these schemas, so storage details never leak past it.

const id = z.uuid();
const timestamp = z.date();

export const documentRecordSchema = z.strictObject({
  id,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  originalFilename: z.string().min(1).max(255),
  byteSize: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  documentType: documentTypeSchema,
  revision: z.string().min(1).max(32).nullable(),
  createdAt: timestamp,
});
export type DocumentRecord = z.infer<typeof documentRecordSchema>;

export const documentPageSchema = z.strictObject({
  documentId: id,
  pageNumber: z.number().int().min(1),
  content: z.string(),
});
export type DocumentPage = z.infer<typeof documentPageSchema>;

export const equipmentRecordSchema = z.strictObject({
  id,
  tag: z.string().min(1).max(TEXT_LIMITS.tag),
  equipmentClass: equipmentClassSchema,
  createdAt: timestamp,
});
export type EquipmentRecord = z.infer<typeof equipmentRecordSchema>;

export const extractionRunRecordSchema = z.strictObject({
  id,
  documentId: id,
  // The queue job that produced the run; null for runs written outside the queue.
  jobId: id.nullable(),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  tokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  createdAt: timestamp,
});
export type ExtractionRunRecord = z.infer<typeof extractionRunRecordSchema>;

export const fieldRecordSchema = z
  .strictObject({
    id,
    extractionRunId: id,
    equipmentId: id,
    name: fieldNameSchema,
    value: candidateSchema.shape.value,
    unit: candidateSchema.shape.unit,
    quote: candidateSchema.shape.quote,
    page: candidateSchema.shape.page,
    verificationStatus: verificationStatusSchema,
    verificationReasons: z.array(verificationReasonSchema),
    reviewStatus: reviewStatusSchema,
    version: z.number().int().min(1),
    createdAt: timestamp,
  })
  .refine(
    (field) =>
      (field.verificationStatus === 'verified') === (field.verificationReasons.length === 0),
    { message: 'verified fields have no reasons; unverified fields have at least one' },
  );
export type FieldRecord = z.infer<typeof fieldRecordSchema>;

// A candidate a human decision was based on: the stored field, and the lineage and revision of
// its document, kept so a later revision can be recognised as new evidence.
export const decisionBasisSchema = z.strictObject({
  candidateId: id,
  lineage: z.string().min(1).max(200),
  revision: z.string().min(1).max(32).nullable(),
});
export type DecisionBasis = z.infer<typeof decisionBasisSchema>;

export const conflictRecordSchema = z
  .strictObject({
    id,
    equipmentId: id,
    fieldName: fieldNameSchema,
    status: conflictStatusSchema,
    resolution: z.string().min(1).nullable(),
    createdAt: timestamp,
    resolvedAt: timestamp.nullable(),
    resolvedBy: z.string().min(1).max(TEXT_LIMITS.person).nullable(),
    chosenFieldId: id.nullable(),
    decidedValue: candidateSchema.shape.value.nullable(),
    decidedUnit: candidateSchema.shape.unit.nullable(),
    basedOn: z.array(decisionBasisSchema).nullable(),
  })
  .refine((c) => (c.status === 'resolved') === (c.resolution !== null && c.resolvedAt !== null), {
    message: 'a resolved conflict has a resolution and a resolvedAt; an open one has neither',
  })
  .refine(
    (c) =>
      (c.status === 'resolved') ===
      (c.resolvedBy !== null &&
        c.decidedValue !== null &&
        c.decidedUnit !== null &&
        c.basedOn !== null),
    { message: 'a resolved conflict records its decision; an open one has none' },
  );
export type ConflictRecord = z.infer<typeof conflictRecordSchema>;

export const reviewEventSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('field'), fieldId: id }),
  z.strictObject({ kind: z.literal('conflict'), conflictId: id }),
  z.strictObject({ kind: z.literal('register_version'), registerVersionId: id }),
]);
export type ReviewEventSubject = z.infer<typeof reviewEventSubjectSchema>;

export const reviewEventRecordSchema = z.strictObject({
  id,
  subject: reviewEventSubjectSchema,
  actor: z.string().min(1).max(TEXT_LIMITS.person),
  action: reviewActionSchema,
  before: z.json().nullable(),
  after: z.json().nullable(),
  reason: z.string().min(1).nullable(),
  createdAt: timestamp,
});
export type ReviewEventRecord = z.infer<typeof reviewEventRecordSchema>;

export const registerVersionRecordSchema = z
  .strictObject({
    id,
    number: z.number().int().min(1),
    approvedBy: z.string().min(1).max(TEXT_LIMITS.person).nullable(),
    publishedAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .refine((v) => v.publishedAt === null || v.approvedBy !== null, {
    message: 'a published version names its approver',
  });
export type RegisterVersionRecord = z.infer<typeof registerVersionRecordSchema>;

export const registerItemValuesSchema = z.record(
  fieldNameSchema,
  z.strictObject({ value: candidateSchema.shape.value, unit: candidateSchema.shape.unit }),
);
export type RegisterItemValues = z.infer<typeof registerItemValuesSchema>;

export const registerItemRecordSchema = z.strictObject({
  id,
  registerVersionId: id,
  equipmentId: id,
  tag: equipmentRecordSchema.shape.tag,
  values: registerItemValuesSchema,
  createdAt: timestamp,
});
export type RegisterItemRecord = z.infer<typeof registerItemRecordSchema>;
