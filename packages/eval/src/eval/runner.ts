import type { DesignedCase, GroundTruth, Split } from '../corpus/truth.js';
import type { ExtractionSet } from './extraction-set.js';
import type { Metrics, Proportion } from './metrics.js';
import { notImplemented } from './not-implemented.js';
export interface EvalDocument {
  readonly id: string;
  readonly split: Split;
  readonly cases: readonly DesignedCase[];
  readonly truth: GroundTruth;
  readonly pages: readonly string[] | null;
}
export type SkipReason = 'NO_TEXT_LAYER' | 'NO_EXTRACTION' | 'EXTRACTION_FAILED';
export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly date: string;
  readonly extraction: {
    readonly origin: ExtractionSet['origin'];
    readonly label: string;
    readonly modelId: string;
    readonly promptVersion: string;
    readonly date: string;
    readonly setSha256: string;
  };
  readonly corpus: {
    readonly corpusSha256: string;
    readonly split: Split;
    readonly holdout: boolean;
  };
  readonly documents: {
    readonly inSplit: number;
    readonly evaluated: number;
    readonly skipped: readonly { readonly id: string; readonly reason: SkipReason }[];
  };
  readonly pipeline: {
    readonly overall: Metrics;
    readonly perField: Readonly<Record<string, Metrics>>;
  };
  readonly naive: {
    readonly overall: Metrics;
    readonly perField: Readonly<Record<string, Metrics>>;
  };
  readonly prevented: {
    readonly naiveWrongAccepted: number;
    readonly pipelineWrongAccepted: number;
    readonly prevented: number;
    readonly naiveUnsupportedAccepted: number;
    readonly pipelineUnsupportedAccepted: number;
  };
  readonly reconciliation: {
    readonly equipment: number;
    readonly expected: Proportion;
    readonly conflicts: number;
    readonly missing: number;
    readonly unexpected: number;
  };
  readonly limits: readonly string[];
}
export interface EvaluationInput {
  readonly documents: readonly EvalDocument[];
  readonly set: ExtractionSet;
  readonly split: Split;
  readonly corpusSha256: string;
  readonly setSha256: string;
}
export function runEvaluation(input: EvaluationInput): EvaluationReport {
  return notImplemented('runEvaluation', input);
}
