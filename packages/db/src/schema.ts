import {
  ACCOUNT_LIMITS,
  CONFLICT_STATUSES,
  DOCUMENT_TYPES,
  EQUIPMENT_CLASSES,
  FIELD_NAME_PATTERN,
  TEXT_LIMITS,
  REVIEW_ACTIONS,
  USER_ROLES,
  REVIEW_STATUSES,
  VERIFICATION_REASONS,
  VERIFICATION_STATUSES,
} from '@specledger/core';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { JOB_STATUSES, JOB_TYPE_PATTERN, MAX_JOB_ATTEMPTS } from './queue-types.js';

// Allowed values come from @specledger/core, so the database and the domain share one vocabulary.
// Changing a list in core without generating a migration makes the drift check fail.
function sqlList(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '));
}

function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sqlList(values)})`;
}

function lengthBetween(column: AnyPgColumn, min: number, max: number): SQL {
  return sql`char_length(${column}) between ${sql.raw(String(min))} and ${sql.raw(String(max))}`;
}

function isFieldName(column: AnyPgColumn): SQL {
  return sql`${column} ~ ${sql.raw(`'${FIELD_NAME_PATTERN}'`)} and ${lengthBetween(column, 1, TEXT_LIMITS.fieldName)}`;
}

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const documents = pgTable(
  'documents',
  {
    id: id(),
    sha256: text('sha256').notNull(),
    // Display only. Never used to build a path.
    originalFilename: text('original_filename').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    pageCount: integer('page_count').notNull(),
    documentType: text('document_type').notNull(),
    revision: text('revision'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('documents_sha256_key').on(t.sha256),
    check('documents_sha256_format', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'documents_original_filename_length',
      sql`char_length(${t.originalFilename}) between 1 and 255`,
    ),
    check('documents_byte_size_positive', sql`${t.byteSize} > 0`),
    check('documents_page_count_positive', sql`${t.pageCount} >= 1`),
    check('documents_document_type_valid', oneOf(t.documentType, DOCUMENT_TYPES)),
    check('documents_revision_length', sql`char_length(${t.revision}) between 1 and 32`),
  ],
);

// File bytes live apart from document metadata so that listing documents never reads them.
export const documentBlobs = pgTable(
  'document_blobs',
  {
    documentId: uuid('document_id')
      .primaryKey()
      .references(() => documents.id, { onDelete: 'restrict' }),
    content: bytea('content').notNull(),
  },
  (t) => [check('document_blobs_content_not_empty', sql`octet_length(${t.content}) > 0`)],
);

export const documentPages = pgTable(
  'document_pages',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    pageNumber: integer('page_number').notNull(),
    content: text('content').notNull(),
  },
  (t) => [
    unique('document_pages_document_page_key').on(t.documentId, t.pageNumber),
    check('document_pages_page_number_positive', sql`${t.pageNumber} >= 1`),
  ],
);

// The job queue (Phase 7). Every timestamp is written from the caller's clock, never NOW(), so the
// queue's behaviour over time is testable with an injected clock.
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockedBy: text('locked_by'),
    // A fixed error code and message chosen by the worker, never an exception's text, which can
    // carry document content or query parameters.
    lastError: text('last_error'),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('jobs_idempotency_key_key').on(t.idempotencyKey),
    // The claim query reads queued jobs by run_at and expired leases by locked_until.
    index('jobs_status_run_at_idx').on(t.status, t.runAt),
    check('jobs_type_format', sql`${t.type} ~ ${sql.raw(`'${JOB_TYPE_PATTERN}'`)}`),
    check('jobs_status_valid', oneOf(t.status, JOB_STATUSES)),
    check('jobs_idempotency_key_length', lengthBetween(t.idempotencyKey, 1, 200)),
    check('jobs_payload_object', sql`jsonb_typeof(${t.payload}) = 'object'`),
    check(
      'jobs_max_attempts_range',
      sql`${t.maxAttempts} between 1 and ${sql.raw(String(MAX_JOB_ATTEMPTS))}`,
    ),
    check('jobs_attempts_range', sql`${t.attempts} between 0 and ${t.maxAttempts}`),
    // A lease exists exactly while the job is running.
    check(
      'jobs_lease_matches_status',
      sql`(${t.status} = 'running') = (${t.lockedBy} is not null and ${t.lockedUntil} is not null)`,
    ),
    check('jobs_locked_by_length', lengthBetween(t.lockedBy, 1, 200)),
    check('jobs_last_error_length', lengthBetween(t.lastError, 1, 500)),
  ],
);

export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    // The job that produced the run. Unique, so a job re-run after its commit (a worker that died
    // before marking the job complete) finds its run instead of writing a second one.
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'restrict' }),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    tokens: integer('tokens'),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('extraction_runs_document_id_idx').on(t.documentId),
    unique('extraction_runs_job_id_key').on(t.jobId),
    check('extraction_runs_model_not_empty', sql`char_length(${t.model}) > 0`),
    check('extraction_runs_prompt_version_not_empty', sql`char_length(${t.promptVersion}) > 0`),
    check('extraction_runs_tokens_nonnegative', sql`${t.tokens} >= 0`),
    check('extraction_runs_latency_nonnegative', sql`${t.latencyMs} >= 0`),
  ],
);

export const equipment = pgTable(
  'equipment',
  {
    id: id(),
    tag: text('tag').notNull(),
    equipmentClass: text('equipment_class').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('equipment_tag_key').on(t.tag),
    check('equipment_tag_length', lengthBetween(t.tag, 1, TEXT_LIMITS.tag)),
    check('equipment_class_valid', oneOf(t.equipmentClass, EQUIPMENT_CLASSES)),
  ],
);

export const fields = pgTable(
  'fields',
  {
    id: id(),
    extractionRunId: uuid('extraction_run_id')
      .notNull()
      .references(() => extractionRuns.id, { onDelete: 'restrict' }),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    value: text('value').notNull(),
    unit: text('unit').notNull(),
    quote: text('quote').notNull(),
    // The page the model cited. Deliberately not a foreign key to document_pages: model output is
    // untrusted, and a candidate citing a page that does not exist must still be stored, as
    // unverified, so the reviewer can see it.
    page: integer('page').notNull(),
    // verification_status is the machine's opinion; review_status is the human decision. They are
    // separate because they disagree on purpose: a reviewer can accept an unverified value with a
    // reason, or reject a verified one. One merged column would lose which of the two said what.
    verificationStatus: text('verification_status').notNull(),
    verificationReasons: text('verification_reasons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reviewStatus: text('review_status').notNull().default('pending'),
    // Optimistic concurrency: every update must name the version it read.
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique('fields_run_equipment_name_key').on(t.extractionRunId, t.equipmentId, t.name),
    index('fields_equipment_id_idx').on(t.equipmentId),
    check('fields_page_positive', sql`${t.page} >= 1`),
    check('fields_name_format', isFieldName(t.name)),
    check('fields_value_length', lengthBetween(t.value, 1, TEXT_LIMITS.value)),
    check('fields_unit_length', lengthBetween(t.unit, 1, TEXT_LIMITS.unit)),
    check('fields_quote_length', lengthBetween(t.quote, 1, TEXT_LIMITS.quote)),
    check('fields_version_positive', sql`${t.version} >= 1`),
    check('fields_verification_status_valid', oneOf(t.verificationStatus, VERIFICATION_STATUSES)),
    check('fields_review_status_valid', oneOf(t.reviewStatus, REVIEW_STATUSES)),
    check(
      'fields_verification_reasons_valid',
      sql`${t.verificationReasons} <@ array[${sqlList(VERIFICATION_REASONS)}]::text[]`,
    ),
    check(
      'fields_verified_has_no_reasons',
      sql`(${t.verificationStatus} = 'verified') = (cardinality(${t.verificationReasons}) = 0)`,
    ),
  ],
);

export const conflicts = pgTable(
  'conflicts',
  {
    id: id(),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'restrict' }),
    fieldName: text('field_name').notNull(),
    status: text('status').notNull().default('open'),
    // The reviewer's reason for the resolution.
    resolution: text('resolution'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // The structured decision (Phase 8): who decided, the value and unit chosen (taken from
    // chosen_field_id, or entered by the reviewer when that is null), and the candidates the
    // decision was based on, which reconciliation uses to tell when it needs a second look.
    resolvedBy: text('resolved_by'),
    chosenFieldId: uuid('chosen_field_id').references(() => fields.id, { onDelete: 'restrict' }),
    decidedValue: text('decided_value'),
    decidedUnit: text('decided_unit'),
    basedOn: jsonb('based_on'),
  },
  (t) => [
    index('conflicts_equipment_id_idx').on(t.equipmentId),
    // At most one open conflict per field of a piece of equipment, so re-running reconciliation
    // never opens a second one. Resolved conflicts are history and may repeat.
    uniqueIndex('conflicts_open_equipment_field_key')
      .on(t.equipmentId, t.fieldName)
      .where(sql`status = 'open'`),
    check('conflicts_status_valid', oneOf(t.status, CONFLICT_STATUSES)),
    check('conflicts_field_name_format', isFieldName(t.fieldName)),
    check('conflicts_resolution_not_empty', sql`char_length(${t.resolution}) >= 1`),
    check(
      'conflicts_resolution_matches_status',
      sql`(${t.status} = 'resolved') = (${t.resolution} is not null and ${t.resolvedAt} is not null)`,
    ),
    // Named to sort after the resolution checks above: Postgres checks constraints in name order.
    check(
      'conflicts_resolved_has_decision',
      sql`(${t.status} = 'resolved') = (${t.resolvedBy} is not null and ${t.decidedValue} is not null
        and ${t.decidedUnit} is not null and ${t.basedOn} is not null)`,
    ),
    check('conflicts_resolved_by_length', lengthBetween(t.resolvedBy, 1, TEXT_LIMITS.person)),
    check('conflicts_decided_value_length', lengthBetween(t.decidedValue, 1, TEXT_LIMITS.value)),
    check('conflicts_decided_unit_length', lengthBetween(t.decidedUnit, 1, TEXT_LIMITS.unit)),
    check('conflicts_based_on_array', sql`jsonb_typeof(${t.basedOn}) = 'array'`),
  ],
);

// One row, locked by every publish (SELECT ... FOR UPDATE), so concurrent publishes take
// consecutive register version numbers one at a time instead of racing on MAX(number) + 1.
export const registerCounter = pgTable(
  'register_counter',
  {
    id: integer('id').primaryKey(),
    lastNumber: integer('last_number').notNull(),
  },
  (t) => [
    check('register_counter_single_row', sql`${t.id} = 1`),
    check('register_counter_last_number_nonnegative', sql`${t.lastNumber} >= 0`),
  ],
);

export const registerVersions = pgTable(
  'register_versions',
  {
    id: id(),
    number: integer('number').notNull(),
    approvedBy: text('approved_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('register_versions_number_key').on(t.number),
    check('register_versions_number_positive', sql`${t.number} >= 1`),
    check(
      'register_versions_approved_by_length',
      lengthBetween(t.approvedBy, 1, TEXT_LIMITS.person),
    ),
    check(
      'register_versions_published_has_approver',
      sql`${t.publishedAt} is null or ${t.approvedBy} is not null`,
    ),
  ],
);

export const registerItems = pgTable(
  'register_items',
  {
    id: id(),
    registerVersionId: uuid('register_version_id')
      .notNull()
      .references(() => registerVersions.id, { onDelete: 'restrict' }),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'restrict' }),
    tag: text('tag').notNull(),
    values: jsonb('values').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('register_items_version_equipment_key').on(t.registerVersionId, t.equipmentId),
    check('register_items_values_object', sql`jsonb_typeof(${t.values}) = 'object'`),
    check('register_items_tag_length', lengthBetween(t.tag, 1, TEXT_LIMITS.tag)),
  ],
);

// Append-only audit log (UPDATE, DELETE and TRUNCATE are refused by a trigger). Each event points
// at exactly one subject through a real foreign key, so history can never reference a missing row.
export const reviewEvents = pgTable(
  'review_events',
  {
    id: id(),
    fieldId: uuid('field_id').references(() => fields.id, { onDelete: 'restrict' }),
    conflictId: uuid('conflict_id').references(() => conflicts.id, { onDelete: 'restrict' }),
    registerVersionId: uuid('register_version_id').references(() => registerVersions.id, {
      onDelete: 'restrict',
    }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('review_events_field_id_idx').on(t.fieldId),
    index('review_events_conflict_id_idx').on(t.conflictId),
    index('review_events_register_version_id_idx').on(t.registerVersionId),
    check(
      'review_events_exactly_one_subject',
      sql`num_nonnulls(${t.fieldId}, ${t.conflictId}, ${t.registerVersionId}) = 1`,
    ),
    check('review_events_actor_length', lengthBetween(t.actor, 1, TEXT_LIMITS.person)),
    check('review_events_reason_not_empty', sql`char_length(${t.reason}) >= 1`),
    check('review_events_action_valid', oneOf(t.action, REVIEW_ACTIONS)),
  ],
);

// Accounts for the real workspace. Passwords are stored only as scrypt hashes; roles come from
// core's USER_ROLES. A disabled user keeps their row (the audit log names them) but cannot sign in.
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    roles: text('roles').array().notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('users_email_key').on(t.email),
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
    check('users_email_length', lengthBetween(t.email, 3, ACCOUNT_LIMITS.email)),
    check('users_display_name_length', lengthBetween(t.displayName, 1, ACCOUNT_LIMITS.displayName)),
    check('users_password_hash_scrypt', sql`${t.passwordHash} like 'scrypt$%'`),
    check(
      'users_roles_valid',
      sql`cardinality(${t.roles}) >= 1 and ${t.roles} <@ array[${sqlList(USER_ROLES)}]::text[]`,
    ),
  ],
);

// Signed-in sessions. Only the SHA-256 of the session token is stored, so a copy of this table
// cannot be used to sign in. Expired and revoked sessions stop working at once.
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    check('sessions_token_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
