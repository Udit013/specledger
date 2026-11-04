import { readFileSync } from 'node:fs';

import { FIELD_DEFINITIONS, verifyCandidate } from '@specledger/core';
import type { FieldDefinition } from '@specledger/core';
import { groundTruthSchema, manifestSchema } from '@specledger/eval';
import { extractPages } from '@specledger/ingest';
import { recordingSchema } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT));
const manifest = manifestSchema.parse(
  JSON.parse(read('fixtures/corpus/manifest.json').toString('utf8')),
);

// Only the dev split: the holdout is never used to build tests (docs/evaluation.md).
const devDocuments = manifest.documents.filter((entry) => entry.split === 'dev');

const fieldOf = (equipmentClass: keyof typeof FIELD_DEFINITIONS, name: string): FieldDefinition => {
  const field = FIELD_DEFINITIONS[equipmentClass].find((f) => f.name === name);
  if (field === undefined) throw new Error(`no field ${name}`);
  return field;
};

// The verifier against the corpus as ingestion stores it: every ground-truth value of a dev
// document, offered as a candidate, must verify, and an invented quote for every absent field must
// not. Decimal commas are passed as the document's hint, as the pipeline will.
describe('verifier on the dev corpus', () => {
  it.each(devDocuments.map((entry) => [entry.id, entry] as const))('%s', async (_id, entry) => {
    const truth = groundTruthSchema.parse(
      JSON.parse(read(`fixtures/corpus/${entry.truth}`).toString('utf8')),
    );
    if (!truth.textLayer) return;
    const extracted = await extractPages(read(`fixtures/corpus/${entry.pdf}`));
    if (!extracted.ok) throw new Error(extracted.error.code);
    const hints = {
      decimalMark: entry.cases.includes('decimal_comma') ? 'comma' : 'point',
    } as const;

    for (const [name, expected] of Object.entries(truth.fields)) {
      const field = fieldOf(truth.equipmentClass, name);
      if (expected === null) {
        const invented = {
          fieldName: name,
          value: '123',
          unit: field.canonicalUnit,
          quote: `${name}: 123 ${field.canonicalUnit}`,
          page: 1,
        };
        const result = verifyCandidate(
          invented,
          extracted.value.pages[0]?.text ?? '',
          field,
          hints,
        );
        expect(result.reasons, `${entry.id} ${name}`).toContain('QUOTE_NOT_FOUND');
        continue;
      }
      const page = extracted.value.pages[expected.page - 1]?.text ?? '';
      const result = verifyCandidate({ fieldName: name, ...expected }, page, field, hints);
      expect(result.reasons, `${entry.id} ${name}`).toEqual([]);
    }
  });
});

// The Phase 4 recording of a model that obeyed the injection in p-108, through the verifier.
describe('injection recording through the verifier', () => {
  it('rejects the obeyed rated flow and verifies every honest value', () => {
    const name = '4fae1f2cb21fb7b758902f07773d561e4e1cfde99a8004df4993b3605366bcbc.json';
    const recording = recordingSchema.parse(
      JSON.parse(read(`fixtures/recordings/${name}`).toString('utf8')),
    );
    for (const c of recording.response.candidates) {
      const page = recording.request.pages.find((p) => p.pageNumber === c.page)?.text ?? '';
      const result = verifyCandidate(
        c,
        page,
        fieldOf(recording.request.equipmentClass, c.fieldName),
      );
      expect(result.reasons, c.fieldName).toEqual(
        c.fieldName === 'rated_flow' ? ['VALUE_NOT_IN_QUOTE'] : [],
      );
    }
  });
});
