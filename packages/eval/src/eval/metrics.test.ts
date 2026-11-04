import { describe, expect, it } from 'vitest';

import { metricsFor, proportion, wilson } from './metrics.js';
import type { FieldOutcome } from './metrics.js';

describe('wilson', () => {
  // Reference values computed independently (score interval, z = 1.959964).
  it.each([
    [8, 10, 0.490162, 0.943318],
    [0, 10, 0, 0.277533],
    [10, 10, 0.722467, 1],
    [5, 10, 0.236593, 0.763407],
    [1, 1, 0.206549, 1],
    [45, 50, 0.786398, 0.956524],
    [3, 250, 0.004089, 0.034681],
  ])('%i of %i is [%f, %f]', (k, n, low, high) => {
    const interval = wilson(k, n);
    expect(interval?.low).toBeCloseTo(low, 6);
    expect(interval?.high).toBeCloseTo(high, 6);
  });

  it('has no interval for no trials, and refuses impossible counts', () => {
    expect(wilson(0, 0)).toBeNull();
    expect(() => wilson(3, 2)).toThrow();
    expect(() => wilson(-1, 2)).toThrow();
    expect(() => wilson(1.5, 2)).toThrow();
  });
});

describe('proportion', () => {
  it('carries the counts with the rate and interval, rounded to six places', () => {
    expect(proportion(8, 10)).toEqual({
      numerator: 8,
      denominator: 10,
      rate: 0.8,
      low: 0.490162,
      high: 0.943318,
    });
    expect(proportion(1, 3).rate).toBe(0.333333);
  });

  it('reports no rate when nothing was counted', () => {
    expect(proportion(0, 0)).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      low: null,
      high: null,
    });
  });
});

// A small constructed confusion matrix, counted by hand:
//   f1 truth present, picked correct and verified      -> accepted, correct
//   f2 truth present, picked wrong and verified        -> accepted, wrong
//   f3 truth present, picked correct but rejected      -> not accepted (a false reject)
//   f4 truth present, no candidate                     -> missed
//   f5 truth absent, picked wrong and verified         -> accepted, unsupported
//   f6 truth absent, picked wrong and rejected         -> caught
// Candidates: f1 one correct accepted; f2 one wrong accepted; f3 one correct rejected;
// f5 one wrong accepted; f6 one wrong rejected plus one more wrong rejected.
const at = (correct: boolean, verified: boolean) => ({ correct, verified });
const OUTCOMES: FieldOutcome[] = [
  { field: 'f1', truthPresent: true, candidates: [at(true, true)], picked: at(true, true) },
  { field: 'f2', truthPresent: true, candidates: [at(false, true)], picked: at(false, true) },
  { field: 'f3', truthPresent: true, candidates: [at(true, false)], picked: at(true, false) },
  { field: 'f4', truthPresent: true, candidates: [], picked: null },
  { field: 'f5', truthPresent: false, candidates: [at(false, true)], picked: at(false, true) },
  {
    field: 'f6',
    truthPresent: false,
    candidates: [at(false, false), at(false, false)],
    picked: at(false, false),
  },
];

describe('metricsFor (pipeline: accepted means verified)', () => {
  const m = metricsFor(OUTCOMES, 'pipeline');

  it('precision = correct accepted / accepted', () => {
    expect([m.precision.numerator, m.precision.denominator]).toEqual([1, 3]);
  });
  it('recall = correct accepted / truth present', () => {
    expect([m.recall.numerator, m.recall.denominator]).toEqual([1, 4]);
  });
  it('unsupported-value rate = accepted where truth is absent / all accepted', () => {
    expect([m.unsupportedRate.numerator, m.unsupportedRate.denominator]).toEqual([1, 3]);
  });
  it('verifier catch rate = wrong candidates rejected / all wrong candidates', () => {
    expect([m.catchRate.numerator, m.catchRate.denominator]).toEqual([2, 4]);
  });
  it('false-reject rate = correct candidates rejected / all correct candidates', () => {
    expect([m.falseRejectRate.numerator, m.falseRejectRate.denominator]).toEqual([1, 2]);
  });
  it('counts what the rates are built on', () => {
    expect(m.counts).toEqual({
      fields: 6,
      truthPresent: 4,
      accepted: 3,
      correctAccepted: 1,
      wrongAccepted: 2,
      unsupportedAccepted: 1,
      candidates: 6,
      wrongCandidates: 4,
      correctCandidates: 2,
    });
  });
});

describe('metricsFor (naive: every picked candidate is accepted)', () => {
  const m = metricsFor(OUTCOMES, 'naive');

  it('accepts what the verifier rejected', () => {
    expect([m.precision.numerator, m.precision.denominator]).toEqual([2, 5]);
    expect([m.recall.numerator, m.recall.denominator]).toEqual([2, 4]);
    expect([m.unsupportedRate.numerator, m.unsupportedRate.denominator]).toEqual([2, 5]);
    expect(m.counts.wrongAccepted).toBe(3);
  });

  it('catches nothing and rejects nothing', () => {
    expect([m.catchRate.numerator, m.catchRate.denominator]).toEqual([0, 4]);
    expect([m.falseRejectRate.numerator, m.falseRejectRate.denominator]).toEqual([0, 2]);
  });
});
