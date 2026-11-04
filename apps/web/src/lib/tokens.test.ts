import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearTokens, loadTokens, saveTokens, TOKEN_STORAGE_KEY } from './tokens.js';

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('token storage', () => {
  it('keeps tokens in sessionStorage, never in localStorage', () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    saveTokens(sessionStorage, { engineer: 'e'.repeat(40), approver: null });
    expect(loadTokens(sessionStorage)).toEqual({ engineer: 'e'.repeat(40), approver: null });
    expect(localStorage.length).toBe(0);
    expect(local.mock.contexts.every((storage) => storage === sessionStorage)).toBe(true);
  });

  it('reads nothing from a missing, malformed or wrongly shaped entry', () => {
    expect(loadTokens(sessionStorage)).toEqual({ engineer: null, approver: null });
    sessionStorage.setItem(TOKEN_STORAGE_KEY, '{not json');
    expect(loadTokens(sessionStorage)).toEqual({ engineer: null, approver: null });
    sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ engineer: 42 }));
    expect(loadTokens(sessionStorage)).toEqual({ engineer: null, approver: null });
  });

  it('treats blank tokens as absent and trims the rest', () => {
    saveTokens(sessionStorage, { engineer: '   ', approver: '  abc  ' });
    expect(loadTokens(sessionStorage)).toEqual({ engineer: null, approver: 'abc' });
  });

  it('clears the entry', () => {
    saveTokens(sessionStorage, { engineer: 'x', approver: 'y' });
    clearTokens(sessionStorage);
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('survives a storage that throws (private mode, blocked storage)', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadTokens(broken)).toEqual({ engineer: null, approver: null });
    expect(() => {
      saveTokens(broken, { engineer: 'x', approver: null });
    }).not.toThrow();
    expect(() => {
      clearTokens(broken);
    }).not.toThrow();
  });
});
