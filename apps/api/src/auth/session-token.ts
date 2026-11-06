import { createHash, randomBytes } from 'node:crypto';

// Session tokens: 32 random bytes, base64url. Only their SHA-256 is stored.
export const SESSION_COOKIE = 'specledger_session';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const newSessionToken = (): string => randomBytes(32).toString('base64url');
export const isSessionToken = (value: string): boolean => TOKEN.test(value);
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

// The value of one cookie from a Cookie header, or null.
export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

// The session cookie: HttpOnly (no script can read it), SameSite=Strict (never sent on a request
// another site starts), Secure outside local development, Path=/ under the UI's own origin.
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(maxAgeSeconds)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export const clearedSessionCookie = (secure: boolean): string => sessionCookie('', 0, secure);
