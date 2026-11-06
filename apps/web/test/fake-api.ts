import type {
  AuditEvent,
  ConflictView,
  DocumentSummary,
  FieldView,
  PublishBlocker,
} from '@specledger/core';
import type { UserRole, UserView } from '@specledger/core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// An in-memory stand-in for the HTTP API, with the server's rules that the UI depends on: roles,
// optimistic versions and their 409, the reason for accepting an unverified value, and publish
// blockers. Responses follow the shared schemas, which the client validates.

export const API = 'http://api.test';
export const PASSWORD = 'correct horse battery staple';

export const DOC_ID = '00000000-0000-4000-8000-0000000000d1';
const RUN_ID = '00000000-0000-4000-8000-0000000000a1';
export const FIELD_IDS = {
  flow: '00000000-0000-4000-8000-0000000000f1',
  head: '00000000-0000-4000-8000-0000000000f2',
  power: '00000000-0000-4000-8000-0000000000f3',
} as const;
export const CONFLICT_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_FIELD = '00000000-0000-4000-8000-0000000000f9';
const OTHER_DOC = '00000000-0000-4000-8000-0000000000d2';
const TIME = '2030-01-01T00:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';

// The page text: the head quote is written with other whitespace than the page.
export const PAGE_1 = [
  'SYNTHETIC TEST DOCUMENT - NOT A REAL PRODUCT',
  'Rated flow: 1997 gpm',
  'Rated   head:',
  '260 ft',
  'Motor power 75 kW',
].join('\n');

export const HOSTILE_PAGE =
  'Rated flow: 1997 gpm <img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> <b>bold</b>';

const field = (overrides: Partial<FieldView> & Pick<FieldView, 'id' | 'name'>): FieldView => ({
  extractionRunId: RUN_ID,
  value: '1',
  unit: 'm',
  quote: '',
  page: 1,
  verificationStatus: 'verified',
  verificationReasons: [],
  reviewStatus: 'pending',
  version: 1,
  ...overrides,
});

function initialFields(): FieldView[] {
  return [
    field({
      id: FIELD_IDS.flow,
      name: 'rated_flow',
      value: '1997',
      unit: 'gpm',
      quote: 'Rated flow: 1997 gpm',
    }),
    field({
      id: FIELD_IDS.head,
      name: 'rated_head',
      value: '260',
      unit: 'ft',
      quote: 'Rated head: 260 ft',
    }),
    field({
      id: FIELD_IDS.power,
      name: 'rated_power',
      value: '90',
      unit: 'kW',
      quote: 'Rated power 90 kW',
      verificationStatus: 'unverified',
      verificationReasons: ['QUOTE_NOT_FOUND', 'VALUE_NOT_IN_QUOTE'],
    }),
  ];
}

function initialConflict(): ConflictView {
  return {
    id: CONFLICT_ID,
    equipmentTag: 'P-106',
    fieldName: 'rated_head',
    status: 'open',
    createdAt: TIME,
    candidates: [
      {
        fieldId: FIELD_IDS.head,
        documentId: DOC_ID,
        documentType: 'datasheet',
        revision: 'Rev A',
        value: '260',
        unit: 'ft',
        quote: 'Rated head: 260 ft',
        page: 1,
        verificationStatus: 'verified',
        reviewStatus: 'pending',
      },
      {
        fieldId: OTHER_FIELD,
        documentId: OTHER_DOC,
        documentType: 'datasheet',
        revision: 'Rev A',
        value: '250',
        unit: 'ft',
        quote: 'Rated head 250 ft',
        page: 2,
        verificationStatus: 'verified',
        reviewStatus: 'pending',
      },
    ],
    suggestion: { fieldId: null, rules: ['EQUAL_RANK_CONFLICT'] },
    resolution: null,
  };
}

export interface FakeOptions {
  readonly documents?: DocumentSummary[];
  readonly page?: string;
  readonly fields?: FieldView[];
  readonly conflicts?: ConflictView[];
  readonly onRequest?: (request: Request) => void;
  // Who is signed in to the workspace, by roles; null for nobody. Default: one user with every
  // role. POST /auth/login signs in USERS[0] with PASSWORD, POST /auth/logout signs out.
  readonly user?: readonly UserRole[] | null;
  // POST /demo/session issues DEMO_TOKEN, or answers with this status.
  readonly demoSessionStatus?: number;
}

// The same data is served on three bases, as the API does: the workspace (for the signed-in
// user, by role), /showcase (reads only, no sign-in) and /demo (the demo token only, as every role
// but admin).

export const DEMO_TOKEN = 'demo.visitor-session-for-tests.1893456000000.signature';

