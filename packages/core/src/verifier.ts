import type { Candidate } from './candidate.js';
import { CANONICAL_UNITS, FIELD_KINDS } from './equipment.js';
import type { FieldDefinition } from './equipment.js';
import { normalizeWithMap } from './normalize.js';
import type { NormalizedText } from './normalize.js';
import { parseNumber } from './numbers.js';
import type { NumberHints, ParsedNumber } from './numbers.js';
import type { VerificationReason, VerificationStatus } from './status.js';
import { parseUnit, toCanonical } from './units.js';
import type { UnitDefinition } from './units.js';

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

type Span = NonNullable<VerificationResult['quoteSpan']>;

// The order reasons are reported in, which is the order of the rules below.
const RULE_ORDER: readonly VerificationReason[] = [
  'QUOTE_TOO_SHORT',
  'QUOTE_NOT_FOUND',
  'AMBIGUOUS_NUMBER_FORMAT',
  'VALUE_NOT_IN_QUOTE',
  'UNIT_UNKNOWN',
  'UNIT_MISMATCH',
  'OUT_OF_RANGE',
];

const INTERNAL: VerificationResult = Object.freeze({
  status: 'unverified',
  reasons: Object.freeze(['INTERNAL'] as const),
  normalizedValue: null,
  quoteSpan: null,
});

// The types promise this already; the verifier checks anyway, because its input is assembled from
// model output and stored rows, and a wrong shape must end as INTERNAL rather than a crash.
function isWellFormed(candidate: unknown, pageText: unknown, field: unknown): boolean {
  if (typeof pageText !== 'string') return false;
  if (typeof candidate !== 'object' || candidate === null) return false;
  if (typeof field !== 'object' || field === null) return false;
  const c = candidate as Record<string, unknown>;
  const f = field as Partial<FieldDefinition>;
  if (![c.fieldName, c.value, c.unit, c.quote].every((part) => typeof part === 'string')) {
    return false;
  }
  if (typeof f.dimension !== 'string' || !Object.hasOwn(CANONICAL_UNITS, f.dimension)) return false;
  if (!(FIELD_KINDS as readonly unknown[]).includes(f.kind)) return false;
  const range = f.plausibleRange;
  return (
    typeof range === 'object' &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.min < range.max &&
    c.fieldName === f.name
  );
}

// Where the normalized quote first occurs in the original page, or null.
function findQuote(quote: string, page: NormalizedText, pageText: string): Span | null {
  if (quote.length === 0) return null;
  const at = page.normalized.indexOf(quote);
  if (at === -1) return null;
  const start = page.map[at];
  const lastStart = page.map[at + quote.length - 1];
  if (start === undefined || lastStart === undefined) return null;
  // The span ends after the whole original character (with its combining marks) that produced the
  // quote's last normalized character.
  const last = /\P{M}\p{M}*|\p{M}+/su.exec(pageText.slice(lastStart))?.[0] ?? '';
  return { start, end: lastStart + Math.max(1, last.length) };
}

interface NumberToken {
  readonly text: string;
  readonly end: number;
}

