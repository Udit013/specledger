import { describe, expect, it } from 'vitest';

import { withTestDb } from '../support/test-db.js';

const testDb = withTestDb();
const HASH = 'scrypt$16384$8$1$c2FsdA$aGFzaA';
const tokenHash = (n: number) => n.toString(16).padStart(64, '0');

describe('users', () => {
  it('creates a user once per email', async () => {
    const { users } = testDb.database;
    const created = await users.create({
      email: 'ada@example.com',
      displayName: 'Ada',
      passwordHash: HASH,
      roles: ['engineer', 'reviewer'],
    });
    expect(created).toMatchObject({ email: 'ada@example.com', roles: ['engineer', 'reviewer'] });
    expect(
      await users.create({
        email: 'ada@example.com',
        displayName: 'Other',
        passwordHash: HASH,
        roles: ['admin'],
      }),
    ).toBeNull();
    expect((await users.getByEmail('ada@example.com'))?.displayName).toBe('Ada');
  });

  it.each([
    ['an upper-case email', { email: 'Bob@example.com' }],
    ['no roles', { roles: [] }],
    ['an unknown role', { roles: ['owner'] }],
    ['a plain-text password', { passwordHash: 'hunter2' }],
  ])('refuses %s at the database', async (_case, override) => {
    await expect(
      testDb.database.users.create({
        email: 'x@example.com',
        displayName: 'X',
        passwordHash: HASH,
        roles: ['engineer'],
        ...(override as object),
      } as never),
    ).rejects.toThrow();
  });

  it('lists active admins only', async () => {
    const { users } = testDb.database;
    const admin = await users.create({
      email: 'root@example.com',
      displayName: 'Root',
      passwordHash: HASH,
      roles: ['admin'],
    });
    const disabled = await users.create({
      email: 'gone@example.com',
      displayName: 'Gone',
      passwordHash: HASH,
      roles: ['admin'],
    });
    await users.update(disabled?.id ?? '', { disabledAt: new Date() });
    const ids = await testDb.database.transaction((tx) => tx.users.lockActiveAdmins());
    expect(ids).toEqual([admin?.id]);
  });
});

describe('sessions', () => {
  it('finds a session only while it is unexpired, unrevoked and its user enabled', async () => {
    const { users, sessions } = testDb.database;
    const user = await users.create({
      email: 'eve@example.com',
      displayName: 'Eve',
      passwordHash: HASH,
      roles: ['approver'],
    });
    if (user === null) throw new Error('no user');
    const now = new Date('2030-01-01T00:00:00Z');
    const later = new Date('2030-01-01T02:00:00Z');
    await sessions.create({ tokenHash: tokenHash(1), userId: user.id, expiresAt: later });
    await sessions.create({ tokenHash: tokenHash(2), userId: user.id, expiresAt: later });

    expect((await sessions.findActive(tokenHash(1), now))?.user.email).toBe('eve@example.com');
    expect(await sessions.findActive(tokenHash(1), later)).toBeNull();
    expect(await sessions.findActive(tokenHash(9), now)).toBeNull();

    await sessions.revoke(tokenHash(1), now);
    expect(await sessions.findActive(tokenHash(1), now)).toBeNull();
    expect(await sessions.findActive(tokenHash(2), now)).not.toBeNull();

    await users.update(user.id, { disabledAt: now });
    expect(await sessions.findActive(tokenHash(2), now)).toBeNull();
    await users.update(user.id, { disabledAt: null });
    await sessions.revokeAllForUser(user.id, now);
    expect(await sessions.findActive(tokenHash(2), now)).toBeNull();
  });
});
