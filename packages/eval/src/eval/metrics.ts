import { notImplemented } from './not-implemented.js';
export interface Interval {
  readonly low: number;
  readonly high: number;
}
export interface Proportion {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly low: number | null;
  readonly high: number | null;
}
export interface CandidateOutcome {
  readonly correct: boolean;
  readonly verified: boolean;
}
export interface FieldOutcome {
  readonly field: string;
  readonly truthPresent: boolean;
  readonly candidates: readonly CandidateOutcome[];
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
export function wilson(successes: number, trials: number): Interval | null {
  return notImplemented('wilson', successes, trials);
}
export function proportion(numerator: number, denominator: number): Proportion {
  return notImplemented('proportion', numerator, denominator);
}
export function metricsFor(outcomes: readonly FieldOutcome[], mode: 'pipeline' | 'naive'): Metrics {
  return notImplemented('metricsFor', outcomes, mode);
}
