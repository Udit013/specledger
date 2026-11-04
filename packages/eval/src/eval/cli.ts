import type { Result } from '@specledger/core';
import type { Split } from '../corpus/truth.js';
import { notImplemented } from './not-implemented.js';
export function evaluate(
  root: string,
  options: { split: Split; allowHoldout: boolean; extractions?: string },
): Promise<
  Result<{ json: string; markdown: string }, 'HOLDOUT_REQUIRES_FLAG' | 'INVALID_EXTRACTION_SET'>
> {
  return Promise.resolve(notImplemented('evaluate', root, options));
}
