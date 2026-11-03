import { z } from 'zod';

import { fieldNameSchema, TEXT_LIMITS } from './equipment.js';

// One value proposed by the extraction model. Model output is untrusted, so the schema is strict
// (unknown keys are rejected) and bounded. `value` is the text exactly as stated in the document,
// such as "1,234.5" or "2900-3600": turning it into a number is the verifier's job, because
// separators, ranges and ambiguous formats cannot be represented faithfully by a JS number.
export const candidateSchema = z.strictObject({
  fieldName: fieldNameSchema,
  value: z.string().trim().min(1).max(TEXT_LIMITS.value),
  unit: z.string().trim().min(1).max(TEXT_LIMITS.unit),
  quote: z.string().min(1).max(TEXT_LIMITS.quote),
  page: z.number().int().min(1),
});

export type Candidate = z.infer<typeof candidateSchema>;
