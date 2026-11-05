import type { Database } from '@specledger/db';
import type { IngestLimits } from '@specledger/ingest';
import type { FastifyBaseLogger } from 'fastify';

import type { ApiTokens } from './auth.js';

export interface HttpOptions {
  // Origins allowed by CORS; empty allows none.
  readonly corsOrigins: readonly string[];
  // Passed to Fastify's trustProxy: false (default), true, or the number of hops to trust.
  readonly trustProxy: boolean | number;
  readonly rateLimitPerMinute: number;
  readonly uploadRateLimitPerMinute: number;
  readonly requestTimeoutMs: number;
  // JSON bodies; uploads are limited by limits.maxBytes.
  readonly bodyLimitBytes: number;
  readonly readyTimeoutMs: number;
}

export interface AppDeps {
  readonly database: Database;
  readonly tokens: ApiTokens;
  readonly limits: IngestLimits;
  readonly http: HttpOptions;
  readonly logger?: FastifyBaseLogger;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  // When set, only uploads whose sha256 is in the set are accepted (UPLOAD_ALLOWLIST=corpus): a
  // public demo then never stores, queues or sends to the model anything but the synthetic corpus.
  readonly uploadAllowlist?: ReadonlySet<string> | null;
}
