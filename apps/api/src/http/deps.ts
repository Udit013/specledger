import type { Database } from '@specledger/db';
import type { IngestLimits } from '@specledger/ingest';
import type { FastifyBaseLogger } from 'fastify';

import type { DemoSessions } from '../demo/session.js';
import type { Sandboxes } from '../demo/sandboxes.js';

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

export interface AuthOptions {
  // How long a sign-in lasts.
  readonly sessionTtlMs: number;
  // Secure cookies (HTTPS only); off only for local development over http.
  readonly secureCookies: boolean;
  // Sign-in attempts per client and minute.
  readonly loginRateLimitPerMinute: number;
}

export interface AppDeps {
  readonly database: Database;
  readonly auth: AuthOptions;
  readonly limits: IngestLimits;
  readonly http: HttpOptions;
  readonly logger?: FastifyBaseLogger;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  // When set, only uploads whose sha256 is in the set are accepted (UPLOAD_ALLOWLIST=corpus): a
  // public deployment then never stores, queues or sends to the model anything but the corpus.
  readonly uploadAllowlist?: ReadonlySet<string> | null;
  // The public demo, when configured (DEMO_DATABASE_URL). Absent, there are no demo routes.
  readonly demo?: DemoDeps | null;
}

export interface DemoDeps {
  // The showcase: the demo database's own schema, extracted once, read-only to visitors.
  readonly showcase: Database;
  readonly sessions: DemoSessions;
  readonly sandboxes: Sandboxes;
  // Whether the showcase has documents and none is still being extracted.
  isReady(): Promise<boolean>;
  // Wipes the showcase and seeds it again; resolves to how many documents it queued.
  reset(): Promise<number>;
}
