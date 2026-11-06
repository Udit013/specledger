import type { FastifyInstance } from 'fastify';

import type { DemoSessions } from '../demo/session.js';
import { bearerToken, registerAuth, ROLES } from './auth.js';
import type { Authenticate, Role } from './auth.js';
import type { AppDeps } from './deps.js';
import { registerRoutes } from './routes.js';

// Sessions one client may start per minute. Sessions are stateless, so this only limits churn.
export const DEMO_SESSION_RATE_LIMIT_PER_MINUTE = 10;

// A demo visitor may do everything both roles may, but only in the demo workspace.
export function demoAuthenticator(sessions: DemoSessions): Authenticate {
  return (header) => {
    const token = bearerToken(header);
    const session = token === null ? null : sessions.verify(token);
    return session === null ? null : { roles: ROLES, actor: `demo:${session.sessionId}` };
  };
}

// The demo workspace under /demo: POST /demo/session starts a visitor session, and every API
// route is mounted again, bound to the demo database, accepting only demo sessions, and accepting
// only the synthetic corpus PDFs as uploads whatever UPLOAD_ALLOWLIST says.
export function registerDemoRoutes(
  scope: FastifyInstance,
  deps: AppDeps,
  demo: NonNullable<AppDeps['demo']>,
): void {
  registerAuth(scope, demoAuthenticator(demo.sessions));
  scope.post(
    '/session',
    {
      config: {
        auth: 'public',
        rateLimit: { max: DEMO_SESSION_RATE_LIMIT_PER_MINUTE, timeWindow: 60_000 },
      },
    },
    async (_request, reply) => {
      const session = demo.sessions.issue();
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send({ token: session.token, expiresAt: session.expiresAt.toISOString() });
    },
  );
  registerRoutes(scope, {
    ...deps,
    database: demo.database,
    uploadAllowlist: demo.uploadAllowlist,
  });
}

const APPROVER: readonly Role[] = ['approver'];

// On the production routes: an approver can reset the demo workspace to its curated documents.
export function registerDemoAdminRoutes(
  scope: FastifyInstance,
  demo: NonNullable<AppDeps['demo']>,
): void {
  scope.post('/admin/demo/reset', { config: { auth: APPROVER } }, async () => ({
    status: 'reset' as const,
    queued: await demo.reset(),
  }));
}
