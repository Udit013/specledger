import { z } from 'zod';

// The demo's bearer tokens, one per role. They live in sessionStorage (cleared when the tab closes)
// and in memory, never in localStorage, cookies or the URL.
export const TOKEN_STORAGE_KEY = 'specledger.tokens';

export interface Tokens {
  readonly engineer: string | null;
  readonly approver: string | null;
}

export const NO_TOKENS: Tokens = Object.freeze({ engineer: null, approver: null });

const token = z
  .string()
  .nullable()
  .transform((value) => (value === null || value.trim() === '' ? null : value.trim()));
const storedSchema = z.strictObject({ engineer: token, approver: token });

// Storage can throw (private browsing, blocked site data); tokens are then kept in memory only.
export function loadTokens(storage: Storage): Tokens {
  try {
    const raw = storage.getItem(TOKEN_STORAGE_KEY);
    if (raw === null) return NO_TOKENS;
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : NO_TOKENS;
  } catch {
    return NO_TOKENS;
  }
}

export function saveTokens(storage: Storage, tokens: Tokens): void {
  const cleaned = storedSchema.parse(tokens);
  try {
    storage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Kept in memory by the caller.
  }
}

export function clearTokens(storage: Storage): void {
  try {
    storage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
}

// The tokens as the API client reads them at request time, kept outside React state so that
// changing them needs no new client.
export function createTokenHolder(initial: Tokens) {
  let current = initial;
  return {
    get: (): Tokens => current,
    set: (next: Tokens): void => {
      current = next;
    },
  };
}
