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
import { assetPayloadFor, exporterFor, idempotencyKeyFor } from '@specledger/exporters';
import { sha256Hex } from '@specledger/ingest';
import type { IngestError } from '@specledger/ingest';
import type { Database } from '@specledger/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { createIngestion } from '../ingestion.js';
import { conflictView, resolveConflict } from '../services/conflicts.js';
import { publishRegister } from '../services/publish.js';
import { reviewField } from '../services/review.js';
import type { AppDeps } from './deps.js';
import { actorOf, holds } from './auth.js';
import type { Role, RouteAuth } from './auth.js';
import { ApiError, notFound } from './errors.js';
import { auditView, documentView, fieldView, versionView } from './views.js';

// Who may do what in the workspace. Reading needs any role.
const ANY: readonly Role[] = ['engineer', 'reviewer', 'approver', 'admin'];
const UPLOAD: readonly Role[] = ['engineer'];
// Editing a value: engineers and reviewers; accepting or rejecting one: reviewers (checked below).
const REVIEW: readonly Role[] = ['engineer', 'reviewer'];
const RESOLVE: readonly Role[] = ['reviewer'];
const PUBLISH: readonly Role[] = ['approver'];
const ADMIN: readonly Role[] = ['admin'];

// The same routes serve three places:
//   workspace  the real workspace: every route, for signed-in users by role
//   showcase   the public demo showcase: read-only routes, no sign-in, on the demo database
//   sandbox    a demo visitor's private copy: reading, reviewing, resolving and a simulated
//              publish on the sandbox's own schema; no uploads and no administration, so a
//              visitor can never cause a model call
export type RouteMode = 'workspace' | 'showcase' | 'sandbox';

declare module 'fastify' {
  interface FastifyRequest {
    // The database a sandbox request works on; null means the scope's own database.
    workspace: Database | null;
  }
}

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

