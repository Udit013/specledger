import type {
  ConflictView,
  DocumentSummary,
  FieldView,
  ResolveConflictBody,
  ReviewFieldBody,
} from '@specledger/core';
import { notImplemented } from '../lib/not-implemented.js';
import type { Tokens } from '../lib/tokens.js';
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
export class ApiClientError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly details: unknown;
  readonly currentField: FieldView | null = null;
  constructor(
    kind: ApiErrorKind,
    message: string,
    status: number | null,
    code: string | null,
    details: unknown,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly tokens: () => Tokens;
  readonly fetch?: typeof fetch;
}
export function createApiClient(options: ApiClientOptions) {
  const stub = (name: string) => (): Promise<never> =>
    Promise.reject(new Error(`${name} is not implemented yet ${options.baseUrl}`));
  return {
    listDocuments: stub('listDocuments') as () => Promise<DocumentSummary[]>,
    getDocument: stub('getDocument') as (id: string) => Promise<DocumentSummary>,
    getPage: stub('getPage') as (
      id: string,
      n: number,
    ) => Promise<{ documentId: string; pageNumber: number; content: string }>,
    listFields: stub('listFields') as (id: string) => Promise<FieldView[]>,
    reviewField: stub('reviewField') as (id: string, body: ReviewFieldBody) => Promise<FieldView>,
    listConflicts: stub('listConflicts') as () => Promise<ConflictView[]>,
    resolveConflict: stub('resolveConflict') as (
      id: string,
      body: ResolveConflictBody,
    ) => Promise<ConflictView>,
    publish: stub('publish') as () => Promise<unknown>,
    audit: stub('audit') as (kind: string, id: string) => Promise<unknown>,
  };
}
export const unused = notImplemented;
