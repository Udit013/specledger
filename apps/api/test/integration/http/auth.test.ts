import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerAuth, roleForToken } from '../../../src/http/auth.js';
import type { Role } from '../../../src/http/auth.js';
import { bearer, TOKENS, withApp } from '../../support/http.js';

const { app } = withApp();

// Every route and who may call it. The matrix below is generated from the app's own route table,
// and this list must match it exactly, so adding a route or changing its roles is deliberate.
const EXPECTED_ROUTES: Record<string, readonly Role[] | 'public'> = {
  'GET /health': 'public',
  'GET /ready': 'public',
  'POST /documents': ['engineer'],
  'GET /documents': ['engineer', 'approver'],
  'GET /documents/:id': ['engineer', 'approver'],
  'GET /documents/:id/pages/:n': ['engineer', 'approver'],
  'GET /documents/:id/fields': ['engineer', 'approver'],
  'PATCH /fields/:id': ['engineer'],
  'GET /conflicts': ['engineer', 'approver'],
  'POST /conflicts/:id/resolve': ['engineer'],
  'POST /register/publish': ['approver'],
  'GET /register/versions/:n/export': ['engineer', 'approver'],
  'GET /audit': ['engineer', 'approver'],
  'POST /admin/jobs/:id/requeue': ['approver'],
};

const routes = () =>
  app.routeTable.filter((route) => route.method !== 'HEAD' && route.method !== 'OPTIONS');
const urlFor = (url: string) => url.replace(':id', randomUUID()).replace(':n', '1');

describe('route table', () => {
  it('declares auth for exactly the expected routes', () => {
    expect(Object.fromEntries(routes().map((r) => [`${r.method} ${r.url}`, r.auth]))).toEqual(
      EXPECTED_ROUTES,
    );
  });

  it('refuses to register a route that does not declare its auth', async () => {
    const bare = Fastify();
    registerAuth(bare, TOKENS);
    bare.get('/forgotten', () => ({ ok: true }));
    await expect(bare.ready()).rejects.toThrow(/auth/);
  });
});

describe('authorization matrix', () => {
  const callers = [
    ['no token', {}],
    ['an unknown token', { authorization: 'Bearer not-a-real-token-at-all-0000' }],
    ['the engineer token', bearer('engineer')],
    ['the approver token', bearer('approver')],
  ] as const;

  it.each(
    Object.entries(EXPECTED_ROUTES).flatMap(([route, auth]) =>
      callers.map((c) => [route, c[0], auth, c[1]] as const),
    ),
  )('%s with %s', async (route, caller, auth, headers) => {
    const [method, url] = route.split(' ') as [string, string];
    const response = await app.inject({
      method: method as 'GET',
      url: urlFor(url),
      headers: { ...headers, 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { payload: '{}' }),
    });
    const role: Role | null =
      caller === 'the engineer token'
        ? 'engineer'
        : caller === 'the approver token'
          ? 'approver'
          : null;
    if (auth === 'public') {
      expect([401, 403]).not.toContain(response.statusCode);
    } else if (role === null) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(response.headers['www-authenticate']).toBe('Bearer');
    } else if (!auth.includes(role)) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    } else {
      expect([401, 403]).not.toContain(response.statusCode);
    }
  });
});

describe('roleForToken', () => {
  it.each([
    [`Bearer ${TOKENS.engineer}`, 'engineer'],
    [`Bearer ${TOKENS.approver}`, 'approver'],
    [`bearer ${TOKENS.engineer}`, 'engineer'],
    [`Bearer ${TOKENS.engineer} `, null],
    [`Bearer  ${TOKENS.engineer}`, null],
    [`Bearer ${TOKENS.engineer}x`, null],
    [`Bearer ${TOKENS.engineer.slice(0, -1)}`, null],
    [`Basic ${TOKENS.engineer}`, null],
    [TOKENS.engineer, null],
    ['Bearer ', null],
    [undefined, null],
  ])('%j is %s', (header, role) => {
    expect(roleForToken(header, TOKENS)).toBe(role);
  });
});
