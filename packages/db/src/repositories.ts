import {
  conflictRecordSchema,
  documentPageSchema,
  documentRecordSchema,
  documentTypeSchema,
  equipmentRecordSchema,
  extractionRunRecordSchema,
  fieldRecordSchema,
  registerItemRecordSchema,
  registerVersionRecordSchema,
  reviewEventRecordSchema,
  reviewStatusSchema,
  verificationStatusSchema,
} from '@specledger/core';
import { userRoleSchema } from '@specledger/core';
import type {
  UserRole,
  ConflictStatus,
  DecisionBasis,
  ConflictRecord,
  DocumentPage,
  DocumentRecord,
  DocumentType,
  EquipmentClass,
  EquipmentRecord,
  ExtractionRunRecord,
  FieldRecord,
  RegisterItemRecord,
  RegisterItemValues,
  RegisterVersionRecord,
  ReviewAction,
  ReviewEventRecord,
  ReviewEventSubject,
  ReviewStatus,
  VerificationReason,
  VerificationStatus,
} from '@specledger/core';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { createQueue } from './queue.js';
import type { JobStatus } from './queue-types.js';
import { toDomain } from './rows.js';

// Kept here too, where callers have imported it from.
export { StoredRowInvalidError } from './rows.js';
import type * as schema from './schema.js';
import {
  conflicts,
  documentBlobs,
  documentPages,
  documents,
  equipment,
  extractionRuns,
  fields,
  jobs,
  registerCounter,
  registerItems,
  registerVersions,
  reviewEvents,
  sessions,
  users,
} from './schema.js';

// Works for both the pool-backed database and an open transaction.
type Executor = PgDatabase<PgQueryResultHKT, typeof schema>;

function single<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('insert returned no row');
  return row;
}

export interface NewDocument {
  readonly sha256: string;
  readonly originalFilename: string;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly documentType: DocumentType;
  readonly revision: string | null;
}

export interface NewField {
  readonly extractionRunId: string;
  readonly equipmentId: string;
  readonly name: string;
  readonly value: string;
  readonly unit: string;
  readonly quote: string;
  readonly page: number;
  readonly verificationStatus: VerificationStatus;
  readonly verificationReasons: readonly VerificationReason[];
  readonly reviewStatus?: ReviewStatus;
}

const reconcileSourceRowSchema = z.strictObject({
  fieldId: z.uuid(),
  name: z.string(),
  value: z.string(),
  unit: z.string(),
  quote: z.string(),
  page: z.number().int().min(1),
  verificationStatus: verificationStatusSchema,
  reviewStatus: reviewStatusSchema,
  documentId: z.uuid(),
  documentType: documentTypeSchema,
  revision: z.string().nullable(),
});

// One stored field as reconciliation reads it: from the latest extraction run of each document of
// a piece of equipment, with the document's type and revision.
export interface ReconcileSourceRow {
  readonly fieldId: string;
  readonly name: string;
  readonly value: string;
  readonly unit: string;
  // The evidence: the quoted text and its page.
  readonly quote: string;
  readonly page: number;
  readonly verificationStatus: VerificationStatus;
  readonly reviewStatus: ReviewStatus;
  readonly documentId: string;
  readonly documentType: DocumentType;
  readonly revision: string | null;
}

// A document with the state of its processing job (null when it has none).
export interface DocumentWithProcessing {
  readonly document: DocumentRecord;
  readonly job: {
    readonly id: string;
    readonly status: JobStatus;
    readonly attempts: number;
    readonly lastError: string | null;
  } | null;
}

export type ReviewOutcome =
  | { readonly kind: 'updated'; readonly field: FieldRecord }
  | { readonly kind: 'stale'; readonly current: FieldRecord }
  | { readonly kind: 'missing' };

export interface ConflictWithTag extends ConflictRecord {
  readonly equipmentTag: string;
}

export interface ResolveInput {
  readonly id: string;
  readonly resolvedBy: string;
  readonly reason: string;
  readonly resolvedAt: Date;
  readonly chosenFieldId: string | null;
  readonly decidedValue: string;
  readonly decidedUnit: string;
  readonly basedOn: readonly DecisionBasis[];
}

