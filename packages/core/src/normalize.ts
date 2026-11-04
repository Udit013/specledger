import { notImplemented } from './not-implemented.js';

export interface NormalizedText {
  readonly normalized: string;
  // map[i] is the offset, in UTF-16 code units, of the original character that produced
  // normalized[i]. It has exactly normalized.length entries and never decreases. Characters that
  // came from one original character (NFKC turns "ﬁ" into "fi") share its offset; a space that
  // replaced a whitespace run maps to the run's first character.
  readonly map: readonly number[];
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
  return notImplemented('normalizeWithMap', text);
}
