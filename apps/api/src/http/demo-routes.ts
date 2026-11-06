import type { FastifyInstance } from 'fastify';

import type { DemoSessions } from '../demo/session.js';
import { DemoFullError, schemaFor } from '../demo/sandboxes.js';
import { registerAuth } from './auth.js';
import type { Authenticate, Role } from './auth.js';
import type { AppDeps, DemoDeps } from './deps.js';
import { ApiError } from './errors.js';
import { registerRoutes } from './routes.js';

// Sessions one client may start per minute. Each one copies the showcase into a new schema.
export const DEMO_SESSION_RATE_LIMIT_PER_MINUTE = 10;

// What a demo visitor may do in their own sandbox: everything but administration.
const VISITOR: readonly Role[] = ['engineer', 'reviewer', 'approver'];
const ADMIN: readonly Role[] = ['admin'];
// Demo sessions travel only in the Authorization header; this cookie name is never set.
const NO_COOKIE = 'specledger_demo_unused';

export function demoAuthenticator(sessions: DemoSessions): Authenticate {
  return ({ token, via }) => {
    const session = sessions.verify(token);
    return Promise.resolve(
      session === null
        ? null
        : {
            roles: VISITOR,
            actor: `demo:${session.sessionId}`,
            sandbox: schemaFor(session.sessionId, session.expiresAt),
            via,
          },
    );
  };
}

// The public showcase under /showcase: the read-only routes on the demo database, no sign-in.
export function registerShowcaseRoutes(scope: FastifyInstance, deps: AppDeps, demo: DemoDeps) {
  registerAuth(scope, () => Promise.resolve(null));
  scope.addHook('onSend', async (_request, reply) => {
    void reply.header('x-specledger-workspace', 'demo-showcase');
  });
  registerRoutes(scope, { ...deps, database: demo.showcase }, 'showcase');
}

// The demo sandboxes under /demo. POST /demo/session starts a visitor session and copies the
// showcase into the visitor's own schema; every other route works on that schema only, accepts
// only demo sessions, and offers no uploads and no administration, so nothing a visitor does
// reaches another visitor, the showcase or the real workspace, or causes a model call.
export function registerSandboxRoutes(scope: FastifyInstance, deps: AppDeps, demo: DemoDeps) {
  registerAuth(scope, demoAuthenticator(demo.sessions), NO_COOKIE);
  scope.addHook('onRequest', (request, _reply, done) => {
    const sandbox = request.principal?.sandbox;
    if (sandbox !== undefined) request.workspace = demo.sandboxes.open(sandbox);
    done();
  });
  scope.addHook('onSend', async (_request, reply) => {
    void reply.header('x-specledger-workspace', 'demo-sandbox');
  });
  scope.post(
    '/session',
    {
      config: {
        auth: 'public',
        rateLimit: { max: DEMO_SESSION_RATE_LIMIT_PER_MINUTE, timeWindow: 60_000 },
      },
    },
    async (_request, reply) => {
      if (!(await demo.isReady())) {
        throw new ApiError(
          503,
          'DEMO_NOT_READY',
          'The demo is still being prepared. Try again in a minute.',
        );
      }
      const issued = demo.sessions.issue();
      const session = demo.sessions.verify(issued.token);
      if (session === null) throw new Error('a freshly issued demo session did not verify');
      try {
        await demo.sandboxes.create(session.sessionId, session.expiresAt);
      } catch (error) {
        if (error instanceof DemoFullError) {
          throw new ApiError(503, 'DEMO_FULL', 'The demo is busy. Try again in a few minutes.');
        }
        throw error;
      }
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send({ token: issued.token, expiresAt: issued.expiresAt.toISOString() });
    },
  );
  registerRoutes(scope, { ...deps, database: demo.showcase }, 'sandbox');
}

// On the workspace routes: an admin can reset the showcase to its curated documents.
export function registerDemoAdminRoutes(scope: FastifyInstance, demo: DemoDeps): void {
  scope.post('/admin/demo/reset', { config: { auth: ADMIN } }, async () => ({
    status: 'reset' as const,
    queued: await demo.reset(),
  }));
}
