import { normalizeValue, normalizeWithMap, valuesAgree } from '@specledger/core';
import type { Candidate, FieldDefinition } from '@specledger/core';

import type { FieldTruth } from '../corpus/truth.js';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalized = (text: string) => normalizeWithMap(text).normalized;

// Whether `text` contains `value` as a whole token: "260" in "Rated head 260 ft", but not in
// "2600" or "1260".
function containsToken(text: string, value: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}.,])${escapeRegExp(value)}(?![\\p{N}]|[.,]\\p{N})`, 'u').test(
    text,
  );
}

// A candidate is correct when the document has a value for the field, the candidate's value
// equals it within 0.5 percent after SI conversion (core's valuesAgree on the verifier's
// canonical values), and its quote is the expected one or contains the expected value. Quotes are
// compared after core's normalization, so whitespace and dash variants do not matter.
export function isCorrect(
  candidate: Candidate,
  truth: FieldTruth | null,
  field: FieldDefinition,
): boolean {
  if (truth === null) return false;
  const expected = normalizeValue(truth.value, truth.unit, field);
  const actual = normalizeValue(candidate.value, candidate.unit, field);
  if (expected === null || actual === null || !valuesAgree(expected, actual)) return false;
  const quote = normalized(candidate.quote);
  return quote === normalized(truth.quote) || containsToken(quote, normalized(truth.value));
}
