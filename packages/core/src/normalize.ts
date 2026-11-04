export interface NormalizedText {
  readonly normalized: string;
  // map[i] is the offset, in UTF-16 code units, of the original character that produced
  // normalized[i]. It has exactly normalized.length entries and never decreases. Characters that
  // came from one original character (NFKC turns "ﬁ" into "fi") share its offset; a space that
  // replaced a whitespace run maps to the run's first character.
  readonly map: readonly number[];
}

// One character of the text being normalized, with the offset of the original it came from.
interface Unit {
  readonly char: string;
  readonly offset: number;
}

const INVISIBLE: ReadonlySet<string> = new Set(['​', '‌', '‍', '⁠', '﻿', '­']);
const SINGLE_QUOTES: ReadonlySet<string> = new Set(['‘', '’', '‚', '‛']);
const DOUBLE_QUOTES: ReadonlySet<string> = new Set(['“', '”', '„', '‟']);

// A base character with the combining marks that follow it. NFKC is applied per cluster, not per
// code point, so that "e" plus a combining acute composes to "é" and the map stays per cluster.
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gsu;

const isLetter = (char: string | undefined) => char !== undefined && /\p{L}/u.test(char);
const isWhitespace = (char: string) => /\s/u.test(char);
const isLineBreak = (char: string | undefined) => char === '\n' || char === '\r';

// Steps 1 to 3: NFKC, invisible characters removed, quotes and dashes unified.
function decompose(text: string): Unit[] {
  const units: Unit[] = [];
  for (const cluster of text.matchAll(CLUSTER)) {
    for (const char of cluster[0].normalize('NFKC')) {
      if (INVISIBLE.has(char)) continue;
      let unified = char;
      if (SINGLE_QUOTES.has(char)) unified = "'";
      else if (DOUBLE_QUOTES.has(char)) unified = '"';
      else if (/[‐-―−]/u.test(char)) unified = '-';
      // A character outside the BMP is two code units; both keep the cluster's offset.
      for (const codeUnit of unified.split(''))
        units.push({ char: codeUnit, offset: cluster.index });
    }
  }
  return units;
}

// Step 4: a letter, "-", spaces or tabs, a line break, any whitespace, then a letter: the hyphen and
// the whitespace go, so the two halves of the word meet.
function joinHyphenatedWords(units: readonly Unit[]): Unit[] {
  const joined: Unit[] = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit === undefined) continue;
    if (unit.char === '-' && isLetter(joined.at(-1)?.char)) {
      let next = index + 1;
      while (units[next]?.char === ' ' || units[next]?.char === '\t') next += 1;
      if (isLineBreak(units[next]?.char)) {
        while (next < units.length && isWhitespace(units[next]?.char ?? '')) next += 1;
        if (isLetter(units[next]?.char)) {
          index = next - 1;
          continue;
        }
      }
    }
    joined.push(unit);
  }
  return joined;
}

// Step 5: whitespace runs become one space at the run's first offset; the ends are trimmed.
function collapseWhitespace(units: readonly Unit[]): Unit[] {
  const collapsed: Unit[] = [];
  for (const unit of units) {
    if (!isWhitespace(unit.char)) collapsed.push(unit);
    else if (collapsed.length > 0 && collapsed.at(-1)?.char !== ' ') {
      collapsed.push({ char: ' ', offset: unit.offset });
    }
  }
  if (collapsed.at(-1)?.char === ' ') collapsed.pop();
  return collapsed;
}

// Normalization shared by quotes and pages, so that formatting differences between the model's
// quote and the page text do not decide whether a quote is found. In order:
//
// 1. NFKC (fullwidth digits, ligatures, "m³" to "m3", "℃" to "°C").
// 2. Zero-width and invisible characters are removed: U+200B, U+200C, U+200D, U+2060, U+FEFF and
//    the soft hyphen U+00AD.
// 3. Quote, dash and minus variants are unified: ‘ ’ ‚ ‛ become ', “ ” „ ‟ become ", and the
//    hyphen and dash variants U+2010 to U+2015 and the minus sign U+2212 become "-".
// 4. A word broken by a hyphen at a line end is joined: a letter, "-", optional spaces or tabs, a
//    line break, optional whitespace, then a letter, becomes the two letters with nothing between
//    ("centri-\nfugal" to "centrifugal"). Digits are not joined ("1450-\n1780" keeps its hyphen).
// 5. Every run of whitespace (including line breaks, tabs and no-break spaces) becomes one space,
//    and leading and trailing whitespace is removed.
export function normalizeWithMap(text: string): NormalizedText {
  const units = collapseWhitespace(joinHyphenatedWords(decompose(text)));
  return {
    normalized: units.map((unit) => unit.char).join(''),
    map: units.map((unit) => unit.offset),
  };
}
