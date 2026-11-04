import type { Candidate, FieldDefinition } from '@specledger/core';
import type { FieldTruth } from '../corpus/truth.js';
import { notImplemented } from './not-implemented.js';
export function isCorrect(
  candidate: Candidate,
  truth: FieldTruth | null,
  field: FieldDefinition,
): boolean {
  return notImplemented('isCorrect', candidate, truth, field);
}
