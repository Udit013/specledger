import { z } from 'zod';

import { candidateSchema } from './candidate.js';
import { equipmentClassSchema, fieldNameSchema, TEXT_LIMITS } from './equipment.js';
import { reconcileRuleSchema } from './reconcile.js';
import { registerItemValuesSchema } from './records.js';
import {
  conflictStatusSchema,
  documentTypeSchema,
  reviewActionSchema,
  reviewStatusSchema,
  verificationReasonSchema,
  verificationStatusSchema,
} from './status.js';

// The HTTP contract (Phase 8), shared by the API and the web app: every request is parsed with
// these schemas, and every response is built to them. Timestamps travel as ISO 8601 strings.

const uuid = z.uuid();
const isoTime = z.iso.datetime({ offset: true });

// Every error response: {"error": {"code", "message", "details"?}}. Messages are fixed text.
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'REASON_REQUIRED',
  'INVALID_VALUE',
  'CONFLICT_ALREADY_RESOLVED',
  'CANDIDATE_NOT_IN_CONFLICT',
  'PUBLISH_BLOCKED',
  'NOTHING_TO_PUBLISH',
  'JOB_NOT_DEAD',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'NOT_READY',
  'INTERNAL',
  // The deployment accepts only listed documents (UPLOAD_ALLOWLIST).
  'UPLOAD_NOT_ALLOWED',
  // Accounts: an email already in use, and the last active admin, who cannot be removed.
  'EMAIL_TAKEN',
  'LAST_ADMIN',
  // The demo: still being prepared (its documents are being extracted), or at its sandbox limit.
  'DEMO_NOT_READY',
  'DEMO_FULL',
  // Upload rejections, as ingestion names them.
  'EMPTY',
  'NOT_A_PDF',
  'TOO_LARGE',
  'INVALID_METADATA',
  'TOO_MANY_PAGES',
  'ENCRYPTED',
  'CORRUPT',
  'PARSE_TIMEOUT',
  'RESOURCE_LIMIT',
  'NO_TEXT_LAYER',
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

// ---- documents --------------------------------------------------------------------------------

const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true');

// The text parts of the multipart upload, next to the file part.
export const uploadFieldsSchema = z.strictObject({
  documentType: documentTypeSchema,
  revision: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  equipmentTag: z.string().trim().min(1).max(TEXT_LIMITS.tag),
  equipmentClass: equipmentClassSchema,
  // Only synthetic corpus documents may go to the Gemini free tier.
  synthetic: booleanText.optional().transform((value) => value ?? false),
});
export type UploadFields = z.infer<typeof uploadFieldsSchema>;

export const JOB_STATES = ['none', 'queued', 'running', 'succeeded', 'failed', 'dead'] as const;

export const documentSummarySchema = z.strictObject({
  id: uuid,
  originalFilename: z.string(),
  documentType: documentTypeSchema,
  revision: z.string().nullable(),
  pageCount: z.number().int().min(1),
  byteSize: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: isoTime,
  processing: z.strictObject({
    status: z.enum(JOB_STATES),
    jobId: uuid.nullable(),
    attempts: z.number().int().nonnegative(),
    // The code part of the job's last error, never its message.
    lastErrorCode: z.string().nullable(),
  }),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const uploadResponseSchema = z.strictObject({
  document: documentSummarySchema,
  duplicate: z.boolean(),
});

export const listDocumentsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const documentListSchema = z.strictObject({ documents: z.array(documentSummarySchema) });

export const idParamsSchema = z.strictObject({ id: uuid });

export const pageParamsSchema = z.strictObject({
  id: uuid,
  n: z.coerce.number().int().min(1).max(10_000),
});

export const pageSchema = z.strictObject({
  documentId: uuid,
  pageNumber: z.number().int().min(1),
  content: z.string(),
});

// ---- fields -----------------------------------------------------------------------------------

export const fieldSchema = z.strictObject({
  id: uuid,
  extractionRunId: uuid,
  name: fieldNameSchema,
  value: z.string(),
  unit: z.string(),
  quote: z.string(),
  page: z.number().int().min(1),
  verificationStatus: verificationStatusSchema,
  verificationReasons: z.array(verificationReasonSchema),
  reviewStatus: reviewStatusSchema,
  version: z.number().int().min(1),
});
export type FieldView = z.infer<typeof fieldSchema>;

export const fieldListSchema = z.strictObject({ fields: z.array(fieldSchema) });

const reason = z.string().trim().min(1).max(500);
const expectedVersion = z.number().int().min(1);

// accept and reject keep the stored value; edit replaces it. Accepting an unverified value needs a
// reason (the reviewer overrides the verifier).
export const reviewFieldBodySchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('accept'), expectedVersion, reason: reason.optional() }),
  z.strictObject({ action: z.literal('reject'), expectedVersion, reason: reason.optional() }),
  z.strictObject({
    action: z.literal('edit'),
    expectedVersion,
    value: candidateSchema.shape.value,
    unit: candidateSchema.shape.unit,
    reason: reason.optional(),
  }),
]);
export type ReviewFieldBody = z.infer<typeof reviewFieldBodySchema>;

