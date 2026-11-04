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

// Page text by the PDF's sha256 from the manifest: content-addressed, so a cached entry is always
// the text of exactly those bytes. Parsing is the slow part of a run, and the CLI's checks load
// the corpus several times in one process.
const pageCache = new Map<string, Promise<string[]>>();

function pagesOf(path: string, sha256: string): Promise<string[]> {
  let pages = pageCache.get(sha256);
  if (pages === undefined) {
    pages = readFile(path).then((bytes) => extractPageTexts(new Uint8Array(bytes)));
    pageCache.set(sha256, pages);
  }
  return pages;
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
    const pages = truth.textLayer ? await pagesOf(join(dir, entry.pdf), entry.pdfSha256) : null;
    documents.push({ id: entry.id, split: entry.split, cases: entry.cases, truth, pages });
  }
  return ok({ corpusSha256: manifest.corpusSha256, documents });
}
