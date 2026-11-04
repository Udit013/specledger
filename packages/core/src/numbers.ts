import { notImplemented } from './not-implemented.js';
import type { Result } from './result.js';

export type DecimalMark = 'point' | 'comma';

// What the caller knows about the document's number style, for example from other values on the
// same page. It only decides tokens that are ambiguous without it.
export interface NumberHints {
  readonly decimalMark?: DecimalMark;
}

export type ParsedNumber =
  | { readonly kind: 'scalar'; readonly value: number }
  | { readonly kind: 'range'; readonly low: number; readonly high: number };

export type NumberErrorCode = 'AMBIGUOUS_NUMBER_FORMAT' | 'INVALID_NUMBER';

export interface NumberError {
  readonly code: NumberErrorCode;
}

// Parses one value token as a datasheet writes it. The token has already been normalized
// (normalizeWithMap), so dashes are "-" and spaces are single.
//
// Scalars: digits with an optional leading "-", an optional decimal part, and optional thousands
// separators ("," "." or a space) in groups of exactly three digits.
//   - Both "," and "." present: the last one is the decimal mark ("1,234.5" and "1.234,5").
//   - A space between digit groups is a thousands separator ("1 234,5").
//   - One separator followed by exactly three digits, with one to three digits before it and the
//     first of them not 0 ("1,234", "1.234"), is AMBIGUOUS_NUMBER_FORMAT unless hints.decimalMark
//     decides it. Followed by any other number of digits it is a decimal mark ("74,3", "113.6").
//     A first group of "0" is never thousands ("0,750" is 0.75).
//   - The same separator repeated is thousands ("1,234,567").
// Ranges: two scalars joined by "-" or " to ", optionally with spaces around "-" ("2900-3600",
// "2900 to 3600", "-20 to 40"). The low bound must not exceed the high bound.
// Anything else is INVALID_NUMBER: exponents ("1e3"), a leading "+" or ".", letters, empty input,
// malformed groups ("1,23,4"), NaN and Infinity.
export function parseNumber(
  token: string,
  hints: NumberHints = {},
): Result<ParsedNumber, NumberError> {
  return notImplemented('parseNumber', token, hints);
}
