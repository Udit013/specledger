import { describe, expect, it } from 'vitest';

import { createDemoSessions } from './session.js';

const SECRET = 'a-demo-session-secret-for-tests-0123456789';
const HOUR = 3_600_000;

function sessions(at: { now: number }, secret = SECRET) {
  return createDemoSessions({ secret, ttlMs: HOUR, now: () => at.now });
}

describe('demo sessions', () => {
  it('verifies a session it issued until it expires', () => {
    const at = { now: 1_800_000_000_000 };
    const issuer = sessions(at);
    const { token, expiresAt } = issuer.issue();
    expect(expiresAt.getTime()).toBe(at.now + HOUR);
    expect(token).toMatch(/^demo\.[0-9a-f]{16}\.\d{13}\.[A-Za-z0-9_-]{43}$/);
    expect(issuer.verify(token)?.expiresAt).toEqual(expiresAt);
    at.now += HOUR - 1;
    expect(issuer.verify(token)).not.toBeNull();
    at.now += 1;
    expect(issuer.verify(token)).toBeNull();
  });

  it('gives every session its own id', () => {
    const issuer = sessions({ now: 1_800_000_000_000 });
    const ids = new Set(
      Array.from({ length: 50 }, () => issuer.verify(issuer.issue().token)?.sessionId),
    );
    expect(ids.size).toBe(50);
  });

  it('refuses a token signed with another secret', () => {
    const at = { now: 1_800_000_000_000 };
    const other = sessions(at, `${SECRET}-other`).issue().token;
    expect(sessions(at).verify(other)).toBeNull();
  });

  it('refuses a token whose expiry or id was changed', () => {
    const at = { now: 1_800_000_000_000 };
    const issuer = sessions(at);
    const [prefix, id, expiry, signature] = issuer.issue().token.split('.') as [
      string,
      string,
      string,
      string,
    ];
    const later = String(Number(expiry) + 1);
    expect(issuer.verify([prefix, id, later, signature].join('.'))).toBeNull();
    const otherId = `${id.slice(0, -1)}${id.endsWith('a') ? 'b' : 'a'}`;
    expect(issuer.verify([prefix, otherId, expiry, signature].join('.'))).toBeNull();
  });

  it('refuses a validly signed token dated beyond the session lifetime', () => {
    const at = { now: 1_800_000_000_000 };
    const issued = sessions({ now: at.now + 2 * HOUR }).issue().token;
    expect(sessions(at).verify(issued)).toBeNull();
  });

  it.each([
    '',
    'demo',
    'demo...',
    'engineer-token-for-tests-6f1c2d9a4b',
    `demo.${'a'.repeat(16)}.1800000000000.${'b'.repeat(43)}`,
    `demo.${'a'.repeat(16)}.1800000000000.${'b'.repeat(43)} `,
  ])('refuses %j', (token) => {
    expect(sessions({ now: 1_700_000_000_000 }).verify(token)).toBeNull();
  });

  it('refuses a short secret', () => {
    expect(() => createDemoSessions({ secret: 'short', ttlMs: HOUR })).toThrow(/too short/);
  });
});