export const document = (overrides: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: DOC_ID,
  originalFilename: 'p-106-datasheet.pdf',
  documentType: 'datasheet',
  revision: 'Rev A',
  pageCount: 1,
  byteSize: 4096,
  sha256: 'a'.repeat(64),
  createdAt: TIME,
  processing: { status: 'succeeded', jobId: null, attempts: 1, lastErrorCode: null },
  ...overrides,
});

const error = (status: number, code: string, message: string, details?: unknown) =>
  HttpResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );

type Role = UserRole;
const ANY: readonly Role[] = ['engineer', 'reviewer', 'approver', 'admin'];
const VISITOR: readonly Role[] = ['engineer', 'reviewer', 'approver'];
export const ALL_ROLES: readonly Role[] = ANY;
const BASES = [API, `${API}/showcase`, `${API}/demo`] as const;

export interface FakeState {
  documents: DocumentSummary[];
  fields: FieldView[];
  conflicts: ConflictView[];
  audit: Map<string, AuditEvent[]>;
  published: number;
  requests: string[];
  uploads: { filename: string; fields: Record<string, string> }[];
  user: UserView | null;
  users: UserView[];
}

export const USERS: readonly UserView[] = [
  {
    id: '00000000-0000-4000-8000-0000000000e1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    roles: ['engineer', 'reviewer', 'approver', 'admin'],
    disabled: false,
    createdAt: TIME,
  },
];

