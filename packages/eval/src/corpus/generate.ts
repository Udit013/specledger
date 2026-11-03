import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderDocument } from './render.js';
import type { RenderedDocument } from './render.js';
import { CORPUS_SEED, corpusSpecs, GENERATOR_VERSION } from './spec.js';
import type { DocumentSpec } from './spec.js';
import { HOLDOUT_FRACTION, splitFor } from './split.js';
import { groundTruthSchema, manifestSchema } from './truth.js';
import type { Manifest, ManifestEntry } from './truth.js';

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// One hash identifying the whole corpus: every document id with its file hashes, in id order.
export function corpusHash(entries: readonly ManifestEntry[]): string {
  return sha256(
    [...entries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => `${entry.id} ${entry.pdfSha256} ${entry.truthSha256}\n`)
      .join(''),
  );
}

export async function renderCorpus(
  filter: (spec: DocumentSpec) => boolean = () => true,
  seed = CORPUS_SEED,
): Promise<RenderedDocument[]> {
  const rendered: RenderedDocument[] = [];
  for (const spec of corpusSpecs(seed).filter(filter)) {
    const document = await renderDocument(spec);
    // Truth is validated before anything is written, so a generator bug cannot ship bad truth.
    groundTruthSchema.parse(document.truth);
    rendered.push(document);
  }
  return rendered;
}

export function buildManifest(
  documents: readonly RenderedDocument[],
  seed = CORPUS_SEED,
): Manifest {
  const entries: ManifestEntry[] = documents
    .map(({ spec, pdf, truth }) => ({
      id: spec.id,
      lineageId: spec.lineageId,
      equipmentClass: spec.equipmentClass,
      split: splitFor(spec.lineageId),
      cases: [...spec.cases],
      description: spec.description,
      pdf: `pdf/${spec.id}.pdf`,
      pdfSha256: sha256(pdf),
      truth: `truth/${spec.id}.json`,
      truthSha256: sha256(serializeJson(truth)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const corpusSha256 = corpusHash(entries);
  return manifestSchema.parse({
    schemaVersion: 1,
    generator: { seed, version: GENERATOR_VERSION },
    split: { key: 'lineageId', holdoutFraction: HOLDOUT_FRACTION },
    corpusSha256,
    documents: entries,
  });
}

// Replaces only files this generator owns (pdf/*.pdf, truth/*.json, manifest.json), so stale
// documents disappear and nothing else in the directory is touched.
export function writeCorpus(outDir: string, documents: readonly RenderedDocument[]): Manifest {
  const manifest = buildManifest(documents);
  for (const [folder, extension] of [
    ['pdf', '.pdf'],
    ['truth', '.json'],
  ] as const) {
    const dir = join(outDir, folder);
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (name.endsWith(extension)) rmSync(join(dir, name));
    }
  }
  for (const { spec, pdf, truth } of documents) {
    writeFileSync(join(outDir, 'pdf', `${spec.id}.pdf`), pdf);
    writeFileSync(join(outDir, 'truth', `${spec.id}.json`), serializeJson(truth));
  }
  writeFileSync(join(outDir, 'manifest.json'), serializeJson(manifest));
  return manifest;
}
