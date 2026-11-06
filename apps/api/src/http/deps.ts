import type { Database } from '@specledger/db';
import type { IngestLimits } from '@specledger/ingest';
import type { FastifyBaseLogger } from 'fastify';

import type { DemoSessions } from '../demo/session.js';
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
  // The demo workspace, when configured (DEMO_DATABASE_URL): its own database and visitor
  // sessions, mounted under /demo. Absent, there are no /demo routes at all.
  readonly demo?: DemoDeps | null;
}

export interface DemoDeps {
  // Never the production database.
  readonly database: Database;
  readonly sessions: DemoSessions;
  // Always enforced in the demo, whatever uploadAllowlist above says.
  readonly uploadAllowlist: ReadonlySet<string>;
  // Wipes the demo database and seeds its curated documents again; resolves to how many it queued.
  reset(): Promise<number>;
}
