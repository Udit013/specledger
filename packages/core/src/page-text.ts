// The page-text convention (docs/evaluation.md). Ingestion stores page text built this way, the
// corpus validator checks ground-truth quotes against it, and the verifier will look for quotes in
// it, so all three must use this one function.
//
// Text items are grouped into lines by baseline (rounded to half a unit), lines run top to bottom,
// items within a line run left to right, items separated by a visible gap are joined with one
// space, and lines are joined with "\n". Whitespace-only items and empty lines are dropped, and NUL
// characters are removed because Postgres text cannot store them.

export interface PositionedText {
  readonly text: string;
  // PDF user space: x grows to the right, y grows upwards.
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

// Horizontal distance, in PDF units, above which two items on one line are separate words.
export const WORD_GAP = 0.5;

export function assemblePageText(items: readonly PositionedText[]): string {
  const rows = new Map<number, PositionedText[]>();
  for (const item of items) {
    const text = item.text.replaceAll('\u0000', '');
    if (text.trim().length === 0) continue;
    const key = Math.round(item.y * 2) / 2;
    const row = rows.get(key) ?? [];
    row.push({ ...item, text });
    rows.set(key, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, row]) => {
      row.sort((a, b) => a.x - b.x);
      let line = '';
      let end: number | undefined;
      for (const item of row) {
        if (end !== undefined && item.x - end > WORD_GAP) line += ' ';
        line += item.text;
        end = item.x + item.width;
      }
      return line.trim();
    })
    .filter((line) => line.length > 0)
    .join('\n');
}
