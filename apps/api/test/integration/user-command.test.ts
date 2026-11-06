import { describe, expect, it } from 'vitest';

import { verifyPassword } from '../../src/auth/passwords.js';
import { tokenHash } from '../../src/auth/session-token.js';
import { parseUserCommand, runUserCommand } from '../../src/scripts/user.js';
import { withTestDatabase } from '../support/test-db.js';

const db = withTestDatabase();

describe('the user command', () => {
  it.each([
    [[], 'usage'],
    [['create', '--email', 'a@example.com', '--name', 'A'], 'usage'],
    [['create', '--email', 'a@example.com', '--name', 'A', '--roles', 'owner'], 'usage'],
    [
      ['create', '--email', 'a@example.com', '--name', 'A', '--roles', 'admin', '--password', 'x'],
      'usage',
    ],
    [['set-password', '--email', 'not-an-email'], 'usage'],
  ])('refuses %j', (args) => {
    expect(parseUserCommand(args)).toMatch(/^usage:/);
  });

  it('creates the first admin, with the password hashed', async () => {
    const command = parseUserCommand([
      'create',
      '--email',
      'Ada@Example.com',
      '--name',
      'Ada Lovelace',
      '--roles',
      'admin,approver',
    ]);
    if (typeof command === 'string') throw new Error(command);
    expect(await runUserCommand(command, 'a long enough password', db.database)).toBe(
      'Created ada@example.com (admin, approver).',
    );
    const user = await db.database.users.getByEmail('ada@example.com');
    expect(await verifyPassword('a long enough password', user?.passwordHash ?? '')).toBe(true);
    await expect(runUserCommand(command, 'a long enough password', db.database)).rejects.toThrow(
      /exists/,
    );
    await expect(
      runUserCommand({ ...command, email: 'b@example.com' }, 'short', db.database),
    ).rejects.toThrow(/12 to 200/);
  });

  it('sets a new password and ends the sessions', async () => {
    const user = await db.database.users.getByEmail('ada@example.com');
    const hash = tokenHash('s'.repeat(43));
    await db.database.sessions.create({
      tokenHash: hash,
      userId: user?.id ?? '',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const command = parseUserCommand(['set-password', '--email', 'ada@example.com']);
    if (typeof command === 'string') throw new Error(command);
    await runUserCommand(command, 'another long password', db.database);
    const updated = await db.database.users.getByEmail('ada@example.com');
    expect(await verifyPassword('another long password', updated?.passwordHash ?? '')).toBe(true);
    expect(await db.database.sessions.findActive(hash, new Date())).toBeNull();
  });
});
