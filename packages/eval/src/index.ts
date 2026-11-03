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
