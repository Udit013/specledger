// Checks a running deployment from the outside: probes, authentication, security headers and,
// optionally, CORS for the web origin and the public demo showcase. It changes nothing.
//
//   pnpm smoke https://specledger-api.onrender.com
//   SMOKE_ORIGIN=https://specledger.vercel.app SMOKE_SHOWCASE=1 pnpm smoke <url>
//
// A free Render service sleeps when idle; the first request can take a minute to answer.
import { fileURLToPath } from 'node:url';

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SmokeOptions {
  readonly origin?: string;
  // Also check that the public demo showcase answers.
  readonly showcase?: boolean;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function runSmoke(baseUrl: string, options: SmokeOptions): Promise<SmokeCheck[]> {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const base = baseUrl.replace(/\/$/, '');
  const get = async (path: string, headers: Record<string, string> = {}) => {
    try {
      const response = await send(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      return {
        status: 0,
        headers: new Headers(),
        text: error instanceof Error ? error.name : 'failed',
      };
    }
  };
  const checks: SmokeCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };

  const health = await get('/health');
  check(
    'GET /health answers 200 ok',
    health.status === 200 && health.text.includes('"ok"'),
    `status ${String(health.status)}`,
  );
  const ready = await get('/ready');
  check(
    'GET /ready answers 200 ready',
    ready.status === 200 && ready.text.includes('"ready"'),
    `status ${String(ready.status)}`,
  );
  const anonymous = await get('/documents');
  check(
    'GET /documents without a token answers 401 with WWW-Authenticate',
    anonymous.status === 401 && anonymous.headers.get('www-authenticate') === 'Bearer',
    `status ${String(anonymous.status)}`,
  );
  check(
    'responses carry X-Content-Type-Options: nosniff',
    health.headers.get('x-content-type-options') === 'nosniff',
    String(health.headers.get('x-content-type-options')),
  );
  if (options.origin !== undefined) {
    const cors = await get('/health', { origin: options.origin });
    check(
      `CORS allows ${options.origin}`,
      cors.headers.get('access-control-allow-origin') === options.origin,
      String(cors.headers.get('access-control-allow-origin')),
    );
  }
  if (options.showcase === true) {
    const read = await get('/showcase/documents', {});
    check(
      'GET /showcase/documents answers 200 without signing in',
      read.status === 200,
      `status ${String(read.status)}`,
    );
  }
  return checks;
}

async function main(): Promise<number> {
  const url = process.argv[2];
  if (url === undefined) {
    process.stderr.write('usage: pnpm smoke <api-url>\n');
    return 2;
  }
  const checks = await runSmoke(url, {
    ...(process.env.SMOKE_ORIGIN ? { origin: process.env.SMOKE_ORIGIN } : {}),
    ...(process.env.SMOKE_SHOWCASE === '1' ? { showcase: true } : {}),
  });
  for (const c of checks)
    process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})\n`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
