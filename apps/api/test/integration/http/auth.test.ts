import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { tokenHash } from '../../../src/auth/session-token.js';
import { registerAuth, ROLES } from '../../../src/http/auth.js';
import type { Role } from '../../../src/http/auth.js';
import { bearer, emailOf, TOKENS, withApp } from '../../support/http.js';

const { app, testDb } = withApp();

const ANY: readonly Role[] = ['engineer', 'reviewer', 'approver', 'admin'];

// Every route and who may call it. The matrix below is generated from the app's own route table,
// and this list must match it exactly, so adding a route or changing its roles is deliberate.
const EXPECTED_ROUTES: Record<string, readonly Role[] | 'public'> = {
  'GET /health': 'public',
  'GET /ready': 'public',
  'POST /documents': ['engineer'],
  'GET /documents': ANY,
  'GET /documents/:id': ANY,
  'GET /documents/:id/pages/:n': ANY,
  'GET /documents/:id/fields': ANY,
  'PATCH /fields/:id': ['engineer', 'reviewer'],
  'GET /conflicts': ANY,
  'POST /conflicts/:id/resolve': ['reviewer'],
  'POST /register/publish': ['approver'],
  'GET /register/versions': ANY,
  'GET /register/versions/:n': ANY,
  'GET /register/versions/:n/handoff': ANY,
  'GET /register/versions/:n/export': ANY,
  'GET /audit': ANY,
  'POST /admin/jobs/:id/requeue': ['admin'],
  'POST /auth/login': 'public',
  'POST /auth/logout': ANY,
  'GET /auth/me': ANY,
  'GET /admin/users': ['admin'],
  'POST /admin/users': ['admin'],
  'PATCH /admin/users/:id': ['admin'],
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
    registerAuth(bare, () => Promise.resolve(null));
    bare.get('/forgotten', () => ({ ok: true }));
    await expect(bare.ready()).rejects.toThrow(/auth/);
  });
});

describe('authorization matrix', () => {
  const callers: readonly (readonly [string, Role | null, Record<string, string>])[] = [
    ['no credential', null, {}],
    ['an unknown token', null, { authorization: `Bearer ${'x'.repeat(43)}` }],
    ...ROLES.map((role) => [`the ${role}`, role, bearer(role)] as const),
  ];

  it.each(
    Object.entries(EXPECTED_ROUTES)
      .filter(([route]) => route !== 'POST /auth/logout')
      .flatMap(([route, auth]) => callers.map((c) => [route, c[0], auth, c[1], c[2]] as const)),
  )('%s with %s', async (route, _caller, auth, role, headers) => {
    const [method, url] = route.split(' ') as [string, string];
    const response = await app.inject({
      method: method as 'GET',
      url: urlFor(url),
      headers: { ...headers, 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { payload: '{}' }),
    });
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

  it('lets an engineer edit a value but not accept or reject one', async () => {
    for (const action of ['accept', 'reject'] as const) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/fields/${randomUUID()}`,
        headers: bearer('engineer'),
        payload: { action, expectedVersion: 1 },
      });
      expect(response.statusCode, action).toBe(403);
    }
    const edit = await app.inject({
      method: 'PATCH',
      url: `/fields/${randomUUID()}`,
      headers: bearer('engineer'),
      payload: { action: 'edit', expectedVersion: 1, value: '1', unit: 'ft' },
    });
    expect(edit.statusCode).toBe(404);
  });
});

describe('sessions', () => {
  const session = async (role: Role, change: 'expired' | 'revoked' | 'disabled') => {
    const user = await testDb.database.users.getByEmail(emailOf(role));
    if (user === null) throw new Error('no test user');
    const token = `${change}_${role}`.padEnd(43, '0');
    const past = new Date(Date.now() - 1_000);
    await testDb.database.sessions.create({
      tokenHash: tokenHash(token),
      userId: user.id,
      expiresAt: change === 'expired' ? past : new Date(Date.now() + 3_600_000),
    });
    if (change === 'revoked') await testDb.database.sessions.revoke(tokenHash(token), past);
    return { token, user };
  };
  const me = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/auth/me', headers });

  it.each(['expired', 'revoked'] as const)('refuses a %s session', async (change) => {
    const { token } = await session('reviewer', change);
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
  });

  it('refuses every session of a disabled user', async () => {
    const { token, user } = await session('engineer', 'disabled');
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
    await testDb.database.users.update(user.id, { disabledAt: new Date() });
    try {
      expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
      expect((await me(bearer('engineer'))).statusCode).toBe(401);
    } finally {
      await testDb.database.users.update(user.id, { disabledAt: null });
    }
  });

  it.each([
    `Bearer ${TOKENS.engineer} `,
    `Bearer  ${TOKENS.engineer}`,
    `Basic ${TOKENS.engineer}`,
    TOKENS.engineer,
    'Bearer ',
  ])('refuses the malformed header %j', async (authorization) => {
    expect((await me({ authorization })).statusCode).toBe(401);
  });

  it('accepts the session cookie, but a write needs the anti-forgery header', async () => {
    const cookie = `specledger_session=${TOKENS.reviewer}`;
    expect((await me({ cookie })).statusCode).toBe(200);
    const write = (headers: Record<string, string>) =>
      app.inject({
        method: 'PATCH',
        url: `/fields/${randomUUID()}`,
        headers: { cookie, ...headers },
        payload: { action: 'accept', expectedVersion: 1 },
      });
    const forged = await write({});
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect((await write({ 'x-requested-with': 'specledger' })).statusCode).toBe(404);
  });
});
