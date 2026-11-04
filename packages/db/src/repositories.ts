import {
  conflictRecordSchema,
  documentPageSchema,
  documentRecordSchema,
  equipmentRecordSchema,
  extractionRunRecordSchema,
  fieldRecordSchema,
  registerItemRecordSchema,
  registerVersionRecordSchema,
  reviewEventRecordSchema,
} from '@specledger/core';
import type {
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
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { z } from 'zod';

import { notImplemented } from './not-implemented.js';
import { createQueue } from './queue.js';
import type * as schema from './schema.js';
import {
  conflicts,
  documentBlobs,
  documentPages,
  documents,
  equipment,
  extractionRuns,
  fields,
  registerItems,
  registerVersions,
  reviewEvents,
} from './schema.js';

// Works for both the pool-backed database and an open transaction.
type Executor = PgDatabase<PgQueryResultHKT, typeof schema>;

export class StoredRowInvalidError extends Error {
  readonly entity: string;
  constructor(entity: string, issuePaths: readonly string[]) {
    // Paths only: row values may be document text and never belong in an error message.
    super(`stored ${entity} row failed validation at: ${issuePaths.join(', ') || '(root)'}`);
    this.name = 'StoredRowInvalidError';
    this.entity = entity;
  }
}

// Every row entering the domain is parsed with the core schema, so a row that breaks a domain
// invariant is reported instead of travelling further.
function toDomain<T>(entity: string, schemaOf: z.ZodType<T>, value: unknown): T {
  const parsed = schemaOf.safeParse(value);
  if (!parsed.success) {
    throw new StoredRowInvalidError(
      entity,
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  }
  return parsed.data;
}

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

// One stored field as reconciliation reads it: from the latest extraction run of each document of
// a piece of equipment, with the document's type and revision.
export interface ReconcileSourceRow {
  readonly fieldId: string;
  readonly name: string;
  readonly value: string;
  readonly unit: string;
  readonly verificationStatus: VerificationStatus;
  readonly documentId: string;
  readonly documentType: DocumentType;
  readonly revision: string | null;
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

export function createRepositories(db: Executor) {
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
      getOrCreate(input: {
        tag: string;
        equipmentClass: EquipmentClass;
      }): Promise<{ equipment: EquipmentRecord; created: boolean }> {
        return notImplemented('equipment.getOrCreate', db, input);
      },
      // Takes the row lock (SELECT ... FOR UPDATE) for the rest of the transaction, so writes and
      // reconciliation for one piece of equipment run one transaction at a time.
      lockForUpdate(id: string): Promise<void> {
        return notImplemented('equipment.lockForUpdate', db, id);
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
      insertForJob(input: {
        jobId: string;
        documentId: string;
        model: string;
        promptVersion: string;
        tokens: number | null;
        latencyMs: number | null;
      }): Promise<{ run: ExtractionRunRecord; created: boolean }> {
        return notImplemented('extractionRuns.insertForJob', db, input);
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
      // The fields of the equipment from the latest extraction run of each of its documents
      // (latest by created_at, then id), sorted by field id.
      listLatestForEquipment(equipmentId: string): Promise<ReconcileSourceRow[]> {
        return notImplemented('fields.listLatestForEquipment', db, equipmentId);
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
      openIfAbsent(input: {
        equipmentId: string;
        fieldName: string;
      }): Promise<{ conflict: ConflictRecord; created: boolean }> {
        return notImplemented('conflicts.openIfAbsent', db, input);
      },
      listOpen(equipmentId: string): Promise<ConflictRecord[]> {
        return notImplemented('conflicts.listOpen', db, equipmentId);
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
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
