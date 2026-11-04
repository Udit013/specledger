import { notImplemented } from './not-implemented.js';

// A revision label reduced to something comparable. Letters ("A", "AA") count as drafts and come
// before every numbered issue ("0", "2.1"), following the common engineering convention of
// lettered revisions before issue for construction and numbered ones after.
export type RevisionKey =
  | { readonly kind: 'letter'; readonly ordinal: number }
  | { readonly kind: 'number'; readonly parts: readonly number[] };

// Reads a revision label. Case and surrounding whitespace are ignored. Accepted forms: an optional
// "Rev", "Rev.", "Revision" or (before digits only) "R" prefix, then either one or two letters
// ("Rev A", "Rev. C", "AA"; A is 1, Z is 26, AA is 27) or digits with optional dotted parts
// ("R2", "Revision 3", "2.1"). Anything else, and null, is unknown: null.
export function parseRevision(label: string | null): RevisionKey | null {
  return notImplemented('parseRevision', label);
}

// A total order over revision labels: negative when a is earlier than b, positive when later,
// zero when they name the same revision ("Rev A" and "a", "R2" and "Revision 2", "2" and "2.0").
// Unknown or missing labels come before every known one and are equal to each other, so two
// documents without a usable revision are never ranked against each other. Letters come before
// numbers; letters compare by ordinal; numbers compare part by part, missing parts counting as 0.
export function compareRevisions(a: string | null, b: string | null): number {
  return notImplemented('compareRevisions', a, b);
}
