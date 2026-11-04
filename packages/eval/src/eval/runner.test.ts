import { describe, expect, it } from 'vitest';

import { reportJson } from './report.js';
import { runEvaluation } from './runner.js';
import { DOCS, SET } from './fixtures.js';

const run = () =>
  runEvaluation({
    documents: DOCS,
    set: SET,
    split: 'dev',
    corpusSha256: 'c'.repeat(64),
    setSha256: 's'.repeat(64),
  });

describe('runEvaluation on constructed documents', () => {
  const report = run();

  it('records what was measured, on what, and when', () => {
    expect(report.extraction).toEqual({
      origin: 'simulated',
      label: 'Constructed test extractions.',
      modelId: 'test-model',
      promptVersion: 'test-prompt',
      date: '2030-01-01',
      setSha256: 's'.repeat(64),
    });
    expect(report.corpus).toEqual({ corpusSha256: 'c'.repeat(64), split: 'dev', holdout: false });
    expect(report.date).toBe('2030-01-01');
  });

  it('skips a document without a text layer, and says why', () => {
    expect(report.documents).toEqual({
      inSplit: 3,
      evaluated: 2,
      skipped: [{ id: 'p-901-scan', reason: 'NO_TEXT_LAYER' }],
    });
  });

  it('counts the pipeline (verifier on) by hand', () => {
    const { overall } = report.pipeline;
    // Accepted: A flow, B flow, B NPSH (unsupported). Correct accepted: 2.
    expect([overall.precision.numerator, overall.precision.denominator]).toEqual([2, 3]);
    // Truth present: A flow, head, efficiency; B flow, head = 5.
    expect([overall.recall.numerator, overall.recall.denominator]).toEqual([2, 5]);
    expect([overall.unsupportedRate.numerator, overall.unsupportedRate.denominator]).toEqual([
      1, 3,
    ]);
    // Wrong candidates: A head, B NPSH, B power; caught: head and power.
    expect([overall.catchRate.numerator, overall.catchRate.denominator]).toEqual([2, 3]);
    // Correct candidates: A flow, A efficiency, B flow; rejected: efficiency.
    expect([overall.falseRejectRate.numerator, overall.falseRejectRate.denominator]).toEqual([
      1, 3,
    ]);
    expect(overall.counts.fields).toBe(16);
  });

  it('counts the naive baseline, and how many wrong values the verifier prevented', () => {
    const { overall } = report.naive;
    expect([overall.precision.numerator, overall.precision.denominator]).toEqual([3, 6]);
    expect(report.prevented).toEqual({
      naiveWrongAccepted: 3,
      pipelineWrongAccepted: 1,
      prevented: 2,
      naiveUnsupportedAccepted: 2,
      pipelineUnsupportedAccepted: 1,
    });
  });

  it('reports per field, sorted by name', () => {
    expect(Object.keys(report.pipeline.perField)).toEqual([
      'design_temperature',
      'efficiency',
      'max_working_pressure',
      'npsh_required',
      'rated_flow',
      'rated_head',
      'rated_power',
      'rated_speed',
    ]);
    expect(report.pipeline.perField.rated_flow?.precision).toMatchObject({
      numerator: 2,
      denominator: 2,
      rate: 1,
    });
  });

  it('checks reconciliation against what the rules select from the ground truth', () => {
    // Truth selects flow 520 gpm (Rev B supersedes Rev A), head 45 m and efficiency 78 % (only
    // Rev A has it). The pipeline selects flow 520 gpm and an NPSH the truth does not have, and
    // has no verified head or efficiency.
    expect(report.reconciliation).toMatchObject({
      equipment: 1,
      expected: { numerator: 1, denominator: 3, rate: 0.333333 },
      conflicts: 0,
      missing: 2,
      unexpected: 1,
    });
  });

  it('gives byte-identical JSON for the same inputs', () => {
    expect(reportJson(run())).toBe(reportJson(report));
  });
});

describe('runEvaluation with missing or failed extractions', () => {
  it('skips documents the set has no extraction for, or whose extraction failed', () => {
    const report = runEvaluation({
      documents: DOCS.slice(0, 2),
      set: { ...SET, documents: { 'p-900-rev-a': { error: 'LLM_TIMEOUT' } } },
      split: 'dev',
      corpusSha256: 'c'.repeat(64),
      setSha256: 's'.repeat(64),
    });
    expect(report.documents.skipped).toEqual([
      { id: 'p-900-rev-a', reason: 'EXTRACTION_FAILED' },
      { id: 'p-900-rev-b', reason: 'NO_EXTRACTION' },
    ]);
    expect(report.pipeline.overall.counts.fields).toBe(0);
    expect(report.pipeline.overall.precision.rate).toBeNull();
  });
});
