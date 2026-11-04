import type { Result } from '@specledger/core';
import { notImplemented } from '../not-implemented.js';
import type { AssetPayload } from './contract.js';
import type { DriftReport } from './drift.js';
export interface HttpAssetClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxRetryAfterMs?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}
export interface UpsertedAsset {
  readonly assetId: string;
  readonly externalId: string;
  readonly revision: number;
  readonly created: boolean;
  readonly attempts: number;
  readonly drift: DriftReport;
}
export type AssetErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'RESPONSE_SCHEMA_DRIFT'
  | 'UNEXPECTED_STATUS'
  | 'ABORTED';
export interface AssetError {
  readonly code: AssetErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly status: number | null;
  readonly retryAfterMs?: number;
  readonly fields?: readonly string[];
  readonly drift?: DriftReport;
}
export interface AssetSystemClient {
  upsertAsset(
    payload: AssetPayload,
    idempotencyKey: string,
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<Result<UpsertedAsset, AssetError>>;
}
export function createHttpAssetClient(options: HttpAssetClientOptions): AssetSystemClient {
  return {
    upsertAsset: (...args) => Promise.resolve(notImplemented('upsertAsset', options, ...args)),
  };
}
