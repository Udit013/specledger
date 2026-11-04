// The evaluation's metrics, with the formulas written in docs/evaluation.md. Every rate keeps its
// numerator and denominator, so a reader always sees how many documents and fields it rests on.

// z for a two-sided 95 percent interval.
export const Z_95 = 1.959963984540054;

export interface Interval {
  readonly low: number;
  readonly high: number;
}

export interface Proportion {
  readonly numerator: number;
  readonly denominator: number;
  // Rounded to six places; null when nothing was counted.
  readonly rate: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

// One candidate the extraction proposed: whether it matches the ground truth, and whether the
// verifier accepted it.
export interface CandidateOutcome {
  readonly correct: boolean;
  readonly verified: boolean;
}

// One field of one document.
export interface FieldOutcome {
  readonly field: string;
  readonly truthPresent: boolean;
  // Every candidate proposed for the field, in the model's order.
  readonly candidates: readonly CandidateOutcome[];
  // The one the pipeline keeps (pickFields): the first verified, else the first; null if none.
  readonly picked: CandidateOutcome | null;
}

export interface Counts {
  readonly fields: number;
  readonly truthPresent: number;
  readonly accepted: number;
  readonly correctAccepted: number;
  readonly wrongAccepted: number;
  readonly unsupportedAccepted: number;
  readonly candidates: number;
  readonly wrongCandidates: number;
  readonly correctCandidates: number;
}

export interface Metrics {
  readonly precision: Proportion;
  readonly recall: Proportion;
  readonly unsupportedRate: Proportion;
  readonly catchRate: Proportion;
  readonly falseRejectRate: Proportion;
  readonly counts: Counts;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

// The Wilson score interval: unlike the normal approximation it stays inside [0, 1] and is
// meaningful for small samples and for rates near 0 or 1, which is what a corpus of a few dozen
// documents produces.
export function wilson(successes: number, trials: number, z = Z_95): Interval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0) {
    throw new Error('wilson needs whole, non-negative counts');
  }
  if (successes > trials) throw new Error('wilson: more successes than trials');
  if (trials === 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function proportion(numerator: number, denominator: number): Proportion {
  const interval = wilson(numerator, denominator);
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : round(numerator / denominator),
    low: interval === null ? null : round(interval.low),
    high: interval === null ? null : round(interval.high),
  };
}

// pipeline: a field's value is accepted when the picked candidate was verified.
// naive:    the verifier is off; the picked candidate (the model's first) is always accepted,
//           and no candidate is ever rejected.
export function metricsFor(outcomes: readonly FieldOutcome[], mode: 'pipeline' | 'naive'): Metrics {
  const verified = (c: CandidateOutcome) => mode === 'naive' || c.verified;
  let accepted = 0;
  let correctAccepted = 0;
  let unsupportedAccepted = 0;
  let truthPresent = 0;
  let candidates = 0;
  let wrongCandidates = 0;
  let wrongRejected = 0;
  let correctCandidates = 0;
  let correctRejected = 0;

  for (const outcome of outcomes) {
    if (outcome.truthPresent) truthPresent += 1;
    const picked = outcome.picked;
    if (picked !== null && verified(picked)) {
      accepted += 1;
      if (picked.correct) correctAccepted += 1;
      if (!outcome.truthPresent) unsupportedAccepted += 1;
    }
    for (const candidate of outcome.candidates) {
      candidates += 1;
      if (candidate.correct) {
        correctCandidates += 1;
        if (!verified(candidate)) correctRejected += 1;
      } else {
        wrongCandidates += 1;
        if (!verified(candidate)) wrongRejected += 1;
      }
    }
  }

  return {
    precision: proportion(correctAccepted, accepted),
    recall: proportion(correctAccepted, truthPresent),
    unsupportedRate: proportion(unsupportedAccepted, accepted),
    catchRate: proportion(wrongRejected, wrongCandidates),
    falseRejectRate: proportion(correctRejected, correctCandidates),
    counts: {
      fields: outcomes.length,
      truthPresent,
      accepted,
      correctAccepted,
      wrongAccepted: accepted - correctAccepted,
      unsupportedAccepted,
      candidates,
      wrongCandidates,
      correctCandidates,
    },
  };
}
