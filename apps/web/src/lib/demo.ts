import { demoSessionSchema } from '@specledger/core';
import { z } from 'zod';

// The demo workspace's visitor session. Starting the demo asks the server for a short-lived signed
// session (POST /demo/session); nobody pastes or sees a token. It lives in sessionStorage (cleared
// when the tab closes) and memory, never in localStorage, cookies or the URL, and it is renewed
// shortly before it expires. It works only on the /demo routes, which use their own database.
export const DEMO_STORAGE_KEY = 'specledger.demo';

// A session this close to its expiry is renewed before the next request.
const RENEW_BEFORE_MS = 60_000;

const storedSchema = z.strictObject({ token: z.string().min(1), expiresAt: z.iso.datetime() });
type Stored = z.infer<typeof storedSchema>;

export type DemoStartError = 'unavailable' | 'unreachable' | 'busy' | 'failed';

export class DemoSessionError extends Error {
  readonly reason: DemoStartError;
  constructor(reason: DemoStartError) {
    super(
      {
        unavailable: 'The demo workspace is not enabled on this server.',
        unreachable:
          'The server could not be reached. The free server sleeps when idle and can take about a minute to wake up; try again shortly.',
        busy: 'Too many demo sessions were started from here. Wait a minute and try again.',
        failed: 'The demo could not be started. Try again.',
      }[reason],
    );
    this.name = 'DemoSessionError';
    this.reason = reason;
  }
}

function read(storage: Storage): Stored | null {
  try {
    const raw = storage.getItem(DEMO_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Whether this tab is in the demo workspace (it started the demo and has not left it).
export function inDemo(storage: Storage): boolean {
  return read(storage) !== null;
}

export interface DemoAccessOptions {
  // The API's base URL; the session comes from `${baseUrl}/demo/session`.
  readonly baseUrl: string;
  readonly storage: Storage;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function createDemoAccess(options: DemoAccessOptions) {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let current = read(options.storage);
  let pending: Promise<string> | null = null;

  const store = (next: Stored | null) => {
    current = next;
    try {
      if (next === null) options.storage.removeItem(DEMO_STORAGE_KEY);
      else options.storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Kept in memory only.
    }
  };

  async function start(): Promise<string> {
    let response: Response;
    try {
      response = await send(`${options.baseUrl}/demo/session`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new DemoSessionError('unreachable');
    }
    if (response.status === 404) throw new DemoSessionError('unavailable');
    if (response.status === 429) throw new DemoSessionError('busy');
    if (response.status >= 500) throw new DemoSessionError('unreachable');
    const parsed = demoSessionSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) throw new DemoSessionError('failed');
    store(parsed.data);
    return parsed.data.token;
  }

  return {
    // A valid session token, starting or renewing the session when needed. Concurrent callers
    // share one request.
    token(): Promise<string> {
      if (current !== null && Date.parse(current.expiresAt) - now() > RENEW_BEFORE_MS) {
        return Promise.resolve(current.token);
      }
      pending ??= start().finally(() => {
        pending = null;
      });
      return pending;
    },
    // Leaves the demo, or drops a session the server no longer accepts.
    forget(): void {
      store(null);
    },
  };
}

export type DemoAccess = ReturnType<typeof createDemoAccess>;
