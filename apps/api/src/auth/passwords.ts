import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Password hashing with Node's scrypt (no extra dependency): "scrypt$N$r$p$salt$hash", base64url.
// N = 2^14, r = 8, p = 1 uses 16 MiB per hash, well inside the free instance's memory.
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY }, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS.N, PARAMS.r, PARAMS.p);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ]
    .map(String)
    .join('$');
}

// A hash of a random password, verified when the email is unknown so that a missing account
// takes as long to refuse as a wrong password.
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummy;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt = '', hash = ''] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every((x) => Number.isInteger(x) && x > 0) || N > 1_048_576 || R > 32 || P > 16) {
    return false;
  }
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(salt, 'base64url'), N, R, P).catch(() => null);
  return actual !== null && timingSafeEqual(actual, expected);
}
