import { createHash } from 'node:crypto';

import type { Split } from './truth.js';

// Share of lineages assigned to the holdout split. The holdout is never used to tune prompts or
// verifier rules (docs/evaluation.md).
export const HOLDOUT_FRACTION = 0.3;

// Changing this salt reshuffles every assignment, which would invalidate the holdout. Never change
// it for an existing corpus.
const SPLIT_SALT = 'specledger-split-v1';

// The split is keyed by lineage, not by document, so the revisions and the brochure of one piece
// of equipment always land in the same split: otherwise a reconciliation case could be half tuned
// on and half held out.
export function splitFor(lineageId: string, holdoutFraction = HOLDOUT_FRACTION): Split {
  const digest = createHash('sha256').update(`${SPLIT_SALT}:${lineageId}`).digest();
  const unit = digest.readUInt32BE(0) / 2 ** 32;
  return unit < holdoutFraction ? 'holdout' : 'dev';
}
