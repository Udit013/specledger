export const PACKAGE_NAME = '@specledger/eval';

export { HOLDOUT_FRACTION, splitFor } from './corpus/split.js';
export {
  DESIGNED_CASES,
  designedCaseSchema,
  fieldTruthSchema,
  groundTruthSchema,
  manifestEntrySchema,
  manifestSchema,
  SPLITS,
  splitSchema,
} from './corpus/truth.js';
export type {
  DesignedCase,
  FieldTruth,
  GroundTruth,
  Manifest,
  ManifestEntry,
  Split,
} from './corpus/truth.js';

// The evaluation harness (Phase 11).
export { loadEvalCorpus } from './eval/corpus-loader.js';
export type { LoadedCorpus } from './eval/corpus-loader.js';
export { isCorrect } from './eval/correctness.js';
export {
  documentExtractionSchema,
  EXTRACTION_ORIGINS,
  extractionSetSchema,
} from './eval/extraction-set.js';
export type { DocumentExtraction, ExtractionSet } from './eval/extraction-set.js';
export { baselineFrom, checkGate } from './eval/gate.js';
export type { Baseline } from './eval/gate.js';
export { metricsFor, proportion, wilson, Z_95 } from './eval/metrics.js';
export type { FieldOutcome, Metrics, Proportion } from './eval/metrics.js';
export {
  renderMarkdown,
  renderReadmeSection,
  replaceReadmeSection,
  reportJson,
} from './eval/report.js';
export { runEvaluation } from './eval/runner.js';
export type { EvalDocument, EvaluationReport, SkipReason } from './eval/runner.js';
export { SIMULATED_LABEL, simulateExtractions } from './eval/simulate.js';
