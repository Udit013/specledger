import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from './errors.js';

export const ROLES = ['engineer', 'approver'] as const;
export type Role = (typeof ROLES)[number];

// What a route requires: the roles allowed to call it, or 'public' for the probes. Every route
// must declare it in its route config; buildApp refuses to start with a route that does not.
export type RouteAuth = readonly Role[] | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    // Set by the auth hook for authenticated requests.
    principal: Principal | null;
  }
}

// Who made an authenticated request: the roles it may act as, and the actor the audit log records.
export interface Principal {
  readonly roles: readonly Role[];
  readonly actor: string;
}

// Turns an Authorization header into a principal, or null when it carries no valid credential.
// Each route scope has its own: the production routes accept the role tokens, the demo routes
// only demo visitor sessions, so neither credential works on the other's routes.
export type Authenticate = (header: string | undefined) => Principal | null;

export interface ApiTokens {
  readonly engineer: string;
  readonly approver: string;
}

// The role a bearer token belongs to, or null. Both the presented token and each configured one
// are hashed (SHA-256) and the digests compared with crypto.timingSafeEqual: equal-length inputs
// make the comparison time independent of where the bytes differ and of the token's length.
export function roleForToken(header: string | undefined, tokens: ApiTokens): Role | null {
  // Exactly "Bearer <token>": one space, no padding. The scheme is case-insensitive (RFC 9110).
  const presented = bearerToken(header);
  if (presented === null) return null;
  const digest = sha256(presented);
  let found: Role | null = null;
  // Every role is compared, so the time taken does not depend on which one matched.
  for (const role of ROLES) {
    if (timingSafeEqual(digest, sha256(tokens[role]))) found = role;
  }
  return found;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

// The bearer credential of an Authorization header: exactly "Bearer <token>", or null.
export function bearerToken(header: string | undefined): string | null {
  return /^bearer ([^\s]+)$/i.exec(header ?? '')?.[1] ?? null;
}

// The production authenticator: one role per token, recorded as "role:<role>".
export function tokenAuthenticator(tokens: ApiTokens): Authenticate {
  return (header) => {
    const role = roleForToken(header, tokens);
    return role === null ? null : { roles: [role], actor: `role:${role}` };
  };
}

// Registers the onRoute check (every route declares auth) and the onRequest hook that enforces
// it: 401 UNAUTHENTICATED without a valid credential, 403 FORBIDDEN for a valid one whose roles
// the route does not allow. A route without a declaration fails closed. Hooks are scoped: called
// inside a plugin, it guards only that plugin's routes, with that scope's authenticator.
export function registerAuth(app: FastifyInstance, credentials: ApiTokens | Authenticate): void {
  const authenticate =
    typeof credentials === 'function' ? credentials : tokenAuthenticator(credentials);
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
    const principal = authenticate(request.headers.authorization);
    if (principal === null) {
      void reply.header('www-authenticate', 'Bearer');
      throw new ApiError(401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
    }
    if (auth === undefined || !principal.roles.some((role) => auth.includes(role))) {
      throw new ApiError(403, 'FORBIDDEN', 'This role may not call this route.');
    }
    request.principal = principal;
  });
}

// The audit actor for a request: "role:engineer" or "role:approver" on the production routes,
// "demo:<session id>" in the demo workspace. There are no user accounts.
export function actorOf(request: FastifyRequest): string {
  if (request.principal === null) {
    throw new Error('actorOf is called only on authenticated routes');
  }
  return request.principal.actor;
}
