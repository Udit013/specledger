import type {
  AuditEvent,
  ConflictView,
  DocumentSummary,
  FieldRecord,
  FieldView,
  RegisterVersionRecord,
  RegisterVersionView,
  ReviewEventRecord,
} from '@specledger/core';
import type { DocumentWithProcessing } from '@specledger/db';

// Stored records as the HTTP contract shapes them: ISO timestamps, and only what a client needs.

// "CODE: message" as jobs.last_error stores it: only the code goes out.
const errorCode = (lastError: string | null) => {
  if (lastError === null) return null;
  const code = /^[A-Z][A-Z0-9_]*(?=:)/.exec(lastError);
  return code === null ? 'UNKNOWN' : code[0];
};

export function documentView({ document, job }: DocumentWithProcessing): DocumentSummary {
  return {
    id: document.id,
    originalFilename: document.originalFilename,
    documentType: document.documentType,
    revision: document.revision,
    pageCount: document.pageCount,
    byteSize: document.byteSize,
    sha256: document.sha256,
    createdAt: document.createdAt.toISOString(),
    processing:
      job === null
        ? { status: 'none', jobId: null, attempts: 0, lastErrorCode: null }
        : {
            status: job.status,
            jobId: job.id,
            attempts: job.attempts,
            lastErrorCode: errorCode(job.lastError),
          },
  };
}

export function fieldView(field: FieldRecord): FieldView {
  return {
    id: field.id,
    extractionRunId: field.extractionRunId,
    name: field.name,
    value: field.value,
    unit: field.unit,
    quote: field.quote,
    page: field.page,
    verificationStatus: field.verificationStatus,
    verificationReasons: field.verificationReasons,
    reviewStatus: field.reviewStatus,
    version: field.version,
  };
}

export function versionView(version: RegisterVersionRecord): RegisterVersionView {
  if (version.approvedBy === null || version.publishedAt === null) {
    throw new Error('only a published register version has a view');
  }
  return {
    id: version.id,
    number: version.number,
    approvedBy: version.approvedBy,
    publishedAt: version.publishedAt.toISOString(),
  };
}

export function auditView(event: ReviewEventRecord): AuditEvent {
  return {
    id: event.id,
    actor: event.actor,
    action: event.action,
    before: event.before,
    after: event.after,
    reason: event.reason,
    createdAt: event.createdAt.toISOString(),
  };
}

export type { ConflictView };
