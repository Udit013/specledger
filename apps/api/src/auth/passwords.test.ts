import { describe, expect, it } from 'vitest';

import { dummyHash, hashPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('verifies the password a hash was made from, and nothing else', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(
      await hashPassword('same password here'),
    );
  });

  it.each(['', 'plain', 'scrypt$1$2$3', 'scrypt$x$8$1$c2FsdA$aGFzaA', 'bcrypt$a$b$c$d$e'])(
    'refuses a malformed stored hash %j',
    async (stored) => {
      expect(await verifyPassword('anything', stored)).toBe(false);
    },
  );

  it('has a dummy hash for unknown accounts', async () => {
    expect(await verifyPassword('password', await dummyHash())).toBe(false);
  });
});
