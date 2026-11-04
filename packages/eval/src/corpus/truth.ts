import {
  documentTypeSchema,
  equipmentClassSchema,
  FIELD_DEFINITIONS,
  TEXT_LIMITS,
} from '@specledger/core';
import { z } from 'zod';

// The designed cases the corpus must contain at least once (Phase 2 of the plan). Each document's
// manifest entry lists the cases it represents.
export const DESIGNED_CASES = [
  'baseline',
  'revision',
  'brochure_rated_vs_max',
  'range',
  'absent_fields',
  'no_text_layer',
  'injection',
  'dual_units',
  'decimal_comma',
  'multi_page',
  'layout_key_value',
  'layout_table',
  'layout_mixed',
] as const;
export const designedCaseSchema = z.enum(DESIGNED_CASES);
export type DesignedCase = z.infer<typeof designedCaseSchema>;

export const SPLITS = ['dev', 'holdout'] as const;
export const splitSchema = z.enum(SPLITS);
export type Split = z.infer<typeof splitSchema>;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case words joined by hyphens');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when `quote` states `value` immediately followed by `unit` as whole tokens. A plain
// substring test would accept value "26" for "260 ft", or unit "m" for "m³/h".
export function statesValueWithUnit(quote: string, value: string, unit: string): boolean {
  return new RegExp(
    `(?<![\\p{L}\\p{N}.,])${escapeRegExp(value)}\\s*${escapeRegExp(unit)}(?![\\p{L}\\p{N}])`,
    'u',
  ).test(quote);
}

// What a correct extraction of one field must produce. `value` and `unit` are written exactly as
// they appear in the document, the quote states the value followed by the unit, and the quote
// occurs verbatim in the text of `page` (checked against the PDFs by the corpus validator).
export const fieldTruthSchema = z
  .strictObject({
    value: z.string().min(1).max(TEXT_LIMITS.value),
    unit: z.string().min(1).max(TEXT_LIMITS.unit),
    page: z.number().int().min(1),
    quote: z.string().min(1).max(TEXT_LIMITS.quote),
  })
  .refine((truth) => statesValueWithUnit(truth.quote, truth.value, truth.unit), {
    message: 'quote must state the value followed by its unit, as written',
    path: ['quote'],
  });
export type FieldTruth = z.infer<typeof fieldTruthSchema>;

export const groundTruthSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    documentId: slug,
    lineageId: slug,
    equipmentTag: z.string().min(1).max(TEXT_LIMITS.tag),
    equipmentClass: equipmentClassSchema,
    sourceType: documentTypeSchema,
    revision: z.string().min(1).max(32).nullable(),
    pageCount: z.number().int().min(1),
    textLayer: z.boolean(),
    // Every field of the class appears: the truth for it, or null when the document does not
    // contain it (so a value extracted for it can only be a hallucination).
    fields: z.record(z.string(), fieldTruthSchema.nullable()),
  })
  .superRefine((truth, ctx) => {
    const expected = FIELD_DEFINITIONS[truth.equipmentClass].map((field) => field.name).sort();
    const actual = Object.keys(truth.fields).sort();
    if (expected.join(',') !== actual.join(',')) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: `fields must be exactly the ${truth.equipmentClass} field list`,
      });
    }
    for (const [name, field] of Object.entries(truth.fields)) {
      if (field === null) continue;
      if (!truth.textLayer) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', name],
          message: 'a document without a text layer has no extractable values',
        });
      }
      if (field.page > truth.pageCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', name, 'page'],
          message: 'page is beyond the document page count',
        });
      }
    }
  });
export type GroundTruth = z.infer<typeof groundTruthSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const manifestEntrySchema = z.strictObject({
  id: slug,
  lineageId: slug,
  equipmentClass: equipmentClassSchema,
  split: splitSchema,
  cases: z.array(designedCaseSchema).min(1),
  description: z.string().min(1),
  pdf: z.string().regex(/^pdf\/[a-z0-9-]+\.pdf$/),
  pdfSha256: sha256Hex,
  truth: z.string().regex(/^truth\/[a-z0-9-]+\.json$/),
  truthSha256: sha256Hex,
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generator: z.strictObject({ seed: z.string().min(1), version: z.number().int().min(1) }),
  split: z.strictObject({
    key: z.literal('lineageId'),
    holdoutFraction: z.number().gt(0).lt(1),
  }),
  // Hash over every document's id and file hashes: one value that identifies this exact corpus.
  corpusSha256: sha256Hex,
  documents: z.array(manifestEntrySchema).min(1),
});
export type Manifest = z.infer<typeof manifestSchema>;
