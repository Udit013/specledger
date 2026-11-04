import { err, ok } from './result.js';
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

const invalid = () => err<NumberError>({ code: 'INVALID_NUMBER' });
const ambiguous = () => err<NumberError>({ code: 'AMBIGUOUS_NUMBER_FORMAT' });

// Digits, optionally signed, with separators only between digits. Exponents, "+", a leading ".",
// letters, NaN and Infinity all fail here.
const NUMBER_SHAPE = /^-?\d(?:[\d., ]*\d)?$/;
const THOUSANDS_GROUP = /^\d{3}$/;
const LEADING_GROUP = /^\d{1,3}$/;

const isGrouped = (groups: readonly string[]) =>
  LEADING_GROUP.test(groups[0] ?? '') &&
  groups.slice(1).every((group) => THOUSANDS_GROUP.test(group));

// The digits of a scalar without its sign, as a plain decimal string ("1234.5"), or an error.
function plainDigits(body: string, hints: NumberHints): Result<string, NumberError> {
  // A space can only separate thousands; a decimal part, if any, follows the last group.
  if (body.includes(' ')) {
    const spaced = /^(\d{1,3}(?: \d{3})+)(?:[.,](\d+))?$/.exec(body);
    if (spaced?.[1] === undefined) return invalid();
    const integer = spaced[1].replaceAll(' ', '');
    return ok(spaced[2] === undefined ? integer : `${integer}.${spaced[2]}`);
  }

  const lastComma = body.lastIndexOf(',');
  const lastPoint = body.lastIndexOf('.');
  // Both marks: the last one is the decimal mark and the other separates thousands.
  if (lastComma !== -1 && lastPoint !== -1) {
    const decimal = lastComma > lastPoint ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    const [integer, fraction, extra] = body.split(decimal);
    if (extra !== undefined || fraction === undefined || !/^\d+$/.test(fraction)) return invalid();
    const groups = (integer ?? '').split(thousands);
    return isGrouped(groups) ? ok(`${groups.join('')}.${fraction}`) : invalid();
  }

  const separator = lastComma !== -1 ? ',' : lastPoint !== -1 ? '.' : null;
  if (separator === null) return ok(body);
  const parts = body.split(separator);
  // The same mark more than once can only separate thousands.
  if (parts.length > 2) return isGrouped(parts) ? ok(parts.join('')) : invalid();

  const [before = '', after = ''] = parts;
  // "1,234" reads as either 1234 or 1.234. A leading group of 0 cannot be thousands.
  if (after.length === 3 && before.length <= 3 && !before.startsWith('0')) {
    if (hints.decimalMark === undefined) return ambiguous();
    const isDecimal = (hints.decimalMark === 'comma') === (separator === ',');
    return ok(isDecimal ? `${before}.${after}` : `${before}${after}`);
  }
  return ok(`${before}.${after}`);
}

function parseScalar(token: string, hints: NumberHints): Result<number, NumberError> {
  const text = token.trim();
  if (!NUMBER_SHAPE.test(text)) return invalid();
  const negative = text.startsWith('-');
  const digits = plainDigits(negative ? text.slice(1) : text, hints);
  if (!digits.ok) return digits;
  const value = Number(digits.value);
  if (!Number.isFinite(value)) return invalid();
  return ok(negative ? -value : value);
}

// Splits "A to B", or "A-B" where the "-" follows a digit (so "-20" keeps its sign), into its two
// bounds. Returns null for a token that is not a range.
function splitRange(text: string): readonly [string, string] | null {
  const to = /^(.+?)\s+to\s+(.+)$/.exec(text);
  if (to?.[1] !== undefined && to[2] !== undefined) return [to[1], to[2]];
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === '-' && /\d$/.test(text.slice(0, index).trimEnd())) {
      return [text.slice(0, index), text.slice(index + 1)];
    }
  }
  return null;
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
  const text = token.trim();
  const bounds = splitRange(text);
  if (bounds === null) {
    const value = parseScalar(text, hints);
    return value.ok ? ok({ kind: 'scalar', value: value.value }) : value;
  }
  const low = parseScalar(bounds[0], hints);
  const high = parseScalar(bounds[1], hints);
  // A bound that is not a number at all makes the range invalid; otherwise an ambiguous bound
  // makes it ambiguous.
  if (!low.ok || !high.ok) {
    const failures = [low, high].flatMap((bound) => (bound.ok ? [] : [bound.error.code]));
    return failures.includes('INVALID_NUMBER') ? invalid() : ambiguous();
  }
  if (low.value > high.value) return invalid();
  return ok({ kind: 'range', low: low.value, high: high.value });
}
