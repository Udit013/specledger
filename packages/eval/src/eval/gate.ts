import type { Split } from '../corpus/truth.js';
import type { EvaluationReport } from './runner.js';

// The committed baseline the regression gate compares with. Replay is deterministic, so the
// comparison is exact: any drop in precision or rise in the unsupported-value rate fails.
export interface Baseline {
  readonly schemaVersion: 1;
  readonly corpusSha256: string;
  readonly setSha256: string;
  readonly split: Split;
  readonly precision: number | null;
  readonly unsupportedRate: number | null;
}

export function baselineFrom(report: EvaluationReport): Baseline {
  return {
    schemaVersion: 1,
    corpusSha256: report.corpus.corpusSha256,
    setSha256: report.extraction.setSha256,
    split: report.corpus.split,
    precision: report.pipeline.overall.precision.rate,
    unsupportedRate: report.pipeline.overall.unsupportedRate.rate,
  };
}

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

export function checkGate(
  report: EvaluationReport,
  baseline: Baseline,
): { pass: boolean; violations: string[] } {
  const current = baselineFrom(report);
  if (
    current.corpusSha256 !== baseline.corpusSha256 ||
    current.setSha256 !== baseline.setSha256 ||
    current.split !== baseline.split
  ) {
    return {
      pass: false,
      violations: [
        'the baseline was taken on another corpus, extraction set or split; regenerate it deliberately with `pnpm eval:baseline`',
      ],
    };
  }
  const violations: string[] = [];
  if (finite(baseline.precision)) {
    if (!finite(current.precision) || current.precision < baseline.precision) {
      violations.push(
        `precision fell from ${String(baseline.precision)} to ${String(current.precision)}`,
      );
    }
  }
  if (finite(baseline.unsupportedRate)) {
    if (!finite(current.unsupportedRate) || current.unsupportedRate > baseline.unsupportedRate) {
      violations.push(
        `unsupported-value rate rose from ${String(baseline.unsupportedRate)} to ${String(current.unsupportedRate)}`,
      );
    }
  }
  return { pass: violations.length === 0, violations };
}
