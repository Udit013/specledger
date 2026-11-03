import { describe, expect, it } from 'vitest';

import { HOLDOUT_FRACTION, splitFor } from './split.js';

describe('splitFor', () => {
  it('is stable for a fixed id', () => {
    expect(splitFor('p-101')).toBe(splitFor('p-101'));
    // Pinned values: a change to the salt or the hashing would reassign the holdout.
    expect(['p-106', 'p-107', 'm-203', 'm-205'].map((id) => splitFor(id))).toEqual([
      'dev',
      'holdout',
      'dev',
      'holdout',
    ]);
  });

  it('assigns close to the holdout fraction over many ids', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `lineage-${String(i)}`);
    const holdout = ids.filter((id) => splitFor(id) === 'holdout').length / ids.length;
    expect(holdout).toBeGreaterThan(HOLDOUT_FRACTION - 0.02);
    expect(holdout).toBeLessThan(HOLDOUT_FRACTION + 0.02);
  });

  it('honours the fraction at its extremes', () => {
    expect(splitFor('p-101', 0.000001)).toBe('dev');
    expect(splitFor('p-101', 0.999999)).toBe('holdout');
  });
});
