import { beforeAll, describe, expect, it } from 'vitest';

import { runSmoke } from '../../../src/scripts/smoke.js';
import { withApp } from '../../support/http.js';

const { app } = withApp();
let url = '';
beforeAll(async () => {
  url = await app.listen({ host: '127.0.0.1', port: 0 });
});

describe('runSmoke against a running API', () => {
  it('passes every check, including CORS for the allowed origin', async () => {
    const checks = await runSmoke(url, { origin: 'https://review.example.test' });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual([
      'GET /health answers 200 ok',
      'GET /ready answers 200 ready',
      'GET /documents without a token answers 401 with WWW-Authenticate',
      'responses carry X-Content-Type-Options: nosniff',
      'CORS allows https://review.example.test',
    ]);
  });

  it('reports failing checks instead of throwing', async () => {
    const checks = await runSmoke(url, {
      origin: 'https://evil.example',
      // This API has no demo, so the showcase check fails too.
      showcase: true,
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'CORS allows https://evil.example',
      'GET /showcase/documents answers 200 without signing in',
    ]);
  });

  it('runs only the anonymous checks without an origin or showcase', async () => {
    const checks = await runSmoke(url, {});
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.ok)).toBe(true);
  });
});
