import { notImplemented } from './not-implemented.js';
export const TOKEN_STORAGE_KEY = 'specledger.tokens';
export interface Tokens {
  readonly engineer: string | null;
  readonly approver: string | null;
}
export function loadTokens(storage: Storage): Tokens {
  return notImplemented(`loadTokens(${String(storage.length)})`);
}
export function saveTokens(storage: Storage, tokens: Tokens): void {
  notImplemented(`saveTokens(${String(storage.length)}${String(tokens.engineer)})`);
}
export function clearTokens(storage: Storage): void {
  notImplemented(`clearTokens(${String(storage.length)})`);
}
