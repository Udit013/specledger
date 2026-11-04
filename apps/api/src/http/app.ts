import type { Database } from '@specledger/db';
import type { IngestLimits } from '@specledger/ingest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { notImplemented } from '../not-implemented.js';
import type { ApiTokens, RouteAuth } from './auth.js';

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
}

export interface RouteInfo {
  readonly method: string;
  readonly url: string;
  readonly auth: RouteAuth;
}

declare module 'fastify' {
  interface FastifyInstance {
    // Every registered route with its declared auth, for the authorization matrix.
    routeTable: readonly RouteInfo[];
  }
}

// The HTTP API (spec 6.3), ready for app.inject in tests or app.listen in main. Nothing listens
// until the caller does.
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  await Promise.resolve();
  return notImplemented('buildApp', deps);
}
