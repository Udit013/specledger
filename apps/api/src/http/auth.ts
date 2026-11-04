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
    role: Role | null;
  }
}

export interface ApiTokens {
  readonly engineer: string;
  readonly approver: string;
}

// The role a bearer token belongs to, or null. Both the presented token and each configured one
// are hashed (SHA-256) and the digests compared with crypto.timingSafeEqual: equal-length inputs
// make the comparison time independent of where the bytes differ and of the token's length.
export function roleForToken(header: string | undefined, tokens: ApiTokens): Role | null {
  // Exactly "Bearer <token>": one space, no padding. The scheme is case-insensitive (RFC 9110).
  const match = /^bearer ([^\s]+)$/i.exec(header ?? '');
  const presented = match?.[1];
  if (presented === undefined) return null;
  const digest = sha256(presented);
  let found: Role | null = null;
  // Every role is compared, so the time taken does not depend on which one matched.
  for (const role of ROLES) {
    if (timingSafeEqual(digest, sha256(tokens[role]))) found = role;
  }
  return found;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

// Registers the onRoute check (every route declares auth) and the onRequest hook that enforces
// it: 401 UNAUTHENTICATED without a valid token, 403 FORBIDDEN for a valid token of a role the
// route does not allow. A route without a declaration fails closed.
export function registerAuth(app: FastifyInstance, tokens: ApiTokens): void {
  app.decorateRequest('role', null);
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
    const role = roleForToken(request.headers.authorization, tokens);
    if (role === null) {
      void reply.header('www-authenticate', 'Bearer');
      throw new ApiError(401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
    }
    if (auth === undefined || !auth.includes(role)) {
      throw new ApiError(403, 'FORBIDDEN', 'This role may not call this route.');
    }
    request.role = role;
  });
}

// The audit actor for a request: "role:engineer" or "role:approver". There are no user accounts.
export function actorOf(request: FastifyRequest): string {
  if (request.role === null) throw new Error('actorOf is called only on authenticated routes');
  return `role:${request.role}`;
}
