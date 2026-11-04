import { candidateSchema } from '@specledger/core';
import { z } from 'zod';

// What the evaluation reads instead of calling a model: for each document, the candidates an
// extraction produced, with where they came from. A set is one of:
//   recorded     real model answers, captured with the recording script (docs/evaluation.md);
//   handcrafted  answers written by hand for a test, such as the injection fixture;
//   simulated    generated from the ground truth by a seeded error model, not by any model.
// Every report repeats the set's origin and label, so a simulated number can never pass for a
// measured one.
export const EXTRACTION_ORIGINS = ['recorded', 'handcrafted', 'simulated'] as const;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const documentExtractionSchema = z.union([
  z.strictObject({ candidates: z.array(candidateSchema).max(200) }),
  // The extraction was attempted and failed, with the provider's error code.
  z.strictObject({ error: z.string().min(1).max(64) }),
]);
export type DocumentExtraction = z.infer<typeof documentExtractionSchema>;

export const extractionSetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  origin: z.enum(EXTRACTION_ORIGINS),
  // One sentence a reader sees first: what these extractions are and are not.
  label: z.string().min(1).max(500),
  modelId: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  // When the set was recorded or generated; the report's date, so reruns are byte-identical.
  date: z.iso.date(),
  corpusSha256: hex64,
  generator: z
    .strictObject({ name: z.string().min(1), version: z.number().int().min(1), seed: z.string() })
    .nullable(),
  documents: z.record(z.string(), documentExtractionSchema),
});
export type ExtractionSet = z.infer<typeof extractionSetSchema>;