// ---- conflicts --------------------------------------------------------------------------------

export const listConflictsQuerySchema = z.strictObject({
  status: conflictStatusSchema.optional(),
});

export const conflictCandidateSchema = z.strictObject({
  fieldId: uuid,
  documentId: uuid,
  documentType: documentTypeSchema,
  revision: z.string().nullable(),
  value: z.string(),
  unit: z.string(),
  // The evidence: the quoted text and the page it is on.
  quote: z.string(),
  page: z.number().int().min(1),
  verificationStatus: verificationStatusSchema,
  reviewStatus: reviewStatusSchema,
});

// What the reconciliation rules alone would do with the current candidates, ignoring any human
// decision: the field they would select (null when they cannot choose) and the rules they applied,
// in order. A hint for the reviewer, never applied automatically.
export const conflictSuggestionSchema = z.strictObject({
  fieldId: uuid.nullable(),
  rules: z.array(reconcileRuleSchema),
});
export type ConflictSuggestion = z.infer<typeof conflictSuggestionSchema>;

export const conflictSchema = z.strictObject({
  id: uuid,
  equipmentTag: z.string(),
  fieldName: fieldNameSchema,
  status: conflictStatusSchema,
  createdAt: isoTime,
  // The latest field of each document of the equipment for this field.
  candidates: z.array(conflictCandidateSchema),
  suggestion: conflictSuggestionSchema,
  resolution: z
    .strictObject({
      reason: z.string(),
      resolvedAt: isoTime,
      resolvedBy: z.string(),
      chosenFieldId: uuid.nullable(),
      value: z.string(),
      unit: z.string(),
    })
    .nullable(),
});
export type ConflictView = z.infer<typeof conflictSchema>;

export const conflictListSchema = z.strictObject({ conflicts: z.array(conflictSchema) });

export const resolveConflictBodySchema = z.strictObject({
  choice: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('candidate'), fieldId: uuid }),
    z.strictObject({
      kind: z.literal('value'),
      value: candidateSchema.shape.value,
      unit: candidateSchema.shape.unit,
    }),
  ]),
  reason,
});
export type ResolveConflictBody = z.infer<typeof resolveConflictBodySchema>;

// ---- register ---------------------------------------------------------------------------------

export const PUBLISH_BLOCKERS = [
  // A document's processing job is still queued or running.
  'JOB_IN_PROGRESS',
  // A field of a latest extraction run has not been reviewed.
  'FIELD_PENDING_REVIEW',
  // A conflict is open.
  'CONFLICT_OPEN',
  // Accepted values of equal rank disagree and no decision covers them.
  'UNRESOLVED_DISAGREEMENT',
] as const;

export const publishBlockerSchema = z.strictObject({
  kind: z.enum(PUBLISH_BLOCKERS),
  // The job, field or conflict id; for UNRESOLVED_DISAGREEMENT, the equipment id.
  subjectId: uuid,
  equipmentTag: z.string().nullable(),
  fieldName: fieldNameSchema.nullable(),
});
export type PublishBlocker = z.infer<typeof publishBlockerSchema>;

