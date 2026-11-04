import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { err, ok } from '@specledger/core';
import type { Result } from '@specledger/core';

import { extractPageTexts } from '../corpus/extract.js';
import { groundTruthSchema, manifestSchema } from '../corpus/truth.js';
import type { Split } from '../corpus/truth.js';
import type { EvalDocument } from './runner.js';

export interface LoadedCorpus {
  readonly corpusSha256: string;
  readonly documents: readonly EvalDocument[];
}

// Reads the documents of one split with their ground truth and page text. The holdout split is
// refused unless the caller passes allowHoldout, before any of its files is read: it is evaluated
// once, after tuning, never by default.
export async function loadEvalCorpus(
  dir: string,
  options: { split: Split; allowHoldout: boolean },
): Promise<Result<LoadedCorpus, 'HOLDOUT_REQUIRES_FLAG'>> {
  if (options.split === 'holdout' && !options.allowHoldout) return err('HOLDOUT_REQUIRES_FLAG');
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  const documents: EvalDocument[] = [];
  for (const entry of manifest.documents.filter((d) => d.split === options.split)) {
    const truth = groundTruthSchema.parse(
      JSON.parse(await readFile(join(dir, entry.truth), 'utf8')),
    );
    const pages = truth.textLayer
      ? await extractPageTexts(new Uint8Array(await readFile(join(dir, entry.pdf))))
      : null;
    documents.push({ id: entry.id, split: entry.split, cases: entry.cases, truth, pages });
  }
  return ok({ corpusSha256: manifest.corpusSha256, documents });
}