// Installs the handlers on a fresh state and returns that state for assertions.
export function fakeApi(options: FakeOptions = {}): FakeState {
  const state: FakeState = {
    documents: options.documents ?? [document()],
    fields: options.fields ?? initialFields(),
    conflicts: options.conflicts ?? [initialConflict()],
    audit: new Map(),
    published: 0,
    requests: [],
    uploads: [],
    user:
      options.user === null || USERS[0] === undefined
        ? null
        : { ...USERS[0], roles: [...(options.user ?? ANY)] },
    users: USERS.map((u) => ({ ...u, roles: [...u.roles] })),
  };
  const page = options.page ?? PAGE_1;
  const record = (entity: string, event: Omit<AuditEvent, 'id' | 'createdAt'>) => {
    const events = state.audit.get(entity) ?? [];
    const n = String(events.length + 1).padStart(12, '0');
    events.push({ id: `00000000-0000-4000-8000-${n}`, createdAt: TIME, ...event });
    state.audit.set(entity, events);
  };
  const seen = (request: Request) => {
    state.requests.push(`${request.method} ${new URL(request.url).pathname}`);
    options.onRequest?.(request);
  };

  // The roles a request acts with, by the base it was sent to, or the refusal.
  const refuse = (request: Request, allowed: readonly Role[]) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/showcase/')) {
      return request.method === 'GET' ? null : error(404, 'NOT_FOUND', 'There is no such route.');
    }
    let roles: readonly Role[];
    if (path.startsWith('/demo/')) {
      if (request.headers.get('authorization') !== `Bearer ${DEMO_TOKEN}`) {
        return error(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      }
      roles = VISITOR;
    } else {
      if (state.user === null) return error(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      if (request.method !== 'GET' && request.headers.get('x-requested-with') !== 'specledger') {
        return error(403, 'FORBIDDEN', 'The request is missing its anti-forgery header.');
      }
      roles = state.user.roles;
    }
    return roles.some((role) => allowed.includes(role))
      ? null
      : error(403, 'FORBIDDEN', 'Your role may not do this.');
  };
  const signedIn = () => (state.user === null ? null : { user: state.user, expiresAt: LATER });

  {
    const status = options.demoSessionStatus ?? 201;
    server.use(
      http.post(`${API}/demo/session`, ({ request }) => {
        seen(request);
        return status === 201
          ? HttpResponse.json(
              { token: DEMO_TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
              { status },
            )
          : error(
              status,
              status === 404 ? 'NOT_FOUND' : status === 503 ? 'DEMO_NOT_READY' : 'RATE_LIMITED',
              'Refused.',
            );
      }),
      http.get(`${API}/auth/me`, ({ request }) => {
        seen(request);
        const me = signedIn();
        return me === null
          ? error(401, 'UNAUTHENTICATED', 'Sign in to continue.')
          : HttpResponse.json(me);
      }),
      http.post(`${API}/auth/login`, async ({ request }) => {
        seen(request);
        const body = (await request.json()) as { email: string; password: string };
        if (body.email !== USERS[0]?.email || body.password !== PASSWORD) {
          return error(401, 'UNAUTHENTICATED', 'The email or password is incorrect.');
        }
        state.user = { ...USERS[0], roles: [...USERS[0].roles] };
        return HttpResponse.json(signedIn());
      }),
      http.post(`${API}/auth/logout`, ({ request }) => {
        seen(request);
        state.user = null;
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${API}/admin/demo/reset`, ({ request }) => {
        seen(request);
        return refuse(request, ['admin']) ?? HttpResponse.json({ status: 'reset', queued: 7 });
      }),
      http.get(`${API}/admin/users`, ({ request }) => {
        seen(request);
        return refuse(request, ['admin']) ?? HttpResponse.json({ users: state.users });
      }),
      http.post(`${API}/admin/users`, async ({ request }) => {
        seen(request);
        const denied = refuse(request, ['admin']);
        if (denied !== null) return denied;
        const body = (await request.json()) as {
          email: string;
          displayName: string;
          roles: Role[];
        };
        if (state.users.some((u) => u.email === body.email)) {
          return error(409, 'EMAIL_TAKEN', 'An account with this email exists.');
        }
        const created: UserView = {
          id: `00000000-0000-4000-8000-${String(state.users.length + 1).padStart(12, '0')}`,
          email: body.email,
          displayName: body.displayName,
          roles: body.roles,
          disabled: false,
          createdAt: TIME,
        };
        state.users.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
      http.patch(`${API}/admin/users/:id`, async ({ request, params }) => {
        seen(request);
        const denied = refuse(request, ['admin']);
        if (denied !== null) return denied;
        const body = (await request.json()) as { roles?: Role[]; disabled?: boolean };
        const index = state.users.findIndex((u) => u.id === params.id);
        const found = state.users[index];
        if (found === undefined) return error(404, 'NOT_FOUND', 'There is no such user.');
        const updated = { ...found, ...body };
        state.users[index] = updated;
        return HttpResponse.json(updated);
      }),
    );
  }
  for (const base of BASES)
    server.use(
      http.post(`${base}/documents`, async ({ request }) => {
        seen(request);
        const denied = refuse(request, ['engineer']);
        if (denied !== null) return denied;
        const form = await request.formData();
        // Parsed by Node's fetch, so the part is Node's File, not jsdom's: check its shape.
        const file = form.get('file');
        if (file === null || typeof file === 'string') {
          return error(400, 'VALIDATION_FAILED', 'The request is invalid.');
        }
        state.uploads.push({
          filename: file.name,
          fields: Object.fromEntries(
            [...form.entries()].flatMap(([name, value]) =>
              typeof value === 'string' ? [[name, value]] : [],
            ),
          ),
        });
        if (file.name === 'real-vendor.pdf') {
          return error(
            403,
            'UPLOAD_NOT_ALLOWED',
            'This deployment accepts only the synthetic test documents of its corpus.',
          );
        }
        const duplicate = state.documents.some((d) => d.originalFilename === file.name);
        const uploaded = document({
          id: '00000000-0000-4000-8000-0000000000d9',
          originalFilename: file.name,
          processing: { status: 'queued', jobId: null, attempts: 0, lastErrorCode: null },
        });
        if (!duplicate) state.documents.unshift(uploaded);
        return HttpResponse.json(
          {
            document: duplicate
              ? state.documents.find((d) => d.originalFilename === file.name)
              : uploaded,
            duplicate,
          },
          { status: duplicate ? 200 : 202 },
        );
      }),
      http.get(`${base}/documents`, ({ request }) => {
        seen(request);
        return refuse(request, ANY) ?? HttpResponse.json({ documents: state.documents });
      }),
      http.get(`${base}/documents/:id`, ({ request, params }) => {
        seen(request);
        const found = state.documents.find((d) => d.id === params.id);
        return (
          refuse(request, ANY) ??
          (found === undefined
            ? error(404, 'NOT_FOUND', 'The document does not exist.')
            : HttpResponse.json(found))
        );
      }),
      http.get(`${base}/documents/:id/fields`, ({ request }) => {
        seen(request);
        return refuse(request, ANY) ?? HttpResponse.json({ fields: state.fields });
      }),
      http.get(`${base}/documents/:id/pages/:n`, ({ request, params }) => {
        seen(request);
        return (
          refuse(request, ANY) ??
          HttpResponse.json({ documentId: params.id, pageNumber: Number(params.n), content: page })
        );
      }),
      http.patch(`${base}/fields/:id`, async ({ request, params }) => {
        seen(request);
        const denied = refuse(request, ['engineer', 'reviewer']);
        if (denied !== null) return denied;
        const body = (await request.json()) as {
          action: 'accept' | 'reject' | 'edit';
          expectedVersion: number;
          value?: string;
          unit?: string;
          reason?: string;
        };
        const index = state.fields.findIndex((f) => f.id === params.id);
        const current = state.fields[index];
        if (current === undefined) return error(404, 'NOT_FOUND', 'The field does not exist.');
        if (current.version !== body.expectedVersion) {
          return error(409, 'VERSION_CONFLICT', 'The field changed since it was read.', {
            current,
          });
        }
        if (body.action === 'accept' && current.verificationStatus !== 'verified' && !body.reason) {
          return error(400, 'REASON_REQUIRED', 'Accepting an unverified value requires a reason.');
        }
        const status = { accept: 'accepted', reject: 'rejected', edit: 'edited' } as const;
        const next: FieldView = {
          ...current,
          reviewStatus: status[body.action],
          ...(body.action === 'edit' ? { value: body.value ?? '', unit: body.unit ?? '' } : {}),
          version: current.version + 1,
        };
        state.fields[index] = next;
        record(`field:${current.id}`, {
          actor: 'role:engineer',
          action: body.action,
          before: { reviewStatus: current.reviewStatus, value: current.value },
          after: { reviewStatus: next.reviewStatus, value: next.value },
          reason: body.reason ?? null,
        });
        return HttpResponse.json(next);
      }),
      http.get(`${base}/conflicts`, ({ request }) => {
        seen(request);
        const status = new URL(request.url).searchParams.get('status');
        return (
          refuse(request, ANY) ??
          HttpResponse.json({
            conflicts: state.conflicts.filter((c) => status === null || c.status === status),
          })
        );
      }),
      http.post(`${base}/conflicts/:id/resolve`, async ({ request, params }) => {
        seen(request);
        const denied = refuse(request, ['reviewer']);
        if (denied !== null) return denied;
        const body = (await request.json()) as {
          choice:
            { kind: 'candidate'; fieldId: string } | { kind: 'value'; value: string; unit: string };
          reason: string;
        };
        const index = state.conflicts.findIndex((c) => c.id === params.id);
        const conflict = state.conflicts[index];
        if (conflict === undefined) return error(404, 'NOT_FOUND', 'The conflict does not exist.');
        if (conflict.status !== 'open') {
          return error(409, 'CONFLICT_ALREADY_RESOLVED', 'The conflict is already resolved.');
        }
        const chosen =
          body.choice.kind === 'candidate'
            ? conflict.candidates.find(
                (c) => c.fieldId === (body.choice as { fieldId: string }).fieldId,
              )
            : undefined;
        const value = body.choice.kind === 'value' ? body.choice : chosen;
        if (value === undefined) {
          return error(400, 'CANDIDATE_NOT_IN_CONFLICT', 'The chosen field is not a candidate.');
        }
        const resolved: ConflictView = {
          ...conflict,
          status: 'resolved',
          resolution: {
            reason: body.reason,
            resolvedAt: TIME,
            resolvedBy: 'role:engineer',
            chosenFieldId: chosen?.fieldId ?? null,
            value: value.value,
            unit: value.unit,
          },
        };
        state.conflicts[index] = resolved;
        record(`conflict:${conflict.id}`, {
          actor: 'role:engineer',
          action: 'resolve',
          before: { status: 'open' },
          after: { status: 'resolved', value: value.value },
          reason: body.reason,
        });
        return HttpResponse.json(resolved);
      }),
      http.post(`${base}/register/publish`, ({ request }) => {
        seen(request);
        const denied = refuse(request, ['approver']);
        if (denied !== null) return denied;
        const blockers: PublishBlocker[] = [
          ...state.fields
            .filter((f) => f.reviewStatus === 'pending')
            .map((f) => ({
              kind: 'FIELD_PENDING_REVIEW' as const,
              subjectId: f.id,
              equipmentTag: 'P-106',
              fieldName: f.name,
            })),
          ...state.conflicts
            .filter((c) => c.status === 'open')
            .map((c) => ({
              kind: 'CONFLICT_OPEN' as const,
              subjectId: c.id,
              equipmentTag: c.equipmentTag,
              fieldName: c.fieldName,
            })),
        ];
        if (blockers.length > 0) {
          return error(409, 'PUBLISH_BLOCKED', 'The register cannot be published yet.', {
            blockers,
          });
        }
        state.published += 1;
        return HttpResponse.json(
          {
            version: {
              id: '00000000-0000-4000-8000-0000000000b1',
              number: state.published,
              approvedBy: 'role:approver',
              publishedAt: TIME,
            },
            itemCount: 1,
          },
          { status: 201 },
        );
      }),
      http.get(`${base}/audit`, ({ request }) => {
        seen(request);
        const entity = new URL(request.url).searchParams.get('entity') ?? '';
        return refuse(request, ANY) ?? HttpResponse.json({ events: state.audit.get(entity) ?? [] });
      }),
    );
  return state;
}

export const server = setupServer();