export const registerVersionSchema = z.strictObject({
  id: uuid,
  number: z.number().int().min(1),
  approvedBy: z.string(),
  publishedAt: isoTime,
});
export type RegisterVersionView = z.infer<typeof registerVersionSchema>;

export const publishResponseSchema = z.strictObject({
  version: registerVersionSchema,
  itemCount: z.number().int().nonnegative(),
});

// GET /register/versions: published versions, newest first.
export const registerVersionListSchema = z.strictObject({
  versions: z.array(
    z.strictObject({ ...registerVersionSchema.shape, itemCount: z.number().int().nonnegative() }),
  ),
});
export type RegisterVersionSummary = z.infer<typeof registerVersionListSchema>['versions'][number];

// GET /register/versions/:n: one published version with its items, by equipment tag.
export const registerVersionDetailSchema = z.strictObject({
  version: registerVersionSchema,
  items: z.array(z.strictObject({ tag: z.string(), values: registerItemValuesSchema })),
});
export type RegisterVersionDetail = z.infer<typeof registerVersionDetailSchema>;

// The asset-system handoff: one item of a published version as an asset upsert, in the
// ACC-style contract of docs/adapter-contract.md (written for this project and checked against
// a mock only, not against the real Autodesk API).
export const assetPayloadSchema = z.strictObject({
  externalId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  attributes: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        value: z.string().max(200),
        unit: z.string().max(32),
      }),
    )
    .max(200),
  source: z.strictObject({
    system: z.literal('specledger'),
    registerVersion: z.number().int().min(1),
    publishedAt: z.iso.datetime({ offset: true }),
  }),
});
export type AssetPayload = z.infer<typeof assetPayloadSchema>;

// GET /register/versions/:n/handoff: the requests a sync of this version would send, computed,
// not sent. `connected` is always false: no asset system is connected to this deployment.
export const handoffPreviewSchema = z.strictObject({
  contract: z.literal('acc-style-asset-upsert'),
  connected: z.literal(false),
  requests: z.array(
    z.strictObject({
      method: z.literal('POST'),
      path: z.literal('/assets/upsert'),
      idempotencyKey: z.string().min(1).max(255),
      payload: assetPayloadSchema,
    }),
  ),
});
export type HandoffPreview = z.infer<typeof handoffPreviewSchema>;

export const exportParamsSchema = z.strictObject({ n: z.coerce.number().int().min(1) });
export const exportQuerySchema = z.strictObject({ format: z.enum(['csv', 'json']) });

// ---- audit ------------------------------------------------------------------------------------

// entity=field:<id>, conflict:<id> or register_version:<id>.
export const auditQuerySchema = z.strictObject({
  entity: z
    .string()
    .regex(/^(field|conflict|register_version):[0-9a-f-]{36}$/)
    .transform((entity) => {
      const [kind, id] = entity.split(':') as ['field' | 'conflict' | 'register_version', string];
      return { kind, id };
    })
    .pipe(z.strictObject({ kind: z.enum(['field', 'conflict', 'register_version']), id: uuid })),
});

export const auditEventSchema = z.strictObject({
  id: uuid,
  actor: z.string(),
  action: reviewActionSchema,
  before: z.json().nullable(),
  after: z.json().nullable(),
  reason: z.string().nullable(),
  createdAt: isoTime,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditListSchema = z.strictObject({ events: z.array(auditEventSchema) });

// ---- admin and probes -------------------------------------------------------------------------

export const requeueResponseSchema = z.strictObject({ jobId: uuid, status: z.literal('queued') });
export const healthSchema = z.strictObject({ status: z.literal('ok') });
export const readySchema = z.strictObject({ status: z.literal('ready') });

// ---- demo workspace ---------------------------------------------------------------------------

// POST /demo/session: a signed visitor session for the /demo routes, valid until expiresAt.
export const demoSessionSchema = z.strictObject({
  token: z
    .string()
    .regex(/^demo\.[A-Za-z0-9._-]+$/)
    .max(200),
  expiresAt: isoTime,
});
export type DemoSessionBody = z.infer<typeof demoSessionSchema>;
