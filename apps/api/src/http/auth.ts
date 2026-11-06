import { USER_ROLES } from '@specledger/core';
import type { UserRole } from '@specledger/core';
import type { Database } from '@specledger/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isSessionToken, readCookie, SESSION_COOKIE, tokenHash } from '../auth/session-token.js';
import { ApiError } from './errors.js';

export const ROLES = USER_ROLES;
export type Role = UserRole;

// What a route requires: the roles allowed to call it, or 'public'. Every route must declare it
// in its route config; buildApp refuses to start with a route that does not.
export type RouteAuth = readonly Role[] | 'public';

// Who made an authenticated request: the roles it may act as, the actor the audit log records,
// and, for a signed-in user, who that is.
export interface Principal {
  readonly roles: readonly Role[];
  readonly actor: string;
  readonly user?: { readonly id: string; readonly email: string; readonly expiresAt: Date };
  // Demo sandbox sessions: the sandbox's schema.
  readonly sandbox?: string;
  // How the credential arrived: a cookie needs the CSRF header on writes, a bearer token not.
  readonly via: 'cookie' | 'bearer';
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    // Set by the auth hook for authenticated requests.
    principal: Principal | null;
  }
}

// Turns a request's credential into a principal, or null. Each route scope has its own: the
// workspace routes accept user sessions, the demo sandbox routes only demo sessions, so neither
// credential works on the other's routes.
export type Authenticate = (credential: Credential) => Promise<Principal | null>;

export interface Credential {
  readonly token: string;
  readonly via: 'cookie' | 'bearer';
}

// The credential of a request: "Authorization: Bearer <token>" (scripts, tests) or the session
// cookie (the browser). A malformed Authorization header counts as no credential at all.
export function credentialOf(
  request: FastifyRequest,
  cookieName = SESSION_COOKIE,
): Credential | null {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const token = /^bearer ([^\s]+)$/i.exec(header)?.[1];
    return token === undefined ? null : { token, via: 'bearer' };
  }
  const cookie = readCookie(request.headers.cookie, cookieName);
  return cookie === null || cookie === '' ? null : { token: cookie, via: 'cookie' };
}

// The workspace authenticator: a session token, looked up by its SHA-256 among the sessions that
// are unexpired, unrevoked and belong to an enabled user.
export function sessionAuthenticator(database: Database, now: () => Date): Authenticate {
  return async ({ token, via }) => {
    if (!isSessionToken(token)) return null;
    const found = await database.sessions.findActive(tokenHash(token), now());
    if (found === null) return null;
    return {
      roles: found.user.roles,
      actor: `user:${found.user.email}`,
      user: { id: found.user.id, email: found.user.email, expiresAt: found.expiresAt },
      via,
    };
  };
}

// The custom header a cookie-authenticated write must carry. A cross-site form cannot set it, and
// a cross-origin script cannot send it without a CORS preflight this API refuses.
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'specledger';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Registers the onRoute check (every route declares auth) and the onRequest hook that enforces
// it: 401 UNAUTHENTICATED without a valid credential, 403 FORBIDDEN for one whose roles the route
// does not allow. A route without a declaration fails closed. Hooks are scoped: called inside a
// plugin, it guards only that plugin's routes, with that scope's authenticator.
export function registerAuth(
  app: FastifyInstance,
  authenticate: Authenticate,
  cookieName = SESSION_COOKIE,
): void {
  if (!app.hasRequestDecorator('principal')) app.decorateRequest('principal', null);
  // Collected as routes are added and refused at ready(), so the app never starts with one.
  const undeclared: string[] = [];
  app.addHook('onRoute', (route) => {
    const auth = (route.config as { auth?: RouteAuth } | undefined)?.auth;
    const preflight = route.method === 'OPTIONS';
    if (!preflight && auth !== 'public' && !(Array.isArray(auth) && auth.length > 0)) {
      undeclared.push(`${route.method.toString()} ${route.url}`);
    }
  });
  app.addHook('onReady', (done) => {
    done(
      undeclared.length > 0
        ? new Error(`routes without a declared auth: ${undeclared.join(', ')}`)
        : undefined,
    );
  });
  app.addHook('onRequest', async (request, reply) => {
    const auth = request.routeOptions.config.auth;
    // Unmatched URLs reach the 404 handler, which reveals nothing, and CORS preflights carry no
    // credentials and return no data; every other route declared its auth.
    if (auth === 'public' || request.is404 || request.method === 'OPTIONS') return;
    const credential = credentialOf(request, cookieName);
    const principal = credential === null ? null : await authenticate(credential);
    if (principal === null) {
      void reply.header('www-authenticate', 'Bearer');
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    }
    if (
      principal.via === 'cookie' &&
      !SAFE_METHODS.has(request.method) &&
      request.headers[CSRF_HEADER] !== CSRF_VALUE
    ) {
      throw new ApiError(403, 'FORBIDDEN', 'The request is missing its anti-forgery header.');
    }
    if (auth === undefined || !principal.roles.some((role) => auth.includes(role))) {
      throw new ApiError(403, 'FORBIDDEN', 'Your role may not do this.');
    }
    request.principal = principal;
  });
}

// The audit actor for a request: "user:<email>" in the workspace, "demo:<session id>" in a demo
// sandbox.
export function actorOf(request: FastifyRequest): string {
  if (request.principal === null) {
    throw new Error('actorOf is called only on authenticated routes');
  }
  return request.principal.actor;
}

// Whether the request's principal holds one of the roles.
export function holds(request: FastifyRequest, ...roles: readonly Role[]): boolean {
  return request.principal?.roles.some((role) => roles.includes(role)) ?? false;
}
