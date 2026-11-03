import { createHash } from 'node:crypto';

// Seeded pseudo-random source (mulberry32). Each document gets its own stream derived from the
// corpus seed and the document id, so adding or reordering documents never changes the others.
export interface Random {
  next(): number;
  int(min: number, max: number): number;
  between(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

export function randomFor(seed: string, key: string): Random {
  let state = createHash('sha256').update(`${seed}:${key}`).digest().readUInt32BE(0);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    between: (min, max) => min + next() * (max - min),
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
    chance: (probability) => next() < probability,
  };
}
