import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { NetworkBlockedError, networkGuard } from '../test/network-guard.js';

// Every other test in this package runs under the same guard (vitest.config.js setupFiles), so
// these tests show that it is loaded and that it stops each way out.
describe('network guard', () => {
  it('is active for this test run', () => {
    expect(networkGuard.active).toBe(true);
  });

  it('blocks fetch, which the AI SDK uses', async () => {
    const before = networkGuard.attempts;
    const failure = await fetch('https://generativelanguage.googleapis.com/').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).cause).toBeInstanceOf(NetworkBlockedError);
    expect(networkGuard.attempts).toBeGreaterThan(before);
  });

  it('blocks plain http requests', () => {
    expect(() => http.get('http://example.com/')).toThrow(NetworkBlockedError);
  });
});
