import { err, ok } from '@specledger/core';
import type { Result } from '@specledger/core';
import { z } from 'zod';

import {
  ASSET_RESPONSE_SHAPE,
  assetPayloadSchema,
  assetResponseSchema,
  IDEMPOTENCY_KEY,
} from './contract.js';
import type { AssetPayload } from './contract.js';
import { detectDrift } from './drift.js';
import type { DriftReport } from './drift.js';
import { parseRetryAfter } from './retry-after.js';

// The port: write one asset to the target system, idempotently.
export interface AssetSystemClient {
  upsertAsset(
    payload: AssetPayload,
    idempotencyKey: string,
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<Result<UpsertedAsset, AssetError>>;
}

export interface UpsertedAsset {
  readonly assetId: string;
  readonly externalId: string;
  readonly revision: number;
  readonly created: boolean;
  readonly attempts: number;
  // Extra fields the response carried beyond the contract; empty when it matched exactly.
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
  // Whether trying again later could succeed. The client has already retried what it could.
  readonly retryable: boolean;
  readonly attempts: number;
  readonly status: number | null;
  readonly retryAfterMs?: number;
  // Paths the target refused (VALIDATION_FAILED), never their values.
  readonly fields?: readonly string[];
  readonly drift?: DriftReport;
}

export interface HttpAssetClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  // Per attempt, covering the response body.
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  // A Retry-After longer than this is not waited for: the call fails with retryAfterMs set.
  readonly maxRetryAfterMs?: number;
  // Full-jitter exponential backoff when the target gives no Retry-After.
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

const MESSAGES: Readonly<Record<AssetErrorCode, string>> = {
  VALIDATION_FAILED: 'The asset was refused as invalid.',
  UNAUTHORIZED: 'The asset system refused the credentials.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was already used for a different asset payload.',
  RATE_LIMITED: 'The asset system is rate limiting requests.',
  UNAVAILABLE: 'The asset system is unavailable.',
  TIMEOUT: 'The asset system did not answer in time.',
  NETWORK: 'The asset system could not be reached.',
  RESPONSE_SCHEMA_DRIFT: 'The asset system answered in a shape the contract does not describe.',
  UNEXPECTED_STATUS: 'The asset system answered with an unexpected status.',
  ABORTED: 'The request was cancelled.',
};

const failure = (
  code: AssetErrorCode,
  retryable: boolean,
  attempts: number,
  status: number | null,
  extra: Partial<Pick<AssetError, 'retryAfterMs' | 'fields' | 'drift'>> = {},
): Result<never, AssetError> =>
  err({ code, message: MESSAGES[code], retryable, attempts, status, ...extra });

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const fieldsSchema = z.object({ error: z.object({ fields: z.array(z.string()).max(100) }) });

type Attempt =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly retryAfter: string | null;
      readonly body: unknown;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' }
  | { readonly kind: 'aborted' };

// The HTTP adapter. Retries are safe only because every attempt carries the same Idempotency-Key:
// a retry after a lost response is answered from the target's record instead of writing twice.
// 429 and 503 are retried, honouring Retry-After up to the cap; timeouts and network failures are
// retried with backoff; every other 4xx and 5xx is final.
export function createHttpAssetClient(options: HttpAssetClientOptions): AssetSystemClient {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
  const backoff = options.backoff ?? { baseMs: 250, maxMs: 5_000 };
  const url = `${options.baseUrl.replace(/\/$/, '')}/assets/upsert`;

  const backoffMs = (attempt: number) =>
    Math.floor(random() * Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempt - 1)));

  async function attemptOnce(
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, timeoutMs);
    const combined =
      signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
    try {
      const response = await send(url, { method: 'POST', headers, body, signal: combined });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      return {
        kind: 'response',
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        body: parsed,
      };
    } catch {
      if (signal?.aborted === true) return { kind: 'aborted' };
      if (timeout.signal.aborted) return { kind: 'timeout' };
      return { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async upsertAsset(payload, idempotencyKey, call = {}) {
      const checked = assetPayloadSchema.safeParse(payload);
      if (!checked.success || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        const fields = checked.success
          ? ['idempotencyKey']
          : checked.error.issues.map((issue) => issue.path.map(String).join('.'));
        return failure('VALIDATION_FAILED', false, 0, null, { fields });
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
      };
      if (call.correlationId !== undefined) headers['x-correlation-id'] = call.correlationId;
      if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
      const body = JSON.stringify(checked.data);

      for (let attempt = 1; ; attempt += 1) {
        if (call.signal?.aborted === true) return failure('ABORTED', false, attempt - 1, null);
        const outcome = await attemptOnce(body, headers, call.signal);
        const last = attempt >= maxAttempts;
        let wait: number;

        if (outcome.kind === 'aborted') return failure('ABORTED', false, attempt, null);
        if (outcome.kind === 'timeout' || outcome.kind === 'network') {
          const code = outcome.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK';
          if (last) return failure(code, true, attempt, null);
          wait = backoffMs(attempt);
        } else {
          const { status } = outcome;
          if (status >= 200 && status < 300) {
            const drift = detectDrift(ASSET_RESPONSE_SHAPE, outcome.body);
            const parsed = assetResponseSchema.safeParse(outcome.body);
            if (!drift.compatible || !parsed.success) {
              return failure('RESPONSE_SCHEMA_DRIFT', false, attempt, status, { drift });
            }
            return ok({ ...parsed.data, attempts: attempt, drift });
          }
          if (status === 400 || status === 422) {
            const fields = fieldsSchema.safeParse(outcome.body);
            return failure('VALIDATION_FAILED', false, attempt, status, {
              fields: fields.success ? fields.data.error.fields : [],
            });
          }
          if (status === 401 || status === 403)
            return failure('UNAUTHORIZED', false, attempt, status);
          if (status === 409) return failure('IDEMPOTENCY_CONFLICT', false, attempt, status);
          if (status !== 429 && status !== 503) {
            return failure('UNEXPECTED_STATUS', false, attempt, status);
          }
          const code = status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE';
          const advised = parseRetryAfter(outcome.retryAfter, now());
          if (advised !== null && advised > maxRetryAfterMs) {
            return failure(code, true, attempt, status, { retryAfterMs: advised });
          }
          if (last) {
            return failure(
              code,
              true,
              attempt,
              status,
              advised === null ? {} : { retryAfterMs: advised },
            );
          }
          wait = advised ?? backoffMs(attempt);
        }
        await sleep(wait, call.signal);
      }
    },
  };
}
