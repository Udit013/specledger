import type { ExtractionSet } from './extraction-set.js';
import { notImplemented } from './not-implemented.js';
import type { EvalDocument } from './runner.js';
export const SIMULATED_LABEL = 'stub';
export function simulateExtractions(
  documents: readonly EvalDocument[],
  options: { seed: string; date: string; corpusSha256: string },
): ExtractionSet {
  return notImplemented('simulateExtractions', documents, options);
}
