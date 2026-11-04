import type { ApiErrorCode } from '@specledger/core';

// An expected failure of a request: a stable code, its HTTP status, a fixed message and optional
// details that contain ids and codes only. The error handler sends it as
// {"error": {"code", "message", "details"?}}.
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) =>
  new ApiError(404, 'NOT_FOUND', `The ${what} does not exist.`);