export function registerRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  mode: RouteMode = 'workspace',
): void {
  const { database } = deps;
  const clock = deps.clock ?? (() => new Date());
  if (!app.hasRequestDecorator('workspace')) app.decorateRequest('workspace', null);
  // A sandbox request works only on its visitor's schema, never on the scope's own database.
  const db = (request: FastifyRequest): Database => {
    if (request.workspace !== null) return request.workspace;
    if (mode === 'sandbox') throw new Error('a sandbox request has no sandbox');
    return database;
  };
  // Reads are public in the showcase; everything else needs a role.
  const read: RouteAuth = mode === 'showcase' ? 'public' : ANY;
  const writes = mode !== 'showcase';

  if (mode === 'workspace') {
    registerProbes(app, deps);
    registerUpload(app, deps);
  }

  // ---- documents ------------------------------------------------------------------------------

  app.get('/documents', { config: { auth: read } }, async (request) => {
    const query = parse(listDocumentsQuerySchema, request.query);
    const documents = await db(request).documents.list(query);
    return { documents: documents.map(documentView) };
  });

  app.get('/documents/:id', { config: { auth: read } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    const found = await db(request).documents.getWithProcessing(id);
    if (found === null) throw notFound('document');
    return documentView(found);
  });

  app.get('/documents/:id/pages/:n', { config: { auth: read } }, async (request) => {
    const { id, n } = parse(pageParamsSchema, request.params);
    const page = await db(request).documents.getPage(id, n);
    if (page === null) throw notFound('page');
    return page;
  });

  app.get('/documents/:id/fields', { config: { auth: read } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    if ((await db(request).documents.getById(id)) === null) throw notFound('document');
    const fields = await db(request).fields.listLatestForDocument(id);
    return { fields: fields.map(fieldView) };
  });

  // ---- review ---------------------------------------------------------------------------------

  if (writes) {
    app.patch('/fields/:id', { config: { auth: REVIEW } }, async (request) => {
      const { id } = parse(idParamsSchema, request.params);
      const body = parse(reviewFieldBodySchema, request.body);
      if (body.action !== 'edit' && !holds(request, 'reviewer')) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Accepting or rejecting a value needs the reviewer role.',
        );
      }
      const field = await reviewField(db(request), {
        fieldId: id,
        body,
        actor: actorOf(request),
      });
      return fieldView(field);
    });
  }

  app.get('/conflicts', { config: { auth: read } }, async (request) => {
    const query = parse(listConflictsQuerySchema, request.query);
    const conflicts = await db(request).conflicts.list(
      query.status === undefined ? {} : { status: query.status },
    );
    return {
      conflicts: await Promise.all(
        conflicts.map((conflict) => conflictView(db(request), conflict)),
      ),
    };
  });

  if (writes) {
    app.post('/conflicts/:id/resolve', { config: { auth: RESOLVE } }, async (request) => {
      const { id } = parse(idParamsSchema, request.params);
      const body = parse(resolveConflictBodySchema, request.body);
      const resolved = await resolveConflict(db(request), {
        conflictId: id,
        body,
        actor: actorOf(request),
        now: clock(),
      });
      return conflictView(db(request), resolved);
    });
  }

  // ---- register -------------------------------------------------------------------------------

  if (writes) {
    app.post('/register/publish', { config: { auth: PUBLISH } }, async (request, reply) => {
      const published = await publishRegister(db(request), {
        actor: actorOf(request),
        now: clock(),
      });
      return reply
        .status(201)
        .send({ version: versionView(published.version), itemCount: published.items.length });
    });
  }

  app.get('/register/versions', { config: { auth: read } }, async (request) => ({
    versions: (await db(request).register.listPublished()).map(({ version, itemCount }) => ({
      ...versionView(version),
      itemCount,
    })),
  }));

  app.get('/register/versions/:n', { config: { auth: read } }, async (request) => {
    const { n } = parse(exportParamsSchema, request.params);
    const found = await db(request).register.getPublished(n);
    if (found === null) throw notFound('register version');
    return {
      version: versionView(found.version),
      items: found.items.map((item) => ({ tag: item.tag, values: item.values })),
    };
  });

  // What syncing this version to an asset system would send, in the ACC-style contract: computed
  // by the same functions the tested client uses, never sent. No asset system is connected.
  app.get('/register/versions/:n/handoff', { config: { auth: read } }, async (request) => {
    const { n } = parse(exportParamsSchema, request.params);
    const found = await db(request).register.getPublished(n);
    if (found === null || found.version.publishedAt === null) throw notFound('register version');
    const version = {
      number: found.version.number,
      approvedBy: found.version.approvedBy ?? '',
      publishedAt: found.version.publishedAt,
    };
    return {
      contract: 'acc-style-asset-upsert' as const,
      connected: false as const,
      requests: found.items.map((item) => ({
        method: 'POST' as const,
        path: '/assets/upsert' as const,
        idempotencyKey: idempotencyKeyFor(version, item),
        payload: assetPayloadFor(version, { tag: item.tag, values: item.values }),
      })),
    };
  });

  app.get('/register/versions/:n/export', { config: { auth: read } }, async (request, reply) => {
    const { n } = parse(exportParamsSchema, request.params);
    const { format } = parse(exportQuerySchema, request.query);
    const found = await db(request).register.getPublished(n);
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
      `attachment; filename="${mode === 'workspace' ? '' : 'DEMO-'}register-v${String(version.number)}.${exporter.extension}"`,
    );
    return reply.type(exporter.contentType).send(exporter.render(exportable));
  });

  // ---- audit ----------------------------------------------------------------------------------

  app.get('/audit', { config: { auth: read } }, async (request) => {
    const { entity } = parse(auditQuerySchema, request.query);
    const subject: ReviewEventSubject =
      entity.kind === 'field'
        ? { kind: 'field', fieldId: entity.id }
        : entity.kind === 'conflict'
          ? { kind: 'conflict', conflictId: entity.id }
          : { kind: 'register_version', registerVersionId: entity.id };
    const events = await db(request).reviewEvents.listForSubject(subject);
    return { events: events.map(auditView) };
  });

  // ---- admin ----------------------------------------------------------------------------------

  if (mode !== 'workspace') return;
  app.post('/admin/jobs/:id/requeue', { config: { auth: ADMIN } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    if ((await db(request).jobs.getById(id)) === null) throw notFound('job');
    if (!(await db(request).jobs.requeue(id, clock()))) {
      throw new ApiError(409, 'JOB_NOT_DEAD', 'Only a dead job can be requeued.');
    }
    return { jobId: id, status: 'queued' as const };
  });
}

function registerProbes(app: FastifyInstance, deps: AppDeps): void {
  const { database } = deps;
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
}

// Uploads exist only in the workspace: a demo visitor can never cause a model call.
function registerUpload(app: FastifyInstance, deps: AppDeps): void {
  const { database } = deps;
  const upload = createIngestion(database, deps.limits, {
    clock: deps.clock ?? (() => new Date()),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });

  app.post(
    '/documents',
    {
      config: {
        auth: UPLOAD,
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
      if (deps.uploadAllowlist != null && !deps.uploadAllowlist.has(sha256Hex(file.bytes))) {
        throw new ApiError(
          403,
          'UPLOAD_NOT_ALLOWED',
          'This deployment accepts only the synthetic test documents of its corpus.',
        );
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
}
