import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Visitor sessions for the demo workspace. A session is a signed token, not a stored row:
//
//   demo.<session id>.<expiry, ms since epoch>.<HMAC-SHA256 of the first three parts>
//
// so issuing one costs nothing to store and a flood of them fills nothing. The signature is
// checked in constant time and the expiry is enforced on every request. A session only ever works
// on the demo routes, which are bound to the demo database; the production routes do not accept it.

export interface DemoSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface VerifiedDemoSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface DemoSessions {
  issue(): DemoSession;
  verify(token: string): VerifiedDemoSession | null;
}

export interface DemoSessionOptions {
  // At least 32 characters; never logged or sent.
  readonly secret: string;
  readonly ttlMs: number;
  readonly now?: () => number;
  readonly newId?: () => string;
}

// The session id is lower-case hex: it also names the visitor's sandbox schema.
const TOKEN = /^demo\.([0-9a-f]{16})\.([0-9]{13})\.([A-Za-z0-9_-]{43})$/;

export function createDemoSessions(options: DemoSessionOptions): DemoSessions {
  if (options.secret.length < 32) throw new Error('the demo session secret is too short');
  if (!(options.ttlMs > 0)) throw new Error('the demo session lifetime must be positive');
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => randomBytes(8).toString('hex'));
  const sign = (body: string) =>
    createHmac('sha256', options.secret).update(body, 'utf8').digest('base64url');

  return {
    issue() {
      const expiresAt = now() + options.ttlMs;
      const body = `demo.${newId()}.${String(expiresAt)}`;
      return { token: `${body}.${sign(body)}`, expiresAt: new Date(expiresAt) };
    },
    verify(token) {
      const match = TOKEN.exec(token);
      if (match === null) return null;
      const [, sessionId = '', expiry = '', signature = ''] = match;
      const expected = Buffer.from(sign(`demo.${sessionId}.${expiry}`));
      const presented = Buffer.from(signature);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return null;
      }
      const expiresAt = Number(expiry);
      // Expired, or dated further ahead than any session this issuer hands out.
      if (expiresAt <= now() || expiresAt > now() + options.ttlMs) return null;
      return { sessionId, expiresAt: new Date(expiresAt) };
    },
  };
}
