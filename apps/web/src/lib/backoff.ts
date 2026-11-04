export interface PollOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
}

// The wait before the next poll: the base doubled for each poll in a row that saw no change, up to
// the cap. A change resets the count, so a busy queue is followed closely and an idle one rarely.
export function pollDelay(unchangedPolls: number, options: PollOptions = {}): number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 30_000;
  const n = Number.isFinite(unchangedPolls) ? Math.max(0, Math.floor(unchangedPolls)) : 64;
  return Math.min(max, base * 2 ** Math.min(n, 30));
}
