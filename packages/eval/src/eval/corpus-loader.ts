import type { Result } from '@specledger/core';
import type { Split } from '../corpus/truth.js';
import { notImplemented } from './not-implemented.js';
import type { EvalDocument } from './runner.js';
export interface LoadedCorpus {
  readonly corpusSha256: string;
  readonly documents: readonly EvalDocument[];
}
export function loadEvalCorpus(
  dir: string,
  options: { split: Split; allowHoldout: boolean },
): Promise<Result<LoadedCorpus, 'HOLDOUT_REQUIRES_FLAG'>> {
  return Promise.resolve(notImplemented('loadEvalCorpus', dir, options));
}
