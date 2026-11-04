import { describe, expect, it } from 'vitest';

import { DOCS, SET } from './fixtures.js';
import { baselineFrom, checkGate } from './gate.js';
import type { EvaluationReport } from './runner.js';
import { runEvaluation } from './runner.js';

const report = runEvaluation({
  documents: DOCS,
  set: SET,
  split: 'dev',
  corpusSha256: 'c'.repeat(64),
  setSha256: 's'.repeat(64),
});
const baseline = baselineFrom(report);

// A copy of the report with the pipeline's overall rates changed, as a regression would.
function regressed(change: { precision?: number; unsupportedRate?: number }): EvaluationReport {
  const overall = report.pipeline.overall;
  return {
    ...report,
    pipeline: {
      ...report.pipeline,
      overall: {
        ...overall,
        precision: { ...overall.precision, rate: change.precision ?? overall.precision.rate },
        unsupportedRate: {
          ...overall.unsupportedRate,
          rate: change.unsupportedRate ?? overall.unsupportedRate.rate,
        },
      },
    },
  };
}

describe('checkGate', () => {
  it('records the baseline from a report', () => {
    expect(baseline).toEqual({
      schemaVersion: 1,
      corpusSha256: 'c'.repeat(64),
      setSha256: 's'.repeat(64),
      split: 'dev',
      precision: 0.666667,
      unsupportedRate: 0.333333,
    });
  });

  it('passes on the baseline itself', () => {
    expect(checkGate(report, baseline)).toEqual({ pass: true, violations: [] });
  });

  it('fails when precision drops, by any amount', () => {
    const result = checkGate(regressed({ precision: 0.666666 }), baseline);
    expect(result.pass).toBe(false);
    expect(result.violations).toEqual(['precision fell from 0.666667 to 0.666666']);
  });

  it('fails when the unsupported-value rate rises, by any amount', () => {
    const result = checkGate(regressed({ unsupportedRate: 0.333334 }), baseline);
    expect(result.violations).toEqual(['unsupported-value rate rose from 0.333333 to 0.333334']);
  });

  it('passes an improvement', () => {
    expect(checkGate(regressed({ precision: 0.9, unsupportedRate: 0.1 }), baseline).pass).toBe(
      true,
    );
  });

  it('fails when precision cannot be computed any more', () => {
    expect(checkGate(regressed({ precision: Number.NaN }), baseline).pass).toBe(false);
  });

  it('refuses a baseline taken on another corpus, extraction set or split', () => {
    for (const other of [
      { ...baseline, corpusSha256: 'd'.repeat(64) },
      { ...baseline, setSha256: 't'.repeat(64) },
      { ...baseline, split: 'holdout' as const },
    ]) {
      const result = checkGate(report, other);
      expect(result.pass).toBe(false);
      expect(result.violations[0]).toMatch(/baseline was taken on/);
    }
  });
});