// The numbers in a normalized quote, read with the same grammar as parseNumber and preferring the
// longest reading, so "2900 to 3600" and "1450-1780" are one range each, not two numbers. A "-" is
// a sign only at the start, or after "(", ":" or a space that does not follow a digit; otherwise it
// is part of a label or joins a range. Digits written straight after a letter, or after a letter
// and "-", belong to an identifier and are not numbers: "P-101", "m3/h", "DN100".
function numberTokens(quote: string): NumberToken[] {
  const scalars: { start: number; end: number }[] = [];
  for (const match of quote.matchAll(/-?\d(?:[\d.,]*\d)?/g)) {
    let start = match.index;
    if (match[0].startsWith('-')) {
      const before = quote.slice(0, start);
      const isSign = before === '' || (/[\s(:]$/.test(before) && !/\d\s*$/.test(before));
      if (!isSign) start += 1;
    }
    if (/\p{L}-?$/u.test(quote.slice(0, start))) continue;
    scalars.push({ start, end: match.index + match[0].length });
  }
  const tokens: NumberToken[] = [];
  for (let index = 0; index < scalars.length; index += 1) {
    const first = scalars[index];
    if (first === undefined) continue;
    const second = scalars[index + 1];
    const gap = second === undefined ? '' : quote.slice(first.end, second.start);
    if (second !== undefined && (/^\s*-\s*$/.test(gap) || /^\s+to\s+$/.test(gap))) {
      tokens.push({ text: quote.slice(first.start, second.end), end: second.end });
      index += 1;
    } else {
      tokens.push({ text: quote.slice(first.start, first.end), end: first.end });
    }
  }
  return tokens;
}

// The unit bound to a number: the spelling written immediately after it, with at most one space
// between (the quote is normalized, so whitespace runs are single spaces), trying a two-word
// spelling ("US gpm") before one word. A unit word stops at brackets and punctuation, none of which
// occurs in a registry spelling, so "45 m." binds "m" and "500 (gpm)" binds nothing. This is a
// grammar, not a distance heuristic: a number followed by anything else has no unit.
function unitAfter(quote: string, end: number): UnitDefinition | null {
  const words = /^ ?([^\s(),;:.!?]+)(?: ([^\s(),;:.!?]+))?/.exec(quote.slice(end));
  if (words?.[1] === undefined) return null;
  if (words[2] !== undefined) {
    const twoWords = parseUnit(`${words[1]} ${words[2]}`);
    if (twoWords.ok) return twoWords.value;
  }
  const oneWord = parseUnit(words[1]);
  return oneWord.ok ? oneWord.value : null;
}

const sameNumber = (a: ParsedNumber, b: ParsedNumber): boolean =>
  a.kind === 'scalar'
    ? b.kind === 'scalar' && a.value === b.value
    : b.kind === 'range' && a.low === b.low && a.high === b.high;

const boundsOf = (value: ParsedNumber): number[] =>
  value.kind === 'scalar' ? [value.value] : [value.low, value.high];

const agree = (a: number, b: number) =>
  Math.abs(a - b) <= DUAL_UNIT_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));

// (e): every statement of the field's quantity in the quote, converted by the verifier, agrees
// with every other. Only applies when the quote uses more than one unit for the quantity.
function dualUnitsAgree(
  quote: string,
  tokens: readonly NumberToken[],
  field: FieldDefinition,
  hints: NumberHints,
): boolean {
  const statements: { symbol: string; values: number[] }[] = [];
  for (const token of tokens) {
    const value = parseNumber(token.text, hints);
    const stated = unitAfter(quote, token.end);
    if (!value.ok || stated === null || stated.dimension !== field.dimension) continue;
    statements.push({
      symbol: stated.symbol,
      values: boundsOf(value.value).map((bound) => toCanonical(bound, stated)),
    });
  }
  if (new Set(statements.map((s) => s.symbol)).size < 2) return true;
  return statements.every((a) =>
    statements.every(
      (b) =>
        a.values.length === b.values.length &&
        a.values.every((value, index) => agree(value, b.values[index] ?? Number.NaN)),
    ),
  );
}

function normalize(value: ParsedNumber, unit: UnitDefinition, field: FieldDefinition) {
  const canonicalUnit = CANONICAL_UNITS[field.dimension];
  const normalized: NormalizedValue =
    value.kind === 'scalar'
      ? { kind: 'scalar', value: toCanonical(value.value, unit), unit: canonicalUnit }
      : {
          kind: 'range',
          low: toCanonical(value.low, unit),
          high: toCanonical(value.high, unit),
          unit: canonicalUnit,
        };
  return normalized;
}

// The canonical value of a stated value and unit for a field, exactly as the verifier computes it:
// null when the value does not parse under the hints, the unit is unknown, or the unit measures
// another quantity. Reconciliation uses it to re-derive canonical values from stored fields.
export function normalizeValue(
  value: string,
  unit: string,
  field: FieldDefinition,
  hints: VerificationHints = {},
): NormalizedValue | null {
  const parsed = parseNumber(normalizeWithMap(value).normalized, hints);
  const stated = parseUnit(unit);
  if (!parsed.ok || !stated.ok || stated.value.dimension !== field.dimension) return null;
  return normalize(parsed.value, stated.value, field);
}

