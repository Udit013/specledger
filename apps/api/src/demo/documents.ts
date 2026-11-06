import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DocumentType, EquipmentClass } from '@specledger/core';
import { groundTruthSchema, manifestSchema } from '@specledger/eval';

// The synthetic corpus documents the demo workspace starts with: a revision pair, a brochure that
// disagrees with its datasheet, a range, and the prompt-injection document. Dev-split documents
// only; the holdout is never used for anything but its one evaluation.
export const DEMO_DOCUMENTS: readonly string[] = [
  'p-106-datasheet',
  'p-106-brochure',
  'm-201-datasheet-rev-a',
  'm-201-datasheet-rev-b',
  'p-108-datasheet',
  'm-203-datasheet',
  'p-110-datasheet',
];

export interface DemoDocument {
  readonly id: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly documentType: DocumentType;
  readonly revision: string | null;
  readonly equipmentTag: string;
  readonly equipmentClass: EquipmentClass;
}

// Each demo document's PDF with the upload metadata its ground truth states, read from the corpus
// under `root` (the repository, or the container image, which carries the corpus).
export async function loadDemoDocuments(root: string): Promise<DemoDocument[]> {
  const corpus = join(root, 'fixtures/corpus');
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8')),
  );
  return Promise.all(
    DEMO_DOCUMENTS.map(async (id) => {
      const entry = manifest.documents.find((d) => d.id === id);
      if (entry === undefined) throw new Error(`${id} is not in the corpus manifest`);
      if (entry.split !== 'dev') throw new Error(`${id} is not a dev document`);
      const truth = groundTruthSchema.parse(
        JSON.parse(await readFile(join(corpus, entry.truth), 'utf8')),
      );
      return {
        id,
        filename: `${id}.pdf`,
        bytes: new Uint8Array(await readFile(join(corpus, entry.pdf))),
        documentType: truth.sourceType,
        revision: truth.revision,
        equipmentTag: truth.equipmentTag,
        equipmentClass: truth.equipmentClass,
      };
    }),
  );
}