// What stands in the way of publishing, as stored data. Reconciliation of accepted values adds a
// fourth kind, computed by the caller.
export interface StoredPublishBlockers {
  readonly jobsInProgress: readonly { readonly jobId: string; readonly documentId: string }[];
  readonly pendingFields: readonly {
    readonly fieldId: string;
    readonly equipmentTag: string;
    readonly fieldName: string;
  }[];
  readonly openConflicts: readonly {
    readonly conflictId: string;
    readonly equipmentTag: string;
    readonly fieldName: string;
  }[];
}

export interface PublishedVersion {
  readonly version: RegisterVersionRecord;
  readonly items: readonly RegisterItemRecord[];
}

export interface NewReviewEvent {
  readonly subject: ReviewEventSubject;
  readonly actor: string;
  readonly action: ReviewAction;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
}

function subjectColumns(subject: ReviewEventSubject): {
  fieldId: string | null;
  conflictId: string | null;
  registerVersionId: string | null;
} {
  switch (subject.kind) {
    case 'field':
      return { fieldId: subject.fieldId, conflictId: null, registerVersionId: null };
    case 'conflict':
      return { fieldId: null, conflictId: subject.conflictId, registerVersionId: null };
    case 'register_version':
      return { fieldId: null, conflictId: null, registerVersionId: subject.registerVersionId };
  }
}

function subjectFromRow(row: typeof reviewEvents.$inferSelect): unknown {
  if (row.fieldId !== null) return { kind: 'field', fieldId: row.fieldId };
  if (row.conflictId !== null) return { kind: 'conflict', conflictId: row.conflictId };
  if (row.registerVersionId !== null) {
    return { kind: 'register_version', registerVersionId: row.registerVersionId };
  }
  return null;
}

function reviewEventFromRow(row: typeof reviewEvents.$inferSelect): ReviewEventRecord {
  return toDomain('review_event', reviewEventRecordSchema, {
    id: row.id,
    subject: subjectFromRow(row),
    actor: row.actor,
    action: row.action,
    before: row.before,
    after: row.after,
    reason: row.reason,
    createdAt: row.createdAt,
  });
}

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly roles: readonly UserRole[];
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

const userRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  passwordHash: z.string(),
  roles: z.array(userRoleSchema).min(1),
  disabledAt: z.date().nullable(),
  createdAt: z.date(),
});
const userFromRow = (row: typeof users.$inferSelect): UserRecord =>
  toDomain('user', userRowSchema, row);

