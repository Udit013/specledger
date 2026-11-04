import { describe, expect, it } from 'vitest';

import { pollDelay } from './backoff.js';

describe('pollDelay', () => {
  it('doubles from the base for each poll that saw no change, up to the cap', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => pollDelay(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('takes its base and cap from options', () => {
    expect(pollDelay(0, { baseMs: 500, maxMs: 1_200 })).toBe(500);
    expect(pollDelay(3, { baseMs: 500, maxMs: 1_200 })).toBe(1_200);
  });

  it('treats a negative or fractional count as its integer floor, never below zero', () => {
    expect(pollDelay(-3)).toBe(1_000);
    expect(pollDelay(1.9)).toBe(2_000);
    expect(pollDelay(Number.POSITIVE_INFINITY)).toBe(30_000);
  });
});
