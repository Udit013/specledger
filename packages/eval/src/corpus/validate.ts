import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIELD_DEFINITIONS } from '@specledger/core';
import { z } from 'zod';
import type { EquipmentClass } from '@specledger/core';

import { extractPageTexts } from './extract.js';
import { buildManifest, corpusHash, renderCorpus, sha256 } from './generate.js';
import { splitFor } from './split.js';
import { DESIGNED_CASES, groundTruthSchema, manifestSchema } from './truth.js';
import type { GroundTruth, ManifestEntry } from './truth.js';

export const MIN_DOCUMENTS = 30;
export const MIN_HOLDOUT = 10;
// Below this many non-space characters a document counts as having no text layer.
export const TEXT_LAYER_THRESHOLD = 20;

export interface ValidationOptions {
  // Also regenerate the corpus in memory and require identical hashes (byte-for-byte rebuild).
  readonly checkReproducible: boolean;
}

// Returns every problem found; an empty list means the corpus is valid.
export async function validateCorpus(dir: string, options: ValidationOptions): Promise<string[]> {
  const problems: string[] = [];
  const parsed = manifestSchema.safeParse(
    JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
  );
  if (!parsed.success) return [`manifest.json is invalid: ${z.prettifyError(parsed.error)}`];
  const manifest = parsed.data;

  const truths: GroundTruth[] = [];
  for (const entry of manifest.documents) {
    const pdf = new Uint8Array(readFileSync(join(dir, entry.pdf)));
    const truthText = readFileSync(join(dir, entry.truth), 'utf8');
    if (sha256(pdf) !== entry.pdfSha256)
      problems.push(`${entry.id}: PDF hash differs from manifest`);
    if (sha256(truthText) !== entry.truthSha256) {
      problems.push(`${entry.id}: ground truth hash differs from manifest`);
    }
    if (splitFor(entry.lineageId) !== entry.split) {
      problems.push(`${entry.id}: split is not the one the split rule assigns`);
    }
    const truthResult = groundTruthSchema.safeParse(JSON.parse(truthText));
    if (!truthResult.success) {
      problems.push(`${entry.id}: ground truth is invalid: ${z.prettifyError(truthResult.error)}`);
      continue;
    }
    const truth = truthResult.data;
    truths.push(truth);
    if (truth.documentId !== entry.id || truth.lineageId !== entry.lineageId) {
      problems.push(`${entry.id}: ground truth ids do not match the manifest`);
    }

    const pages = await extractPageTexts(pdf);
    if (pages.length !== truth.pageCount) {
      problems.push(
        `${entry.id}: PDF has ${String(pages.length)} pages, truth says ${String(truth.pageCount)}`,
      );
    }
    const visible = pages.join('').replace(/\s/g, '').length;
    if (truth.textLayer && visible < TEXT_LAYER_THRESHOLD) {
      problems.push(`${entry.id}: expected a text layer but found none`);
    }
    if (!truth.textLayer && visible >= TEXT_LAYER_THRESHOLD) {
      problems.push(`${entry.id}: expected no text layer but found ${String(visible)} characters`);
    }
    for (const [name, field] of Object.entries(truth.fields)) {
      if (field === null) continue;
      const pageText = pages[field.page - 1];
      if (pageText === undefined || !pageText.includes(field.quote)) {
        problems.push(`${entry.id}: quote for ${name} not found on page ${String(field.page)}`);
      }
    }
  }

  problems.push(...coverageProblems(manifest.documents, truths));
  const holdout = manifest.documents.filter((d) => d.split === 'holdout').length;
  const dev = manifest.documents.length - holdout;
  if (manifest.documents.length < MIN_DOCUMENTS) {
    problems.push(
      `corpus has ${String(manifest.documents.length)} documents, needs ${String(MIN_DOCUMENTS)}`,
    );
  }
  if (holdout < MIN_HOLDOUT)
    problems.push(`holdout has ${String(holdout)} documents, needs ${String(MIN_HOLDOUT)}`);
  if (dev === 0) problems.push('dev split is empty');

  if (corpusHash(manifest.documents) !== manifest.corpusSha256) {
    problems.push('corpusSha256 does not match the manifest entries');
  }

  if (options.checkReproducible) {
    // Compares every regenerated entry, not only the recorded corpus hash, so an edited file whose
    // manifest entry was edited to match is still caught.
    const rebuilt = new Map(
      buildManifest(await renderCorpus()).documents.map((entry) => [entry.id, entry]),
    );
    for (const entry of manifest.documents) {
      const fresh = rebuilt.get(entry.id);
      rebuilt.delete(entry.id);
      if (fresh === undefined) {
        problems.push(`${entry.id}: the generator no longer produces this document`);
      } else if (JSON.stringify(fresh) !== JSON.stringify(entry)) {
        problems.push(`${entry.id}: regenerating does not reproduce the committed document`);
      }
    }
    for (const id of rebuilt.keys()) problems.push(`${id}: generated but missing from the corpus`);
  }
  return problems;
}

function coverageProblems(
  documents: readonly ManifestEntry[],
  truths: readonly GroundTruth[],
): string[] {
  const problems: string[] = [];
  // Designed cases must be in dev: later phases build regression tests from them, and the holdout
  // may not be used for that.
  const devCases = new Set(documents.filter((d) => d.split === 'dev').flatMap((d) => d.cases));
  for (const designed of DESIGNED_CASES) {
    if (!devCases.has(designed))
      problems.push(`no dev document covers the designed case ${designed}`);
  }
  // Every field must be absent from at least one document that does have a text layer, so a value
  // extracted for it there can only be a hallucination.
  for (const equipmentClass of Object.keys(FIELD_DEFINITIONS) as EquipmentClass[]) {
    const ofClass = truths.filter((t) => t.equipmentClass === equipmentClass && t.textLayer);
    for (const { name } of FIELD_DEFINITIONS[equipmentClass]) {
      if (!ofClass.some((truth) => truth.fields[name] === null)) {
        problems.push(`${equipmentClass}.${name} is present in every document`);
      }
    }
  }
  return problems;
}