export function createRepositories(db: Executor) {
  // The id of the latest extraction run of every document.
  const latestRunIds = () =>
    db
      .selectDistinctOn([extractionRuns.documentId], { id: extractionRuns.id })
      .from(extractionRuns)
      .orderBy(extractionRuns.documentId, desc(extractionRuns.createdAt), desc(extractionRuns.id));

  // Each document with its latest processing job.
  async function withProcessing(
    found: readonly DocumentRecord[],
  ): Promise<DocumentWithProcessing[]> {
    if (found.length === 0) return [];
    const ids = found.map((document) => document.id);
    const rows = await db
      .selectDistinctOn([sql`${jobs.payload} ->> 'documentId'`], {
        documentId: sql<string>`${jobs.payload} ->> 'documentId'`,
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
      })
      .from(jobs)
      .where(
        and(eq(jobs.type, 'process_document'), inArray(sql`${jobs.payload} ->> 'documentId'`, ids)),
      )
      .orderBy(sql`${jobs.payload} ->> 'documentId'`, desc(jobs.createdAt), desc(jobs.id));
    const byDocument = new Map(rows.map((row) => [row.documentId, row]));
    return found.map((document) => {
      const job = byDocument.get(document.id);
      return {
        document,
        job:
          job === undefined
            ? null
            : {
                id: job.id,
                status: job.status as JobStatus,
                attempts: job.attempts,
                lastError: job.lastError,
              },
      };
    });
  }

  return {
    jobs: createQueue(db),

    documents: {
      async insert(input: NewDocument): Promise<DocumentRecord> {
        const row = single(await db.insert(documents).values(input).returning());
        return toDomain('document', documentRecordSchema, row);
      },
      // Deduplication by content. The unique constraint on sha256 decides: a concurrent insert of
      // the same hash waits for the first transaction, then does nothing, and the select (a new
      // statement under READ COMMITTED) sees the committed row. A check-then-insert would let both
      // callers see no row and the second fail on the constraint.
      async insertIfAbsent(
        input: NewDocument,
      ): Promise<{ document: DocumentRecord; created: boolean }> {
        const [inserted] = await db
          .insert(documents)
          .values(input)
          .onConflictDoNothing({ target: documents.sha256 })
          .returning();
        if (inserted !== undefined) {
          return { document: toDomain('document', documentRecordSchema, inserted), created: true };
        }
        const [existing] = await db
          .select()
          .from(documents)
          .where(eq(documents.sha256, input.sha256));
        if (existing === undefined) {
          throw new Error('document conflicted on sha256 but was not found');
        }
        return { document: toDomain('document', documentRecordSchema, existing), created: false };
      },
      async getById(id: string): Promise<DocumentRecord | null> {
        const [row] = await db.select().from(documents).where(eq(documents.id, id));
        return row === undefined ? null : toDomain('document', documentRecordSchema, row);
      },
      async putBlob(documentId: string, content: Uint8Array): Promise<void> {
        await db.insert(documentBlobs).values({ documentId, content: Buffer.from(content) });
      },
      async getBlob(documentId: string): Promise<Uint8Array | null> {
        const [row] = await db
          .select({ content: documentBlobs.content })
          .from(documentBlobs)
          .where(eq(documentBlobs.documentId, documentId));
        return row === undefined ? null : new Uint8Array(row.content);
      },
      async insertPages(
        documentId: string,
        pages: readonly { pageNumber: number; content: string }[],
      ): Promise<void> {
        if (pages.length === 0) return;
        await db.insert(documentPages).values(pages.map((page) => ({ documentId, ...page })));
      },
      // Newest first (created_at, then id), with the state of each document's processing job.
      async list(options: { limit: number; offset: number }): Promise<DocumentWithProcessing[]> {
        const rows = await db
          .select()
          .from(documents)
          .orderBy(desc(documents.createdAt), desc(documents.id))
          .limit(options.limit)
          .offset(options.offset);
        return withProcessing(rows.map((row) => toDomain('document', documentRecordSchema, row)));
      },
      async getWithProcessing(id: string): Promise<DocumentWithProcessing | null> {
        const [row] = await db.select().from(documents).where(eq(documents.id, id));
        if (row === undefined) return null;
        const [found] = await withProcessing([toDomain('document', documentRecordSchema, row)]);
        return found ?? null;
      },
      async getPage(documentId: string, pageNumber: number): Promise<DocumentPage | null> {
        const [row] = await db
          .select({
            documentId: documentPages.documentId,
            pageNumber: documentPages.pageNumber,
            content: documentPages.content,
          })
          .from(documentPages)
          .where(
            and(eq(documentPages.documentId, documentId), eq(documentPages.pageNumber, pageNumber)),
          );
        return row === undefined ? null : toDomain('document_page', documentPageSchema, row);
      },
      async listPages(documentId: string): Promise<DocumentPage[]> {
        const rows = await db
          .select({
            documentId: documentPages.documentId,
            pageNumber: documentPages.pageNumber,
            content: documentPages.content,
          })
          .from(documentPages)
          .where(eq(documentPages.documentId, documentId))
          .orderBy(asc(documentPages.pageNumber));
        return rows.map((row) => toDomain('document_page', documentPageSchema, row));
      },
    },

    equipment: {
      async insert(input: {
        tag: string;
        equipmentClass: EquipmentClass;
      }): Promise<EquipmentRecord> {
        const row = single(await db.insert(equipment).values(input).returning());
        return toDomain('equipment', equipmentRecordSchema, row);
      },
      // Insert unless the tag exists (on conflict do nothing, then select). created is false when
      // it existed; its class is returned as stored, for the caller to compare.
      async getOrCreate(input: {
        tag: string;
        equipmentClass: EquipmentClass;
      }): Promise<{ equipment: EquipmentRecord; created: boolean }> {
        const [inserted] = await db
          .insert(equipment)
          .values(input)
          .onConflictDoNothing({ target: equipment.tag })
          .returning();
        if (inserted !== undefined) {
          return {
            equipment: toDomain('equipment', equipmentRecordSchema, inserted),
            created: true,
          };
        }
        const [existing] = await db.select().from(equipment).where(eq(equipment.tag, input.tag));
        if (existing === undefined) {
          throw new Error('equipment conflicted on its tag but was not found');
        }
        return {
          equipment: toDomain('equipment', equipmentRecordSchema, existing),
          created: false,
        };
      },
      // Takes the row lock (SELECT ... FOR UPDATE) for the rest of the transaction, so writes and
      // reconciliation for one piece of equipment run one transaction at a time.
      async lockForUpdate(id: string): Promise<void> {
        await db
          .select({ id: equipment.id })
          .from(equipment)
          .where(eq(equipment.id, id))
          .for('update');
      },
      async getById(id: string): Promise<EquipmentRecord | null> {
        const [row] = await db.select().from(equipment).where(eq(equipment.id, id));
        return row === undefined ? null : toDomain('equipment', equipmentRecordSchema, row);
      },
      async getByTag(tag: string): Promise<EquipmentRecord | null> {
        const [row] = await db.select().from(equipment).where(eq(equipment.tag, tag));
        return row === undefined ? null : toDomain('equipment', equipmentRecordSchema, row);
      },
    },

    extractionRuns: {
      async insert(input: {
        documentId: string;
        model: string;
        promptVersion: string;
        tokens: number | null;
        latencyMs: number | null;
      }): Promise<ExtractionRunRecord> {
        const row = single(await db.insert(extractionRuns).values(input).returning());
        return toDomain('extraction_run', extractionRunRecordSchema, row);
      },
      // The run of a queue job, inserted once: on conflict on job_id do nothing, then select.
      // created is false when the job already wrote its run (a re-run after a lost completion).
      async insertForJob(input: {
        jobId: string;
        documentId: string;
        model: string;
        promptVersion: string;
        tokens: number | null;
        latencyMs: number | null;
      }): Promise<{ run: ExtractionRunRecord; created: boolean }> {
        const [inserted] = await db
          .insert(extractionRuns)
          .values(input)
          .onConflictDoNothing({ target: extractionRuns.jobId })
          .returning();
        if (inserted !== undefined) {
          return {
            run: toDomain('extraction_run', extractionRunRecordSchema, inserted),
            created: true,
          };
        }
        const [existing] = await db
          .select()
          .from(extractionRuns)
          .where(eq(extractionRuns.jobId, input.jobId));
        if (existing === undefined) throw new Error('run conflicted on its job but was not found');
        return {
          run: toDomain('extraction_run', extractionRunRecordSchema, existing),
          created: false,
        };
      },
      async getById(id: string): Promise<ExtractionRunRecord | null> {
        const [row] = await db.select().from(extractionRuns).where(eq(extractionRuns.id, id));
        return row === undefined
          ? null
          : toDomain('extraction_run', extractionRunRecordSchema, row);
      },
    },

    fields: {
      async insert(input: NewField): Promise<FieldRecord> {
        const row = single(
          await db
            .insert(fields)
            .values({ ...input, verificationReasons: [...input.verificationReasons] })
            .returning(),
        );
        return toDomain('field', fieldRecordSchema, row);
      },
      async getById(id: string): Promise<FieldRecord | null> {
        const [row] = await db.select().from(fields).where(eq(fields.id, id));
        return row === undefined ? null : toDomain('field', fieldRecordSchema, row);
      },
      // The fields of the document's latest extraction run, by name.
      async listLatestForDocument(documentId: string): Promise<FieldRecord[]> {
        const [latest] = await db
          .select({ id: extractionRuns.id })
          .from(extractionRuns)
          .where(eq(extractionRuns.documentId, documentId))
          .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
          .limit(1);
        if (latest === undefined) return [];
        const rows = await db
          .select()
          .from(fields)
          .where(eq(fields.extractionRunId, latest.id))
          .orderBy(asc(fields.name));
        return rows.map((row) => toDomain('field', fieldRecordSchema, row));
      },
      // Optimistic concurrency: UPDATE ... WHERE id = $1 AND version = $2, bumping the version.
      // Zero rows means the field changed since it was read (stale, with its current state) or
      // does not exist (missing).
      async review(input: {
        id: string;
        expectedVersion: number;
        reviewStatus: ReviewStatus;
        value?: string;
        unit?: string;
      }): Promise<ReviewOutcome> {
        const [updated] = await db
          .update(fields)
          .set({
            reviewStatus: input.reviewStatus,
            ...(input.value === undefined ? {} : { value: input.value }),
            ...(input.unit === undefined ? {} : { unit: input.unit }),
            version: sql`${fields.version} + 1`,
          })
          .where(and(eq(fields.id, input.id), eq(fields.version, input.expectedVersion)))
          .returning();
        if (updated !== undefined) {
          return { kind: 'updated', field: toDomain('field', fieldRecordSchema, updated) };
        }
        const [current] = await db.select().from(fields).where(eq(fields.id, input.id));
        return current === undefined
          ? { kind: 'missing' }
          : { kind: 'stale', current: toDomain('field', fieldRecordSchema, current) };
      },
      // The fields of the equipment from the latest extraction run of each of its documents
      // (latest by created_at, then id), sorted by field id.
      async listLatestForEquipment(equipmentId: string): Promise<ReconcileSourceRow[]> {
        // The latest run of each document that has fields for this equipment.
        const latestRuns = db
          .selectDistinctOn([extractionRuns.documentId], { id: extractionRuns.id })
          .from(extractionRuns)
          .innerJoin(fields, eq(fields.extractionRunId, extractionRuns.id))
          .where(eq(fields.equipmentId, equipmentId))
          .orderBy(
            extractionRuns.documentId,
            desc(extractionRuns.createdAt),
            desc(extractionRuns.id),
          );
        const rows = await db
          .select({
            fieldId: fields.id,
            name: fields.name,
            value: fields.value,
            unit: fields.unit,
            quote: fields.quote,
            page: fields.page,
            verificationStatus: fields.verificationStatus,
            reviewStatus: fields.reviewStatus,
            documentId: documents.id,
            documentType: documents.documentType,
            revision: documents.revision,
          })
          .from(fields)
          .innerJoin(extractionRuns, eq(extractionRuns.id, fields.extractionRunId))
          .innerJoin(documents, eq(documents.id, extractionRuns.documentId))
          .where(
            and(eq(fields.equipmentId, equipmentId), inArray(fields.extractionRunId, latestRuns)),
          )
          .orderBy(asc(fields.id));
        return rows.map((row) => toDomain('reconcile_source', reconcileSourceRowSchema, row));
      },
    },

    conflicts: {
      async insert(input: { equipmentId: string; fieldName: string }): Promise<ConflictRecord> {
        const row = single(await db.insert(conflicts).values(input).returning());
        return toDomain('conflict', conflictRecordSchema, row);
      },
      async getById(id: string): Promise<ConflictRecord | null> {
        const [row] = await db.select().from(conflicts).where(eq(conflicts.id, id));
        return row === undefined ? null : toDomain('conflict', conflictRecordSchema, row);
      },
      // Opens a conflict unless one is already open for the field (the partial unique index on
      // open conflicts decides). created is false when it was already open.
      async openIfAbsent(input: {
        equipmentId: string;
        fieldName: string;
      }): Promise<{ conflict: ConflictRecord; created: boolean }> {
        const [inserted] = await db
          .insert(conflicts)
          .values(input)
          .onConflictDoNothing({
            target: [conflicts.equipmentId, conflicts.fieldName],
            where: sql`status = 'open'`,
          })
          .returning();
        if (inserted !== undefined) {
          return { conflict: toDomain('conflict', conflictRecordSchema, inserted), created: true };
        }
        const [existing] = await db
          .select()
          .from(conflicts)
          .where(
            and(
              eq(conflicts.equipmentId, input.equipmentId),
              eq(conflicts.fieldName, input.fieldName),
              eq(conflicts.status, 'open'),
            ),
          );
        if (existing === undefined) throw new Error('conflict was open but was not found');
        return { conflict: toDomain('conflict', conflictRecordSchema, existing), created: false };
      },
      // With the equipment tag, oldest first; all conflicts, or those with the given status.
      async list(options: { status?: ConflictStatus }): Promise<ConflictWithTag[]> {
        const rows = await db
          .select({ conflict: conflicts, equipmentTag: equipment.tag })
          .from(conflicts)
          .innerJoin(equipment, eq(equipment.id, conflicts.equipmentId))
          .where(options.status === undefined ? undefined : eq(conflicts.status, options.status))
          .orderBy(asc(conflicts.createdAt), asc(conflicts.id));
        return rows.map((row) => ({
          ...toDomain('conflict', conflictRecordSchema, row.conflict),
          equipmentTag: row.equipmentTag,
        }));
      },
      async getWithTag(id: string): Promise<ConflictWithTag | null> {
        const [row] = await db
          .select({ conflict: conflicts, equipmentTag: equipment.tag })
          .from(conflicts)
          .innerJoin(equipment, eq(equipment.id, conflicts.equipmentId))
          .where(eq(conflicts.id, id));
        return row === undefined
          ? null
          : {
              ...toDomain('conflict', conflictRecordSchema, row.conflict),
              equipmentTag: row.equipmentTag,
            };
      },
      // Records the decision on an open conflict. Null, changing nothing, if it is not open.
      async resolve(input: ResolveInput): Promise<ConflictRecord | null> {
        const [row] = await db
          .update(conflicts)
          .set({
            status: 'resolved',
            resolution: input.reason,
            resolvedAt: input.resolvedAt,
            resolvedBy: input.resolvedBy,
            chosenFieldId: input.chosenFieldId,
            decidedValue: input.decidedValue,
            decidedUnit: input.decidedUnit,
            basedOn: input.basedOn,
          })
          .where(and(eq(conflicts.id, input.id), eq(conflicts.status, 'open')))
          .returning();
        return row === undefined ? null : toDomain('conflict', conflictRecordSchema, row);
      },
      // The latest resolved conflict of each field of the equipment: its standing decisions.
      async listDecisions(equipmentId: string): Promise<ConflictRecord[]> {
        const rows = await db
          .selectDistinctOn([conflicts.fieldName])
          .from(conflicts)
          .where(and(eq(conflicts.equipmentId, equipmentId), eq(conflicts.status, 'resolved')))
          .orderBy(conflicts.fieldName, desc(conflicts.resolvedAt), desc(conflicts.id));
        return rows.map((row) => toDomain('conflict', conflictRecordSchema, row));
      },
      async listOpen(equipmentId: string): Promise<ConflictRecord[]> {
        const rows = await db
          .select()
          .from(conflicts)
          .where(and(eq(conflicts.equipmentId, equipmentId), eq(conflicts.status, 'open')))
          .orderBy(asc(conflicts.fieldName), asc(conflicts.id));
        return rows.map((row) => toDomain('conflict', conflictRecordSchema, row));
      },
    },

    reviewEvents: {
      async append(input: NewReviewEvent): Promise<ReviewEventRecord> {
        const row = single(
          await db
            .insert(reviewEvents)
            .values({
              ...subjectColumns(input.subject),
              actor: input.actor,
              action: input.action,
              before: input.before ?? null,
              after: input.after ?? null,
              reason: input.reason,
            })
            .returning(),
        );
        return reviewEventFromRow(row);
      },
      async listForSubject(subject: ReviewEventSubject): Promise<ReviewEventRecord[]> {
        const condition =
          subject.kind === 'field'
            ? eq(reviewEvents.fieldId, subject.fieldId)
            : subject.kind === 'conflict'
              ? eq(reviewEvents.conflictId, subject.conflictId)
              : eq(reviewEvents.registerVersionId, subject.registerVersionId);
        const rows = await db
          .select()
          .from(reviewEvents)
          .where(condition)
          .orderBy(asc(reviewEvents.createdAt), asc(reviewEvents.id));
        return rows.map(reviewEventFromRow);
      },
    },

    register: {
      // Locks the counter row (SELECT ... FOR UPDATE) for the rest of the transaction, advances it
      // and returns the new number, so concurrent publishes take consecutive numbers in turn.
      async takeNextNumber(): Promise<number> {
        // The lock is what serializes publishes: without it two transactions would read the same
        // last number and both try to create the next version.
        const [counter] = await db
          .select({ lastNumber: registerCounter.lastNumber })
          .from(registerCounter)
          .where(eq(registerCounter.id, 1))
          .for('update');
        if (counter === undefined) throw new Error('the register counter row is missing');
        const next = counter.lastNumber + 1;
        await db.update(registerCounter).set({ lastNumber: next }).where(eq(registerCounter.id, 1));
        return next;
      },
      async blockers(): Promise<StoredPublishBlockers> {
        const jobsInProgress = await db
          .select({ jobId: jobs.id, documentId: sql<string>`${jobs.payload} ->> 'documentId'` })
          .from(jobs)
          .where(
            and(eq(jobs.type, 'process_document'), inArray(jobs.status, ['queued', 'running'])),
          )
          .orderBy(asc(jobs.id));
        const pendingFields = await db
          .select({ fieldId: fields.id, equipmentTag: equipment.tag, fieldName: fields.name })
          .from(fields)
          .innerJoin(equipment, eq(equipment.id, fields.equipmentId))
          .where(
            and(
              eq(fields.reviewStatus, 'pending'),
              inArray(fields.extractionRunId, latestRunIds()),
            ),
          )
          .orderBy(asc(equipment.tag), asc(fields.name), asc(fields.id));
        const openConflicts = await db
          .select({
            conflictId: conflicts.id,
            equipmentTag: equipment.tag,
            fieldName: conflicts.fieldName,
          })
          .from(conflicts)
          .innerJoin(equipment, eq(equipment.id, conflicts.equipmentId))
          .where(eq(conflicts.status, 'open'))
          .orderBy(asc(equipment.tag), asc(conflicts.fieldName), asc(conflicts.id));
        return { jobsInProgress, pendingFields, openConflicts };
      },
      async getPublished(number: number): Promise<PublishedVersion | null> {
        const [row] = await db
          .select()
          .from(registerVersions)
          .where(and(eq(registerVersions.number, number), isNotNull(registerVersions.publishedAt)));
        if (row === undefined) return null;
        const items = await db
          .select()
          .from(registerItems)
          .where(eq(registerItems.registerVersionId, row.id))
          .orderBy(asc(registerItems.tag));
        return {
          version: toDomain('register_version', registerVersionRecordSchema, row),
          items: items.map((item) => toDomain('register_item', registerItemRecordSchema, item)),
        };
      },
      async listEquipment(): Promise<EquipmentRecord[]> {
        const rows = await db.select().from(equipment).orderBy(asc(equipment.tag));
        return rows.map((row) => toDomain('equipment', equipmentRecordSchema, row));
      },
      async createDraftVersion(number: number): Promise<RegisterVersionRecord> {
        const row = single(await db.insert(registerVersions).values({ number }).returning());
        return toDomain('register_version', registerVersionRecordSchema, row);
      },
      // Returns null when the version does not exist or is already published.
      async publishVersion(
        id: string,
        approvedBy: string,
        publishedAt: Date,
      ): Promise<RegisterVersionRecord | null> {
        const [row] = await db
          .update(registerVersions)
          .set({ approvedBy, publishedAt })
          .where(and(eq(registerVersions.id, id), isNull(registerVersions.publishedAt)))
          .returning();
        return row === undefined
          ? null
          : toDomain('register_version', registerVersionRecordSchema, row);
      },
      async getVersion(id: string): Promise<RegisterVersionRecord | null> {
        const [row] = await db.select().from(registerVersions).where(eq(registerVersions.id, id));
        return row === undefined
          ? null
          : toDomain('register_version', registerVersionRecordSchema, row);
      },
      async addItem(input: {
        registerVersionId: string;
        equipmentId: string;
        tag: string;
        values: RegisterItemValues;
      }): Promise<RegisterItemRecord> {
        const row = single(await db.insert(registerItems).values(input).returning());
        return toDomain('register_item', registerItemRecordSchema, row);
      },
      async listItems(registerVersionId: string): Promise<RegisterItemRecord[]> {
        const rows = await db
          .select()
          .from(registerItems)
          .where(eq(registerItems.registerVersionId, registerVersionId))
          .orderBy(asc(registerItems.tag));
        return rows.map((row) => toDomain('register_item', registerItemRecordSchema, row));
      },
    },
    users: {
      // Returns null when the email is taken (the unique constraint decides, so two concurrent
      // sign-ups for one email cannot both succeed).
      async create(input: {
        email: string;
        displayName: string;
        passwordHash: string;
        roles: readonly UserRole[];
      }): Promise<UserRecord | null> {
        const [row] = await db
          .insert(users)
          .values({ ...input, roles: [...input.roles] })
          .onConflictDoNothing({ target: users.email })
          .returning();
        return row === undefined ? null : userFromRow(row);
      },
      async getById(id: string): Promise<UserRecord | null> {
        const [row] = await db.select().from(users).where(eq(users.id, id));
        return row === undefined ? null : userFromRow(row);
      },
      async getByEmail(email: string): Promise<UserRecord | null> {
        const [row] = await db.select().from(users).where(eq(users.email, email));
        return row === undefined ? null : userFromRow(row);
      },
      async list(): Promise<UserRecord[]> {
        const rows = await db.select().from(users).orderBy(asc(users.email));
        return rows.map(userFromRow);
      },
      async update(
        id: string,
        change: {
          roles?: readonly UserRole[];
          disabledAt?: Date | null;
          passwordHash?: string;
        },
      ): Promise<UserRecord | null> {
        const [row] = await db
          .update(users)
          .set({
            ...(change.roles === undefined ? {} : { roles: [...change.roles] }),
            ...(change.disabledAt === undefined ? {} : { disabledAt: change.disabledAt }),
            ...(change.passwordHash === undefined ? {} : { passwordHash: change.passwordHash }),
          })
          .where(eq(users.id, id))
          .returning();
        return row === undefined ? null : userFromRow(row);
      },
      // Active admins, locked so that two concurrent changes cannot remove the last one.
      async lockActiveAdmins(): Promise<string[]> {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(and(isNull(users.disabledAt), sql`'admin' = any(${users.roles})`))
          .for('update');
        return rows.map((row) => row.id);
      },
    },
    sessions: {
      async create(input: { tokenHash: string; userId: string; expiresAt: Date }): Promise<void> {
        await db.insert(sessions).values(input);
      },
      // The session and its user, if the session is neither expired nor revoked and the user is
      // not disabled.
      async findActive(
        tokenHash: string,
        now: Date,
      ): Promise<{ expiresAt: Date; user: UserRecord } | null> {
        const [row] = await db
          .select({ expiresAt: sessions.expiresAt, user: users })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(
            and(
              eq(sessions.tokenHash, tokenHash),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, now),
              isNull(users.disabledAt),
            ),
          );
        return row === undefined ? null : { expiresAt: row.expiresAt, user: userFromRow(row.user) };
      },
      async revoke(tokenHash: string, now: Date): Promise<void> {
        await db
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
      },
      async revokeAllForUser(userId: string, now: Date): Promise<void> {
        await db
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      },
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
