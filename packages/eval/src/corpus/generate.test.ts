import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractPageTexts } from './extract.js';
import { corpusHash, renderCorpus, serializeJson, sha256, writeCorpus } from './generate.js';
import { manifestSchema } from './truth.js';
import { validateCorpus } from './validate.js';

const SUBSET = new Set(['p-101-datasheet-rev-a', 'p-104-datasheet-scan', 'p-105-datasheet']);
const inSubset = (spec: { id: string }) => SUBSET.has(spec.id);

describe('generator determinism', () => {
  it('produces byte-identical PDFs and truth for the same seed', async () => {
    const first = await renderCorpus(inSubset);
    const second = await renderCorpus(inSubset);
    expect(first.map((doc) => doc.spec.id)).toEqual([
      'p-101-datasheet-rev-a',
      'p-104-datasheet-scan',
      'p-105-datasheet',
    ]);
    expect(first.map((doc) => sha256(doc.pdf))).toEqual(second.map((doc) => sha256(doc.pdf)));
    expect(first.map((doc) => serializeJson(doc.truth))).toEqual(
      second.map((doc) => serializeJson(doc.truth)),
    );
    // Renders and parses PDFs twice: seconds on a small CI runner sharing its cores.
  }, 60_000);

  it('produces different documents for a different seed', async () => {
    const original = await renderCorpus((spec) => spec.id === 'p-105-datasheet');
    const reseeded = await renderCorpus((spec) => spec.id === 'p-105-datasheet', 'another-seed');
    expect(sha256(reseeded[0]?.pdf ?? new Uint8Array())).not.toBe(
      sha256(original[0]?.pdf ?? new Uint8Array()),
    );
  });
});

describe('page text convention', () => {
  it('joins table columns with one space and lines with a newline', async () => {
    const [doc] = await renderCorpus((spec) => spec.id === 'p-102-datasheet');
    if (doc === undefined) throw new Error('p-102 is missing from the corpus');
    const [page] = await extractPageTexts(doc.pdf);
    expect(page?.split('\n').slice(0, 3)).toEqual([
      'SYNTHETIC TEST DOCUMENT - NOT A REAL PRODUCT',
      'Centrifugal Pump Datasheet',
      'Equipment tag: P-102',
    ]);
    expect(page).toContain('\nRated speed 1450-1780 rpm\n');
  });

  it('finds no text in the scanned-style document', async () => {
    const [doc] = await renderCorpus((spec) => spec.id === 'p-104-datasheet-scan');
    if (doc === undefined) throw new Error('p-104 is missing from the corpus');
    expect(await extractPageTexts(doc.pdf)).toEqual(['']);
  });
});

describe('validateCorpus', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-test-'));
    writeCorpus(dir, await renderCorpus());
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readTruth = (id: string) => readFileSync(join(dir, 'truth', `${id}.json`), 'utf8');

  // Rewrites one ground-truth file and every manifest hash to match, so only the content check can
  // object (the reproducibility check is off in these tests).
  function rewriteTruth(id: string, edit: (text: string) => string): () => void {
    const original = readTruth(id);
    const manifestPath = join(dir, 'manifest.json');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const edited = edit(original);
    writeFileSync(join(dir, 'truth', `${id}.json`), edited);
    const manifest = manifestSchema.parse(JSON.parse(originalManifest));
    for (const entry of manifest.documents) {
      if (entry.id === id) entry.truthSha256 = sha256(edited);
    }
    manifest.corpusSha256 = corpusHash(manifest.documents);
    writeFileSync(manifestPath, serializeJson(manifest));
    return () => {
      writeFileSync(join(dir, 'truth', `${id}.json`), original);
      writeFileSync(manifestPath, originalManifest);
    };
  }

  it('accepts the generated corpus and its byte-for-byte rebuild', async () => {
    expect(await validateCorpus(dir, { checkReproducible: true })).toEqual([]);
  }, 60_000);

  it('reports a ground-truth quote altered by one character', async () => {
    const restore = rewriteTruth('p-101-datasheet-rev-a', (text) =>
      text.replace('"quote": "Rated head: ', '"quote": "Rated Head: '),
    );
    try {
      expect(await validateCorpus(dir, { checkReproducible: false })).toEqual([
        'p-101-datasheet-rev-a: quote for rated_head not found on page 1',
      ]);
    } finally {
      restore();
    }
  });

  it('catches an edited document even when its manifest hashes were edited to match', async () => {
    const restore = rewriteTruth('m-202-datasheet', (text) =>
      text.replace('"quote": "Rated speed: ', '"quote": "Rated Speed: '),
    );
    try {
      const problems = await validateCorpus(dir, { checkReproducible: true });
      expect(problems).toContain('m-202-datasheet: quote for rated_speed not found on page 1');
      expect(problems).toContain(
        'm-202-datasheet: regenerating does not reproduce the committed document',
      );
    } finally {
      restore();
    }
  });

  it('reports a quote placed on the wrong page', async () => {
    const restore = rewriteTruth('p-105-datasheet', (text) => {
      const edited = text.replace(
        '"page": 2,\n      "quote": "Efficiency',
        '"page": 1,\n      "quote": "Efficiency',
      );
      expect(edited).not.toBe(text);
      return edited;
    });
    try {
      expect(await validateCorpus(dir, { checkReproducible: false })).toEqual([
        'p-105-datasheet: quote for efficiency not found on page 1',
      ]);
    } finally {
      restore();
    }
  });

  it('keeps every document of a lineage in the same split', () => {
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
    );
    const splits = new Map<string, Set<string>>();
    for (const entry of manifest.documents) {
      splits.set(entry.lineageId, (splits.get(entry.lineageId) ?? new Set()).add(entry.split));
    }
    expect([...splits.values()].every((set) => set.size === 1)).toBe(true);
    expect(splits.get('p-101')?.size).toBe(1);
    expect(manifest.documents.filter((d) => d.lineageId === 'p-101')).toHaveLength(3);
  });

  it('reports a PDF that no longer matches the manifest hash', async () => {
    const path = join(dir, 'pdf', 'p-102-datasheet.pdf');
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
    try {
      expect(await validateCorpus(dir, { checkReproducible: false })).toEqual([
        'p-102-datasheet: PDF hash differs from manifest',
      ]);
    } finally {
      writeFileSync(path, original);
    }
  });
});
