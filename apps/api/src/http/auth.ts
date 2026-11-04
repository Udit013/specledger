import type { FastifyInstance, FastifyRequest } from 'fastify';

import { notImplemented } from '../not-implemented.js';

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
  return notImplemented('roleForToken', header, tokens);
}

// Registers the onRoute check (every route declares auth) and the onRequest hook that enforces
// it: 401 UNAUTHENTICATED without a valid token, 403 FORBIDDEN for a valid token of a role the
// route does not allow. A route without a declaration fails closed.
export function registerAuth(app: FastifyInstance, tokens: ApiTokens): void {
  notImplemented('registerAuth', app, tokens);
}

// The audit actor for a request: "role:engineer" or "role:approver". There are no user accounts.
export function actorOf(request: FastifyRequest): string {
  return notImplemented('actorOf', request);
}
