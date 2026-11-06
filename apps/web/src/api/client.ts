import {
  createUserBodySchema,
  loginBodySchema,
  meSchema,
  updateUserBodySchema,
  userListSchema,
  userViewSchema,
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
  CreateUserBody,
  MeBody,
  UpdateUserBody,
  UserView,
  AuditEvent,
  ConflictView,
  DocumentSummary,
  FieldView,
  PublishBlocker,
  ResolveConflictBody,
  ReviewFieldBody,
} from '@specledger/core';
import { z } from 'zod';

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

export interface ApiClientOptions {
  readonly baseUrl: string;
  // The demo sandbox's bearer token, read (and started or renewed) before every request. Without
  // it, requests carry the browser's session cookie, if any: the token never touches script.
  readonly bearer?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  // Errors speak of the demo session in a sandbox. A refused credential is reported, so that the
  // app can drop the demo session or the signed-in user.
  readonly demo?: boolean;
  readonly onUnauthenticated?: () => void;
}

const MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  FORBIDDEN: 'Your role does not allow this.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  INTERNAL: 'The server hit an unexpected error. Try again.',
  NOT_READY: 'The server is not ready. Try again shortly.',
};

const DEMO_MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: 'Your demo session ended. Try again to start a new one.',
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
// every response is validated before the UI sees it. Every request carries the anti-forgery
// header the API requires of cookie-authenticated writes; the server decides what a role may do.
export function createApiClient(options: ApiClientOptions) {
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<S extends z.ZodType>(
    schema: S,
    path: string,
    // signIn: a 401 is a wrong password, not an ended session; the server's message is shown.
    init: { method?: string; body?: unknown; form?: FormData; signIn?: boolean } = {},
  ): Promise<z.output<S>> {
    let token: string | null = null;
    if (options.bearer !== undefined) {
      try {
        token = await options.bearer();
      } catch (error: unknown) {
        throw new ApiClientError(
          'network',
          error instanceof Error ? error.message : 'The server could not be reached.',
          null,
          null,
          null,
        );
      }
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-requested-with': 'specledger',
    };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    // A form sets its own multipart content type, with the boundary.
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await send(`${options.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        credentials: 'same-origin',
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
      if (response.status === 401 && init.signIn !== true) options.onUnauthenticated?.();
      const message =
        (init.signIn === true && parsed.success ? parsed.data.error.message : undefined) ??
        (options.demo === true ? DEMO_MESSAGES[code] : undefined) ??
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
      });
    },
    async listConflicts(status: 'open' | 'resolved' = 'open'): Promise<ConflictView[]> {
      return (await request(conflictListSchema, `/conflicts?status=${status}`)).conflicts;
    },
    resolveConflict(conflictId: string, body: ResolveConflictBody): Promise<ConflictView> {
      return request(conflictSchema, `/conflicts/${id(conflictId)}/resolve`, {
        method: 'POST',
        body: resolveConflictBodySchema.parse(body),
      });
    },
    publish() {
      return request(publishResponseSchema, '/register/publish', {
        method: 'POST',
      });
    },
    // ---- accounts --------------------------------------------------------------------------------
    // A 204 has no body; these two parse an empty object instead.
    me(): Promise<MeBody> {
      return request(meSchema, '/auth/me');
    },
    login(email: string, password: string): Promise<MeBody> {
      return request(meSchema, '/auth/login', {
        method: 'POST',
        signIn: true,
        body: loginBodySchema.parse({ email, password }),
      });
    },
    async logout(): Promise<void> {
      await request(z.unknown(), '/auth/logout', { method: 'POST' });
    },
    async listUsers(): Promise<UserView[]> {
      return (await request(userListSchema, '/admin/users')).users;
    },
    createUser(body: CreateUserBody): Promise<UserView> {
      return request(userViewSchema, '/admin/users', {
        method: 'POST',
        body: createUserBodySchema.parse(body),
      });
    },
    updateUser(id: string, body: UpdateUserBody): Promise<UserView> {
      return request(userViewSchema, `/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: updateUserBodySchema.parse(body),
      });
    },
    resetDemo(): Promise<unknown> {
      return request(
        z.object({ status: z.literal('reset'), queued: z.number() }),
        '/admin/demo/reset',
        {
          method: 'POST',
        },
      );
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
