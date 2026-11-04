import { assemblePageText } from '@specledger/core';
import type { PositionedText } from '@specledger/core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Page text follows the convention in @specledger/core (assemblePageText), the same function
// ingestion uses, so quotes checked here are the quotes ingestion will store.

// Returns the text of each page, in page order. Only for the generated corpus; ingestion of
// untrusted uploads uses its own sandboxed extractor (packages/ingest).
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
      const items: PositionedText[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const [, , , , x, y] = item.transform as number[];
        if (x === undefined || y === undefined) continue;
        items.push({ text: item.str, x, y, width: item.width });
      }
      pages.push(assemblePageText(items));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
