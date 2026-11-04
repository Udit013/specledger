import {
  auditQuerySchema,
  exportParamsSchema,
  exportQuerySchema,
  idParamsSchema,
  listConflictsQuerySchema,
  listDocumentsQuerySchema,
  pageParamsSchema,
  resolveConflictBodySchema,
  reviewFieldBodySchema,
  uploadFieldsSchema,
} from '@specledger/core';
import type { ReviewEventSubject } from '@specledger/core';
import { exporterFor } from '@specledger/exporters';
import type { IngestError } from '@specledger/ingest';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

import { createIngestion } from '../ingestion.js';
import { conflictView, resolveConflict } from '../services/conflicts.js';
import { publishRegister } from '../services/publish.js';
import { reviewField } from '../services/review.js';
import type { AppDeps } from './deps.js';
import { actorOf } from './auth.js';
import type { Role } from './auth.js';
import { ApiError, notFound } from './errors.js';
import { auditView, documentView, fieldView, versionView } from './views.js';

const ANY: readonly Role[] = ['engineer', 'approver'];
const ENGINEER: readonly Role[] = ['engineer'];
const APPROVER: readonly Role[] = ['approver'];

// Parses a part of the request. A failure reports where and what kind, never the input itself.
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(400, 'VALIDATION_FAILED', 'The request is invalid.', {
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    })),
  });
}

// Ingestion's codes are the response codes: unreadable input is 400, too big 413, and a PDF that
// is well-formed enough to open but cannot be used 422.
function uploadRejected(error: IngestError): ApiError {
  const status =
    error.code === 'EMPTY' || error.code === 'NOT_A_PDF' || error.code === 'INVALID_METADATA'
      ? 400
      : error.code === 'TOO_LARGE'
        ? 413
        : 422;
  return new ApiError(status, error.code, error.message, error.details);
}

