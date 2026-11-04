import type { Split } from '../corpus/truth.js';
import { notImplemented } from './not-implemented.js';
import type { EvaluationReport } from './runner.js';
export interface Baseline {
  readonly schemaVersion: 1;
  readonly corpusSha256: string;
  readonly setSha256: string;
  readonly split: Split;
  readonly precision: number | null;
  readonly unsupportedRate: number | null;
}
export function baselineFrom(report: EvaluationReport): Baseline {
  return notImplemented('baselineFrom', report);
}
export function checkGate(
  report: EvaluationReport,
  baseline: Baseline,
): { pass: boolean; violations: string[] } {
  return notImplemented('checkGate', report, baseline);
}
