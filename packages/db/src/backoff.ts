import { notImplemented } from './not-implemented.js';

export interface BackoffPolicy {
  // Delay ceiling before the first retry; doubled for each further attempt.
  readonly baseMs: number;
  // No delay exceeds this.
  readonly capMs: number;
}

// Exponential backoff with full jitter: a uniformly random delay between 0 and
// min(capMs, baseMs * 2^(attempt - 1)), where attempt is the attempt that just failed (1 for the
// first). `random` returns a number in [0, 1); it is injected so delays are reproducible. Values
// outside [0, 1) are clamped, and the result is always a whole number of milliseconds in
// [0, capMs].
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number,
): number {
  return notImplemented('backoffDelayMs', attempt, policy, random);
}
