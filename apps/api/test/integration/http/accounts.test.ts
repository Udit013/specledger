import { meSchema, userListSchema, userViewSchema } from '@specledger/core';
import { describe, expect, it } from 'vitest';

import { bearer, emailOf, TEST_PASSWORD, withApp } from '../../support/http.js';

const login = (app: ReturnType<typeof withApp>['app'], email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

const cookieOf = (setCookie: string | string[] | undefined) =>
  (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';

describe('signing in and out', () => {
  const { app, testDb, logs } = withApp();

  it('signs in with a session cookie that scripts cannot read, and signs out', async () => {
    const response = await login(app, emailOf('reviewer').toUpperCase(), TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
    const body = meSchema.parse(response.json());
    expect(body.user).toMatchObject({ email: emailOf('reviewer'), roles: ['reviewer'] });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/^specledger_session=[A-Za-z0-9_-]{43}; /);
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=3600']) {
      expect(setCookie).toContain(attribute);
    }
    expect(response.headers['cache-control']).toBe('no-store');

    const cookie = cookieOf(response.headers['set-cookie']);
    const me = await app.inject({ url: '/auth/me', headers: { cookie } });
    expect(me.json<{ user: { email: string } }>().user.email).toBe(emailOf('reviewer'));

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-requested-with': 'specledger' },
    });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('gives a wrong password and an unknown email the same answer', async () => {
    const wrong = await login(app, emailOf('reviewer'), 'not-the-password');
    const unknown = await login(app, 'nobody@test.example', TEST_PASSWORD);
    for (const response of [wrong, unknown]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'The email or password is incorrect.' },
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refuses a disabled user', async () => {
    const user = await testDb.database.users.getByEmail(emailOf('engineer'));
    await testDb.database.users.update(user?.id ?? '', { disabledAt: new Date() });
    try {
      expect((await login(app, emailOf('engineer'), TEST_PASSWORD)).statusCode).toBe(401);
    } finally {
      await testDb.database.users.update(user?.id ?? '', { disabledAt: null });
    }
  });

  it('stores only the hash of a session token and never logs passwords or tokens', async () => {
    const response = await login(app, emailOf('approver'), TEST_PASSWORD);
    const token = cookieOf(response.headers['set-cookie']).split('=')[1] ?? '';
    const { rows } = await testDb.query('select token_hash from sessions');
    expect(rows.map((r) => r.token_hash)).not.toContain(token);
    const all = logs.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(TEST_PASSWORD);
  });
});

describe('sign-in rate limit', () => {
  const { app } = withApp({ auth: { loginRateLimitPerMinute: 3 } });

  it('limits sign-in attempts per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await login(app, emailOf('admin'), 'wrong password')).statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

describe('user administration', () => {
  const { app } = withApp();
  const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: bearer('admin'),
      ...(payload === undefined ? {} : { payload }),
    });

  it('creates users, refuses a taken email, and lists them without password hashes', async () => {
    const created = await admin('POST', '/admin/users', {
      email: 'New.Person@Example.com',
      displayName: 'New Person',
      roles: ['engineer', 'reviewer'],
      password: 'a long enough password',
    });
    expect(created.statusCode).toBe(201);
    expect(userViewSchema.parse(created.json())).toMatchObject({
      email: 'new.person@example.com',
      roles: ['engineer', 'reviewer'],
      disabled: false,
    });
    const again = await admin('POST', '/admin/users', {
      email: 'new.person@example.com',
      displayName: 'Again',
      roles: ['admin'],
      password: 'a long enough password',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } });

    const list = await admin('GET', '/admin/users');
    expect(list.body).not.toContain('scrypt');
    expect(userListSchema.parse(list.json()).users.map((u) => u.email)).toContain(
      'new.person@example.com',
    );
    expect((await login(app, 'new.person@example.com', 'a long enough password')).statusCode).toBe(
      200,
    );
  });

  it.each([
    ['a short password', { password: 'short' }],
    ['no roles', { roles: [] }],
    ['a repeated role', { roles: ['admin', 'admin'] }],
    ['an unknown role', { roles: ['owner'] }],
    ['a bad email', { email: 'not-an-email' }],
  ])('refuses %s', async (_case, override) => {
    const response = await admin('POST', '/admin/users', {
      email: 'valid@example.com',
      displayName: 'Valid',
      roles: ['engineer'],
      password: 'a long enough password',
      ...override,
    });
    expect(response.statusCode).toBe(400);
  });

  it('changes roles at once, and disabling or a new password ends sessions', async () => {
    const users = userListSchema.parse((await admin('GET', '/admin/users')).json()).users;
    const reviewer = users.find((u) => u.email === emailOf('reviewer'));
    const changed = await admin('PATCH', `/admin/users/${reviewer?.id ?? ''}`, {
      roles: ['reviewer', 'approver'],
    });
    expect(changed.json()).toMatchObject({ roles: ['reviewer', 'approver'] });
    const me = await app.inject({ url: '/auth/me', headers: bearer('reviewer') });
    expect(me.json<{ user: { roles: string[] } }>().user.roles).toEqual(['reviewer', 'approver']);

    await admin('PATCH', `/admin/users/${reviewer?.id ?? ''}`, { disabled: true });
    expect((await app.inject({ url: '/auth/me', headers: bearer('reviewer') })).statusCode).toBe(
      401,
    );
    await admin('PATCH', `/admin/users/${reviewer?.id ?? ''}`, { disabled: false });
    // The session stays ended; the user signs in again.
    expect((await app.inject({ url: '/auth/me', headers: bearer('reviewer') })).statusCode).toBe(
      401,
    );
    expect((await login(app, emailOf('reviewer'), TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('never removes the last active admin', async () => {
    const users = userListSchema.parse((await admin('GET', '/admin/users')).json()).users;
    const self = users.find((u) => u.email === emailOf('admin'));
    for (const change of [{ disabled: true }, { roles: ['approver'] }]) {
      const response = await admin('PATCH', `/admin/users/${self?.id ?? ''}`, change);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'LAST_ADMIN' } });
    }
    expect((await app.inject({ url: '/auth/me', headers: bearer('admin') })).statusCode).toBe(200);
  });
});
