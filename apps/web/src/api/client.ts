import {
  apiErrorSchema,
  auditListSchema,
  conflictListSchema,
  conflictSchema,
  documentListSchema,
  documentSummarySchema,
  fieldListSchema,
  fieldSchema,
  pageSchema,
  publishResponseSchema,
  reviewFieldBodySchema,
  resolveConflictBodySchema,
  uploadFieldsSchema,
  uploadResponseSchema,
} from '@specledger/core';
import { publishBlockerSchema } from '@specledger/core';
import type {
  AuditEvent,
  ConflictView,
  DocumentSummary,
  FieldView,
  PublishBlocker,
  ResolveConflictBody,
  ReviewFieldBody,
} from '@specledger/core';
import { z } from 'zod';

import type { Tokens } from '../lib/tokens.js';

// What the upload screen collects, before it is checked against the shared upload schema.
export interface UploadRequest {
  readonly documentType: 'datasheet' | 'manual' | 'brochure';
  readonly revision: string;
  readonly equipmentTag: string;
  readonly equipmentClass: 'centrifugal_pump' | 'electric_motor';
  readonly synthetic: boolean;
}

export type ApiErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response';

// Every failure of a request, with a message written for the reviewer. The server's own message is
// used only for codes the UI has no wording for.
export class ApiClientError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly details: unknown;
  // For a 409 VERSION_CONFLICT: the field as the server has it now.
  readonly currentField: FieldView | null;
  // For a 409 PUBLISH_BLOCKED: what stands in the way.
  readonly blockers: readonly PublishBlocker[];

  constructor(
    kind: ApiErrorKind,
    message: string,
    status: number | null,
    code: string | null,
    details: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.details = details;
    const current = z.object({ current: fieldSchema }).safeParse(details);
    this.currentField = current.success ? current.data.current : null;
    const blocked = z.object({ blockers: z.array(publishBlockerSchema) }).safeParse(details);
    this.blockers = blocked.success ? blocked.data.blockers : [];
  }
}

// The most documents the list asks for (the API's maximum page size).
export const DOCUMENT_PAGE_SIZE = 100;

type Role = 'engineer' | 'approver';

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly tokens: () => Tokens;
  readonly fetch?: typeof fetch;
}

const MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: 'Your API token is missing or was not accepted. Enter a valid token.',
  FORBIDDEN:
    'Your token’s role is not allowed to do this. Uploads, reviews and resolutions need the engineer token; publishing needs the approver token.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  INTERNAL: 'The server hit an unexpected error. Try again.',
  NOT_READY: 'The server is not ready. Try again shortly.',
};

function kindFor(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'validation';
}

// A typed client over the shared Zod schemas: request bodies are checked before they are sent and
// every response is validated before the UI sees it. Each call names the role it needs; the token
// for that role is sent if present, otherwise the other one, so the server answers 403 rather than
// the client guessing.
export function createApiClient(options: ApiClientOptions) {
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<S extends z.ZodType>(
    schema: S,
    path: string,
    init: { method?: string; body?: unknown; form?: FormData; role?: Role } = {},
  ): Promise<z.output<S>> {
    const tokens = options.tokens();
    const role = init.role ?? 'engineer';
    const token =
      role === 'approver'
        ? (tokens.approver ?? tokens.engineer)
        : (tokens.engineer ?? tokens.approver);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    // A form sets its own multipart content type, with the boundary.
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await send(`${options.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.form !== undefined
          ? { body: init.form }
          : init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new ApiClientError('network', 'The server could not be reached.', null, null, null);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(json);
      const code = parsed.success ? parsed.data.error.code : 'UNKNOWN';
      const message =
        MESSAGES[code] ??
        (parsed.success ? parsed.data.error.message : 'The request failed unexpectedly.');
      throw new ApiClientError(
        kindFor(response.status),
        message,
        response.status,
        code,
        parsed.success ? parsed.data.error.details : null,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiClientError(
        'invalid_response',
        'The server sent a response this screen does not understand.',
        response.status,
        null,
        null,
      );
    }
    return parsed.data;
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    async listDocuments(): Promise<DocumentSummary[]> {
      return (await request(documentListSchema, `/documents?limit=${String(DOCUMENT_PAGE_SIZE)}`))
        .documents;
    },
    uploadDocument(file: File, fields: UploadRequest) {
      const form = new FormData();
      const checked = uploadFieldsSchema.parse({
        documentType: fields.documentType,
        revision: fields.revision,
        equipmentTag: fields.equipmentTag,
        equipmentClass: fields.equipmentClass,
        synthetic: fields.synthetic ? 'true' : 'false',
      });
      form.set('documentType', checked.documentType);
      if (checked.revision !== null) form.set('revision', checked.revision);
      form.set('equipmentTag', checked.equipmentTag);
      form.set('equipmentClass', checked.equipmentClass);
      form.set('synthetic', String(checked.synthetic));
      form.set('file', file, file.name);
      return request(uploadResponseSchema, '/documents', {
        method: 'POST',
        form,
        role: 'engineer',
      });
    },
    getDocument(documentId: string): Promise<DocumentSummary> {
      return request(documentSummarySchema, `/documents/${id(documentId)}`);
    },
    getPage(documentId: string, n: number) {
      return request(pageSchema, `/documents/${id(documentId)}/pages/${String(n)}`);
    },
    async listFields(documentId: string): Promise<FieldView[]> {
      return (await request(fieldListSchema, `/documents/${id(documentId)}/fields`)).fields;
    },
    reviewField(fieldId: string, body: ReviewFieldBody): Promise<FieldView> {
      return request(fieldSchema, `/fields/${id(fieldId)}`, {
        method: 'PATCH',
        body: reviewFieldBodySchema.parse(body),
        role: 'engineer',
      });
    },
    async listConflicts(status: 'open' | 'resolved' = 'open'): Promise<ConflictView[]> {
      return (await request(conflictListSchema, `/conflicts?status=${status}`)).conflicts;
    },
    resolveConflict(conflictId: string, body: ResolveConflictBody): Promise<ConflictView> {
      return request(conflictSchema, `/conflicts/${id(conflictId)}/resolve`, {
        method: 'POST',
        body: resolveConflictBodySchema.parse(body),
        role: 'engineer',
      });
    },
    publish() {
      return request(publishResponseSchema, '/register/publish', {
        method: 'POST',
        role: 'approver',
      });
    },
    async audit(
      kind: 'field' | 'conflict' | 'register_version',
      entityId: string,
    ): Promise<AuditEvent[]> {
      const entity = encodeURIComponent(`${kind}:${entityId}`);
      return (await request(auditListSchema, `/audit?entity=${entity}`)).events;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
