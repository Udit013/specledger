import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Page-text convention shared with ingestion (Phase 3; documented in docs/evaluation.md):
// text items are grouped into lines by baseline, lines run top to bottom, items within a line
// run left to right, items separated by a visible gap are joined with one space, and lines are
// joined with "\n". Whitespace-only items are ignored.

interface Positioned {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

const GAP = 0.5;

function toLines(items: readonly Positioned[]): string[] {
  const rows = new Map<number, Positioned[]>();
  for (const item of items) {
    const key = Math.round(item.y * 2) / 2;
    const row = rows.get(key) ?? [];
    row.push(item);
    rows.set(key, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, row]) => {
      row.sort((a, b) => a.x - b.x);
      let line = '';
      let end: number | undefined;
      for (const item of row) {
        if (end !== undefined && item.x - end > GAP) line += ' ';
        line += item.text;
        end = item.x + item.width;
      }
      return line.trim();
    })
    .filter((line) => line.length > 0);
}

// Returns the text of each page, in page order. Only for the generated corpus; ingestion of
// untrusted uploads gets its own sandboxed extractor in Phase 3.
export async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    // The isEvalSupported switch of earlier pdfjs versions does not exist in v6.
    enableXfa: false,
    stopAtErrors: true,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const items: Positioned[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim().length === 0) continue;
        const [, , , , x, y] = item.transform as number[];
        if (x === undefined || y === undefined) continue;
        items.push({ text: item.str, x, y, width: item.width });
      }
      pages.push(toLines(items).join('\n'));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
