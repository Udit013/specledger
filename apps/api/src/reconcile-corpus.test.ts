import { readFileSync } from 'node:fs';

import { FIELD_DEFINITIONS, reconcile, verifyCandidate } from '@specledger/core';
import type { ReconcileCandidate } from '@specledger/core';
import { groundTruthSchema, manifestSchema } from '@specledger/eval';
import { extractPages } from '@specledger/ingest';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT));
const manifest = manifestSchema.parse(
  JSON.parse(read('fixtures/corpus/manifest.json').toString('utf8')),
);

// The ground truth of corpus documents, as the pipeline will produce it: ingested page text,
// verified candidates, then reconciliation. Dev split only.
async function candidatesOf(documentIds: readonly string[]): Promise<ReconcileCandidate[]> {
  const out: ReconcileCandidate[] = [];
  for (const id of documentIds) {
    const entry = manifest.documents.find((d) => d.id === id);
    if (entry === undefined || entry.split !== 'dev')
      throw new Error(`${id} is not a dev document`);
    const truth = groundTruthSchema.parse(
      JSON.parse(read(`fixtures/corpus/${entry.truth}`).toString('utf8')),
    );
    const pages = await extractPages(read(`fixtures/corpus/${entry.pdf}`));
    if (!pages.ok) throw new Error(pages.error.code);
    for (const [fieldName, expected] of Object.entries(truth.fields)) {
      if (expected === null) continue;
      const field = FIELD_DEFINITIONS[truth.equipmentClass].find((f) => f.name === fieldName);
      if (field === undefined) throw new Error(`no field ${fieldName}`);
      const verdict = verifyCandidate(
        { fieldName, ...expected },
        pages.value.pages[expected.page - 1]?.text ?? '',
        field,
      );
      out.push({
        id: `${id}/${fieldName}`,
        fieldName,
        lineage: `${truth.lineageId}:${truth.sourceType}`,
        sourceType: truth.sourceType,
        revision: truth.revision,
        verification: verdict.status,
        value: verdict.normalizedValue,
      });
    }
  }
  return out;
}

describe('reconciliation of corpus documents', () => {
  it('takes every field of m-201 from Rev B', async () => {
    const result = reconcile({
      candidates: await candidatesOf(['m-201-datasheet-rev-a', 'm-201-datasheet-rev-b']),
      decisions: [],
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.conflicts).toEqual([]);
    for (const field of result.value.fields) {
      expect(field).toMatchObject({
        status: 'selected',
        selectedCandidateId: `m-201-datasheet-rev-b/${field.fieldName}`,
      });
    }
    expect(result.value.log.filter((e) => e.rule === 'LATER_REVISION')).toHaveLength(6);
    // Parses corpus PDFs in sandboxed worker threads: seconds on a shared CI runner.
  }, 30_000);

  it('takes every field of p-106 from the datasheet, never from the brochure', async () => {
    const result = reconcile({
      candidates: await candidatesOf(['p-106-datasheet', 'p-106-brochure']),
      decisions: [],
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.conflicts).toEqual([]);
    for (const field of result.value.fields) {
      expect(field).toMatchObject({
        status: 'selected',
        selectedCandidateId: `p-106-datasheet/${field.fieldName}`,
      });
    }
    expect(
      result.value.log.find((e) => e.fieldName === 'rated_head' && e.rule === 'HIGHER_SOURCE_RANK'),
    ).toMatchObject({
      candidateIds: ['p-106-brochure/rated_head'],
      winnerIds: ['p-106-datasheet/rated_head'],
    });
    // Parses corpus PDFs in sandboxed worker threads: seconds on a shared CI runner.
  }, 30_000);
});