function check(
  candidate: Candidate,
  pageText: string,
  field: FieldDefinition,
  hints: VerificationHints,
): VerificationResult {
  const reasons = new Set<VerificationReason>();
  const quote = normalizeWithMap(candidate.quote).normalized;

  // (a) and (b): the quote is long enough to mean something, and it is on the page.
  if (quote.length < MIN_QUOTE_LENGTH) reasons.add('QUOTE_TOO_SHORT');
  const quoteSpan = findQuote(quote, normalizeWithMap(pageText), pageText);
  if (quoteSpan === null) reasons.add('QUOTE_NOT_FOUND');

  // (c): the stated value is one of the numbers in the quote.
  const value = parseNumber(normalizeWithMap(candidate.value).normalized, hints);
  if (value.ok && value.value.kind === 'range' && field.kind === 'scalar') return INTERNAL;
  const tokens = numberTokens(quote);
  if (!value.ok) {
    reasons.add(
      value.error.code === 'AMBIGUOUS_NUMBER_FORMAT'
        ? 'AMBIGUOUS_NUMBER_FORMAT'
        : 'VALUE_NOT_IN_QUOTE',
    );
  }
  const matches = value.ok
    ? tokens.filter((token) => {
        const stated = parseNumber(token.text, hints);
        return stated.ok && sameNumber(stated.value, value.value);
      })
    : [];
  if (value.ok && matches.length === 0) reasons.add('VALUE_NOT_IN_QUOTE');

  // (d): the unit is known and measures the field's quantity, and the quote states the value in
  // that unit: some occurrence of the value has the candidate's unit bound to it (aliases count as
  // the same unit). Otherwise the quote proves a number, but not this quantity: "287.0 m³/h
  // (1264 gpm)" does not support "1264 m³/h", and "45.0 kW at 2900 rpm" does not support "2900 kW".
  const unit = parseUnit(candidate.unit);
  if (!unit.ok) reasons.add('UNIT_UNKNOWN');
  else if (unit.value.dimension !== field.dimension) reasons.add('UNIT_MISMATCH');
  else if (
    matches.length > 0 &&
    !matches.some((token) => unitAfter(quote, token.end)?.symbol === unit.value.symbol)
  ) {
    reasons.add('UNIT_MISMATCH');
  }

  // (e): two unit systems in the quote agree, by the verifier's own conversion.
  if (!dualUnitsAgree(quote, tokens, field, hints)) reasons.add('UNIT_MISMATCH');

  // (f): the value, in the canonical unit, is plausible for the field (bounds included).
  let normalizedValue: NormalizedValue | null = null;
  if (value.ok && unit.ok && unit.value.dimension === field.dimension) {
    normalizedValue = normalize(value.value, unit.value, field);
    const values =
      normalizedValue.kind === 'scalar'
        ? [normalizedValue.value]
        : [normalizedValue.low, normalizedValue.high];
    const { min, max } = field.plausibleRange;
    if (values.some((v) => !(v >= min && v <= max))) reasons.add('OUT_OF_RANGE');
  }

  const ordered = RULE_ORDER.filter((reason) => reasons.has(reason));
  return {
    status: ordered.length === 0 ? 'verified' : 'unverified',
    reasons: ordered,
    normalizedValue,
    quoteSpan,
  };
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
//     UNIT_MISMATCH        the unit's dimension is not the field's, or the value is in the quote
//                          but never with this unit bound to it (the unit written immediately
//                          after the number; aliases are the same unit).
// (e) UNIT_MISMATCH        the quote states the quantity in two or more units of the field's
//                          dimension ("287.0 m³/h (1264 gpm)") and, converted by the verifier, they
//                          differ by more than DUAL_UNIT_TOLERANCE. The model's own conversion is
//                          never used.
// (f) OUT_OF_RANGE         the normalized value (both bounds of a range) is outside the field's
//                          plausible range, bounds included as valid. Checked only when the value
//                          could be normalized.
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
  try {
    if (!isWellFormed(candidate, pageText, field)) return INTERNAL;
    return check(candidate, pageText, field, hints);
  } catch {
    return INTERNAL;
  }
}
