// A revision label reduced to something comparable. Letters ("A", "AA") count as drafts and come
// before every numbered issue ("0", "2.1"), following the common engineering convention of
// lettered revisions before issue for construction and numbered ones after.
export type RevisionKey =
  | { readonly kind: 'letter'; readonly ordinal: number }
  | { readonly kind: 'number'; readonly parts: readonly number[] };

// An optional prefix, then one or two letters or dotted digits. "R" is only a prefix before digits:
// on its own, or before letters, it is itself a letter ("R" is revision 18).
const LETTERS = /^(?:rev(?:ision)?\.?\s*)?([a-z]{1,2})$/i;
const NUMBERS = /^(?:(?:rev(?:ision)?|r)\.?\s*)?(\d+(?:\.\d+)*)$/i;

// A is 1, Z is 26, AA is 27, AZ is 52, BA is 53: the spreadsheet column order.
const ordinalOf = (letters: string) =>
  Array.from(letters.toUpperCase()).reduce(
    (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
    0,
  );

// Reads a revision label. Case and surrounding whitespace are ignored. Accepted forms: an optional
// "Rev", "Rev.", "Revision" or (before digits only) "R" prefix, then either one or two letters
// ("Rev A", "Rev. C", "AA"; A is 1, Z is 26, AA is 27) or digits with optional dotted parts
// ("R2", "Revision 3", "2.1"). Anything else, and null, is unknown: null.
export function parseRevision(label: string | null): RevisionKey | null {
  if (label === null) return null;
  const text = label.trim();
  const numbers = NUMBERS.exec(text);
  if (numbers?.[1] !== undefined) {
    return { kind: 'number', parts: numbers[1].split('.').map(Number) };
  }
  const letters = LETTERS.exec(text);
  if (letters?.[1] !== undefined) return { kind: 'letter', ordinal: ordinalOf(letters[1]) };
  return null;
}

function compareKeys(a: RevisionKey, b: RevisionKey): number {
  if (a.kind !== b.kind) return a.kind === 'letter' ? -1 : 1;
  if (a.kind === 'letter' && b.kind === 'letter') return Math.sign(a.ordinal - b.ordinal);
  const left = a.kind === 'number' ? a.parts : [];
  const right = b.kind === 'number' ? b.parts : [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// A total order over revision labels: negative when a is earlier than b, positive when later,
// zero when they name the same revision ("Rev A" and "a", "R2" and "Revision 2", "2" and "2.0").
// Unknown or missing labels come before every known one and are equal to each other, so two
// documents without a usable revision are never ranked against each other. Letters come before
// numbers; letters compare by ordinal; numbers compare part by part, missing parts counting as 0.
export function compareRevisions(a: string | null, b: string | null): number {
  const left = parseRevision(a);
  const right = parseRevision(b);
  if (left === null || right === null) {
    if (left === null && right === null) return 0;
    return left === null ? -1 : 1;
  }
  return compareKeys(left, right);
}
