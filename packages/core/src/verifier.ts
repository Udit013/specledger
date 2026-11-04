import type { Candidate } from './candidate.js';
import type { FieldDefinition } from './equipment.js';
import { notImplemented } from './not-implemented.js';
import type { NumberHints } from './numbers.js';
import type { VerificationReason, VerificationStatus } from './status.js';

// A normalized quote shorter than this proves nothing: "500 gpm" alone could come from anywhere on
// the page, and the label is what ties a number to a field.
export const MIN_QUOTE_LENGTH = 12;

// Two statements of one quantity in different unit systems agree when they differ by at most this
// fraction of the larger, after both are converted to the canonical unit.
export const DUAL_UNIT_TOLERANCE = 0.005;

export type VerificationHints = NumberHints;

// The candidate's value in the field's canonical unit, computed by the verifier itself.
export type NormalizedValue =
  | { readonly kind: 'scalar'; readonly value: number; readonly unit: string }
  | { readonly kind: 'range'; readonly low: number; readonly high: number; readonly unit: string };

export interface VerificationResult {
  readonly status: VerificationStatus;
  // Every failing rule, in rule order, each at most once. Empty exactly when verified.
  readonly reasons: readonly VerificationReason[];
  // Present whenever the value parses and the unit is known and of the field's dimension, verified
  // or not; null otherwise.
  readonly normalizedValue: NormalizedValue | null;
  // Offsets into the original pageText of the first occurrence of the quote, for highlighting:
  // pageText.slice(start, end) normalizes to the normalized quote. Null when the quote is not on
  // the page.
  readonly quoteSpan: { readonly start: number; readonly end: number } | null;
}

// Decides whether one extracted value is verified. Fail safe: anything not proven is unverified.
// pageText is the stored text of the page the candidate names. Every rule is evaluated, and every
// failure is reported:
//
// (a) QUOTE_TOO_SHORT      the normalized quote is shorter than MIN_QUOTE_LENGTH.
// (b) QUOTE_NOT_FOUND      the normalized quote is not a substring of the normalized page.
// (c) AMBIGUOUS_NUMBER_FORMAT  the value is ambiguous (parseNumber) under the hints.
//     VALUE_NOT_IN_QUOTE   otherwise, the value does not parse, or no number in the quote equals
//                          it (a range must match a range in the quote with the same bounds).
// (d) UNIT_UNKNOWN         the unit is not in the registry.
//     UNIT_MISMATCH        the unit's dimension is not the field's.
// (e) UNIT_MISMATCH        the quote states the quantity in two or more units of the field's
//                          dimension ("287.0 m³/h (1264 gpm)") and, converted by the verifier, they
//                          differ by more than DUAL_UNIT_TOLERANCE. The model's own conversion is
//                          never used.
// (f) OUT_OF_RANGE         the normalized value (both bounds of a range) is outside the field's
//                          plausible range, bounds included as valid.
//
// INTERNAL, alone, for anything inconsistent or unexpected: a candidate for a different field, a
// range for a field whose kind is "scalar", input that is not what the types promise, or any
// exception. verifyCandidate never throws and never verifies in that case.
export function verifyCandidate(
  candidate: Candidate,
  pageText: string,
  field: FieldDefinition,
  hints: VerificationHints = {},
): VerificationResult {
  return notImplemented('verifyCandidate', candidate, pageText, field, hints);
}