const isFileTooLarge = (error: unknown) =>
  error instanceof Error && (error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE';

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { database } = deps;
  const clock = deps.clock ?? (() => new Date());
  const upload = createIngestion(database, deps.limits, {
    clock,
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });

  // ---- probes ---------------------------------------------------------------------------------

  app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' as const }));

  app.get('/ready', { config: { auth: 'public' } }, async () => {
    const outcome = await withTimeout(
      database.ping().then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      deps.http.readyTimeoutMs,
    );
    if (outcome !== 'up') {
      throw new ApiError(503, 'NOT_READY', 'The database is not reachable.');
    }
    return { status: 'ready' as const };
  });

  // ---- documents ------------------------------------------------------------------------------

  app.post(
    '/documents',
    {
      config: {
        auth: ENGINEER,
        rateLimit: { max: deps.http.uploadRateLimitPerMinute, timeWindow: 60_000 },
      },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw new ApiError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Upload the document as multipart/form-data.',
        );
      }
      const fields: Record<string, string> = {};
      let file: { bytes: Uint8Array; filename: string; contentType: string } | null = null;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            file = {
              bytes: await part.toBuffer(),
              filename: part.filename,
              contentType: part.mimetype,
            };
          } else {
            fields[part.fieldname] = typeof part.value === 'string' ? part.value : '';
          }
        }
      } catch (error: unknown) {
        if (isFileTooLarge(error)) {
          throw new ApiError(413, 'TOO_LARGE', 'The file is larger than the size limit.', {
            limit: deps.limits.maxBytes,
          });
        }
        throw error;
      }
      const meta = parse(uploadFieldsSchema, fields);
      if (file === null) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'The request is invalid.', {
          issues: [{ path: 'file', code: 'missing' }],
        });
      }
      const stored = await upload({
        bytes: file.bytes,
        meta: {
          filename: file.filename,
          contentType: file.contentType,
          documentType: meta.documentType,
          revision: meta.revision,
        },
        equipment: { tag: meta.equipmentTag, equipmentClass: meta.equipmentClass },
        synthetic: meta.synthetic,
        correlationId: request.id,
      });
      if (!stored.ok) throw uploadRejected(stored.error);
      const { document, duplicate, job } = stored.value;
      const summary = duplicate
        ? await database.documents.getWithProcessing(document.id)
        : {
            document,
            job:
              job === null
                ? null
                : {
                    id: job.id,
                    status: job.status,
                    attempts: job.attempts,
                    lastError: job.lastError,
                  },
          };
      if (summary === null) throw notFound('document');
      return reply
        .status(duplicate ? 200 : 202)
        .send({ document: documentView(summary), duplicate });
    },
  );

  app.get('/documents', { config: { auth: ANY } }, async (request) => {
    const query = parse(listDocumentsQuerySchema, request.query);
    const documents = await database.documents.list(query);
    return { documents: documents.map(documentView) };
  });

  app.get('/documents/:id', { config: { auth: ANY } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    const found = await database.documents.getWithProcessing(id);
    if (found === null) throw notFound('document');
    return documentView(found);
  });

  app.get('/documents/:id/pages/:n', { config: { auth: ANY } }, async (request) => {
    const { id, n } = parse(pageParamsSchema, request.params);
    const page = await database.documents.getPage(id, n);
    if (page === null) throw notFound('page');
    return page;
  });

  app.get('/documents/:id/fields', { config: { auth: ANY } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    if ((await database.documents.getById(id)) === null) throw notFound('document');
    const fields = await database.fields.listLatestForDocument(id);
    return { fields: fields.map(fieldView) };
  });

  // ---- review ---------------------------------------------------------------------------------

  app.patch('/fields/:id', { config: { auth: ENGINEER } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    const body = parse(reviewFieldBodySchema, request.body);
    const field = await reviewField(database, { fieldId: id, body, actor: actorOf(request) });
    return fieldView(field);
  });

  app.get('/conflicts', { config: { auth: ANY } }, async (request) => {
    const query = parse(listConflictsQuerySchema, request.query);
    const conflicts = await database.conflicts.list(
      query.status === undefined ? {} : { status: query.status },
    );
    return {
      conflicts: await Promise.all(conflicts.map((conflict) => conflictView(database, conflict))),
    };
  });

  app.post('/conflicts/:id/resolve', { config: { auth: ENGINEER } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    const body = parse(resolveConflictBodySchema, request.body);
    const resolved = await resolveConflict(database, {
      conflictId: id,
      body,
      actor: actorOf(request),
      now: clock(),
    });
    return conflictView(database, resolved);
  });

  // ---- register -------------------------------------------------------------------------------

  app.post('/register/publish', { config: { auth: APPROVER } }, async (request, reply) => {
    const published = await publishRegister(database, { actor: actorOf(request), now: clock() });
    return reply
      .status(201)
      .send({ version: versionView(published.version), itemCount: published.items.length });
  });

  app.get('/register/versions/:n/export', { config: { auth: ANY } }, async (request, reply) => {
    const { n } = parse(exportParamsSchema, request.params);
    const { format } = parse(exportQuerySchema, request.query);
    const found = await database.register.getPublished(n);
    if (found === null) throw notFound('register version');
    const { version, items } = found;
    if (version.approvedBy === null || version.publishedAt === null) {
      throw notFound('register version');
    }
    const exportable = {
      number: version.number,
      approvedBy: version.approvedBy,
      publishedAt: version.publishedAt,
      items: items.map((item) => ({ tag: item.tag, values: item.values })),
    };
    const exporter = exporterFor(format);
    void reply.header(
      'content-disposition',
      `attachment; filename="register-v${String(version.number)}.${exporter.extension}"`,
    );
    return reply.type(exporter.contentType).send(exporter.render(exportable));
  });

  // ---- audit ----------------------------------------------------------------------------------

  app.get('/audit', { config: { auth: ANY } }, async (request) => {
    const { entity } = parse(auditQuerySchema, request.query);
    const subject: ReviewEventSubject =
      entity.kind === 'field'
        ? { kind: 'field', fieldId: entity.id }
        : entity.kind === 'conflict'
          ? { kind: 'conflict', conflictId: entity.id }
          : { kind: 'register_version', registerVersionId: entity.id };
    const events = await database.reviewEvents.listForSubject(subject);
    return { events: events.map(auditView) };
  });

  // ---- admin ----------------------------------------------------------------------------------

  app.post('/admin/jobs/:id/requeue', { config: { auth: APPROVER } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    if ((await database.jobs.getById(id)) === null) throw notFound('job');
    if (!(await database.jobs.requeue(id, clock()))) {
      throw new ApiError(409, 'JOB_NOT_DEAD', 'Only a dead job can be requeued.');
    }
    return { jobId: id, status: 'queued' as const };
  });
}
