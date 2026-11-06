import { afterEach, describe, expect, it } from 'vitest';

import { createDemoAccess, DEMO_STORAGE_KEY, DemoSessionError, inDemo } from './demo.js';

const BASE = 'https://api.example.test';
const HOUR = 3_600_000;

function server(status = 201) {
  const calls: string[] = [];
  let n = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${input as string}`);
    n += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: `demo.session-${String(n)}`,
          expiresAt: new Date(at.now + HOUR).toISOString(),
        }),
        { status },
      ),
    );
  };
  return { calls, fetch };
}
const at = { now: Date.parse('2026-11-05T10:00:00Z') };

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('demo access', () => {
  it('starts one session on first use, shared by concurrent requests, kept in sessionStorage', async () => {
    const api = server();
    const demo = createDemoAccess({
      baseUrl: BASE,
      storage: sessionStorage,
      fetch: api.fetch,
      now: () => at.now,
    });
    expect(inDemo(sessionStorage)).toBe(false);
    const tokens = await Promise.all([demo.token(), demo.token()]);
    expect(tokens).toEqual(['demo.session-1', 'demo.session-1']);
    expect(api.calls).toEqual([`POST ${BASE}/demo/session`]);
    expect(inDemo(sessionStorage)).toBe(true);
    expect(sessionStorage.getItem(DEMO_STORAGE_KEY)).toContain('demo.session-1');
    expect(localStorage.length).toBe(0);
  });

  it('reuses a stored session and renews it shortly before it expires', async () => {
    const api = server();
    const options = { baseUrl: BASE, storage: sessionStorage, fetch: api.fetch, now: () => at.now };
    await createDemoAccess(options).token();
    // A new page load in the same tab picks the session up again.
    const demo = createDemoAccess(options);
    expect(await demo.token()).toBe('demo.session-1');
    at.now += HOUR - 30_000;
    expect(await demo.token()).toBe('demo.session-2');
    at.now -= HOUR - 30_000;
    expect(api.calls).toHaveLength(2);
  });

  it('forgets the session when leaving the demo', async () => {
    const api = server();
    const demo = createDemoAccess({ baseUrl: BASE, storage: sessionStorage, fetch: api.fetch });
    await demo.token();
    demo.forget();
    expect(inDemo(sessionStorage)).toBe(false);
  });

  it.each([
    [404, 'unavailable'],
    [429, 'busy'],
    [503, 'unreachable'],
    [400, 'failed'],
  ] as const)('explains a %i from the server', async (status, reason) => {
    const demo = createDemoAccess({
      baseUrl: BASE,
      storage: sessionStorage,
      fetch: server(status).fetch,
    });
    await expect(demo.token()).rejects.toMatchObject({ reason });
    expect(inDemo(sessionStorage)).toBe(false);
  });

  it('explains an unreachable server', async () => {
    const demo = createDemoAccess({
      baseUrl: BASE,
      storage: sessionStorage,
      fetch: () => Promise.reject(new TypeError('failed to fetch')),
    });
    const error = await demo.token().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoSessionError);
    expect((error as Error).message).toMatch(/wake up/);
  });
});
