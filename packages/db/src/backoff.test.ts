import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { backoffDelayMs } from './backoff.js';

const POLICY = { baseMs: 1_000, capMs: 60_000 };

// A small seeded generator (mulberry32), so a sequence of delays can be reproduced exactly.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('backoffDelayMs', () => {
  it('scales the jitter by the exponential ceiling', () => {
    expect(backoffDelayMs(1, POLICY, () => 0.5)).toBe(500);
    expect(backoffDelayMs(2, POLICY, () => 0.5)).toBe(1_000);
    expect(backoffDelayMs(3, POLICY, () => 0.5)).toBe(2_000);
    expect(backoffDelayMs(4, POLICY, () => 0.25)).toBe(2_000);
  });

  it('never exceeds the cap, however many attempts', () => {
    expect(backoffDelayMs(7, POLICY, () => 0.999)).toBe(59_940);
    expect(backoffDelayMs(50, POLICY, () => 0.999)).toBe(59_940);
    expect(backoffDelayMs(2_000, POLICY, () => 0.999)).toBe(59_940);
  });

  it('can be zero (full jitter) and clamps a random source outside [0, 1)', () => {
    expect(backoffDelayMs(3, POLICY, () => 0)).toBe(0);
    expect(backoffDelayMs(3, POLICY, () => -1)).toBe(0);
    expect(backoffDelayMs(3, POLICY, () => 7)).toBeLessThan(4_000);
    expect(backoffDelayMs(3, POLICY, () => Number.NaN)).toBe(0);
  });

  it('is deterministic for a seeded random source', () => {
    const run = (seed: number) =>
      Array.from({ length: 8 }, (_, i) => backoffDelayMs(i + 1, POLICY, seeded(seed)));
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('rejects a policy or attempt that makes no sense', () => {
    expect(() => backoffDelayMs(0, POLICY, () => 0.5)).toThrow(RangeError);
    expect(() => backoffDelayMs(1.5, POLICY, () => 0.5)).toThrow(RangeError);
    expect(() => backoffDelayMs(1, { baseMs: 0, capMs: 10 }, () => 0.5)).toThrow(RangeError);
    expect(() => backoffDelayMs(1, { baseMs: 100, capMs: 10 }, () => 0.5)).toThrow(RangeError);
  });

  it('always lies between zero and the lesser of the cap and the exponential ceiling', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer(),
        (attempt, baseMs, extra, seed) => {
          const policy = { baseMs, capMs: baseMs + extra };
          const delay = backoffDelayMs(attempt, policy, seeded(seed));
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(policy.capMs);
          expect(delay).toBeLessThanOrEqual(baseMs * 2 ** Math.min(attempt - 1, 60));
        },
      ),
      { seed: 20_261_104, numRuns: 1_000 },
    );
  });
});
