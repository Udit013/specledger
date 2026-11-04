# Evaluation report

> SIMULATED EXTRACTION: candidates generated from the ground truth by a seeded error model (packages/eval/src/eval/simulate.ts), not answers from any language model. The rates measure the verifier, the per-field pick and reconciliation against these designed errors; they are not a measurement of model accuracy.

- Extractions: **simulated** (see the note above)
- Model id: `simulated-error-model-v1`; prompt version: `not-applicable`
- Corpus: `e0caf65c0f9c5ab33d92b499d900da22bca8b065f9490f8ca34719846885719b`, split **dev**
- Extraction set: `6e27be66b126915c2ba91a1d582f745f75ee37bbe0091170ec519a837a7cfc55`, dated 2026-11-04
- 26 documents evaluated of 27 in the split; 188 document fields, 170 with a value in the ground truth, 174 candidates

## Overall

| Rate | Pipeline (95 % Wilson, fields) | Pipeline, document-clustered 95 % | Count | Naive baseline | Count |
| --- | --- | --- | --- | --- | --- |
| Precision | 100.0 % (97.1 to 100.0) | 87.1 to 100.0 (n ≈ 26.0) | 128 / 128 | 81.0 % (74.3 to 86.2) | 136 / 168 |
| Recall | 75.3 % (68.3 to 81.2) | 68.3 to 81.2 (n ≈ 170.0) | 128 / 170 | 80.0 % (73.4 to 85.3) | 136 / 170 |
| Unsupported-value rate | 0.0 % (0.0 to 2.9) | 0.0 to 12.9 (n ≈ 26.0) | 0 / 128 | 3.0 % (1.3 to 6.8) | 5 / 168 |
| Verifier catch rate | 100.0 % (89.3 to 100.0) | 83.9 to 100.0 (n ≈ 20.0) | 32 / 32 | 0.0 % (0.0 to 10.7) | 0 / 32 |
| False-reject rate | 9.9 % (6.0 to 15.9) | 6.0 to 15.9 (n ≈ 142.0) | 14 / 142 | 0.0 % (0.0 to 2.6) | 0 / 142 |

The verifier prevented 32 wrong values from being accepted: the naive baseline, which believes the model, accepts 32 wrong values (5 where the document has none); the pipeline accepts 0 (0).

## Reconciliation

Across 24 pieces of equipment, the pipeline's reconciled value matches what the rules select from the ground truth for 121 / 160 fields: 75.6 % (68.4 to 81.6). Conflicts: 0; no value: 38; wrong value: 1; a value where the truth has none: 0.

## Per field (pipeline)

| Field | Precision | Recall | Unsupported | Catch | False reject |
| --- | --- | --- | --- | --- | --- |
| design_temperature | 12 / 12 | 12 / 14 | 0 / 12 | 0 / 0 | 2 / 14 |
| efficiency | 20 / 20 | 20 / 24 | 0 / 20 | 2 / 2 | 1 / 21 |
| frequency | 7 / 7 | 7 / 9 | 0 / 7 | 1 / 1 | 1 / 8 |
| max_working_pressure | 9 / 9 | 9 / 15 | 0 / 9 | 6 / 6 | 0 / 9 |
| npsh_required | 10 / 10 | 10 / 14 | 0 / 10 | 2 / 2 | 3 / 13 |
| rated_current | 9 / 9 | 9 / 9 | 0 / 9 | 0 / 0 | 0 / 9 |
| rated_flow | 10 / 10 | 10 / 14 | 0 / 10 | 5 / 5 | 0 / 10 |
| rated_head | 10 / 10 | 10 / 15 | 0 / 10 | 4 / 4 | 3 / 13 |
| rated_power | 17 / 17 | 17 / 23 | 0 / 17 | 5 / 5 | 2 / 19 |
| rated_speed | 19 / 19 | 19 / 24 | 0 / 19 | 5 / 5 | 1 / 20 |
| rated_voltage | 5 / 5 | 5 / 9 | 0 / 5 | 2 / 2 | 1 / 6 |

## Skipped documents

- p-104-datasheet-scan: NO_TEXT_LAYER

## Limits

- The corpus is synthetic: generated datasheets with designed difficult cases, not vendor documents. Rates describe this corpus and say nothing about real documents.
- Fields of one document are not independent. The field-level Wilson intervals treat them as if they were and are too narrow; the document-clustered intervals widen them by the observed between-document variance, and at a rate of 0 or 1 count each document once.
- Correct means within 0.5 percent of the ground truth after SI conversion, with a quote that is the expected one or contains the expected value.
- The pipeline measured is extraction, the verifier, the per-field pick and reconciliation; human review is not simulated.
