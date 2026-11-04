# Evaluation report

> SIMULATED EXTRACTION: candidates generated from the ground truth by a seeded error model (packages/eval/src/eval/simulate.ts), not answers from any language model. The rates measure the verifier, the per-field pick and reconciliation against these designed errors; they are not a measurement of model accuracy.

- Extractions: **simulated** (see the note above)
- Model id: `simulated-error-model-v1`; prompt version: `not-applicable`
- Corpus: `e0caf65c0f9c5ab33d92b499d900da22bca8b065f9490f8ca34719846885719b`, split **holdout** (holdout, run once after tuning)
- Extraction set: `6e27be66b126915c2ba91a1d582f745f75ee37bbe0091170ec519a837a7cfc55`, dated 2026-11-04
- 18 documents evaluated of 18 in the split; 130 document fields, 114 with a value in the ground truth, 120 candidates

## Overall

| Rate (95 % Wilson interval) | Pipeline | Count | Naive baseline | Count |
| --- | --- | --- | --- | --- |
| Precision | 98.8 % (93.4 to 99.8) | 81 / 82 | 73.5 % (64.9 to 80.7) | 86 / 117 |
| Recall | 71.1 % (62.1 to 78.6) | 81 / 114 | 75.4 % (66.8 to 82.4) | 86 / 114 |
| Unsupported-value rate | 1.2 % (0.2 to 6.6) | 1 / 82 | 5.1 % (2.4 to 10.7) | 6 / 117 |
| Verifier catch rate | 96.8 % (83.8 to 99.4) | 30 / 31 | 0.0 % (0.0 to 11.0) | 0 / 31 |
| False-reject rate | 9.0 % (4.6 to 16.7) | 8 / 89 | 0.0 % (0.0 to 4.1) | 0 / 89 |

The verifier prevented 30 wrong values from being accepted: the naive baseline, which believes the model, accepts 31 wrong values (6 where the document has none); the pipeline accepts 1 (1).

## Reconciliation

Across 16 pieces of equipment, the pipeline's reconciled value matches what the rules select from the ground truth for 74 / 102 fields: 72.5 % (63.2 to 80.3). Conflicts: 0; no value: 27; wrong value: 1; a value where the truth has none: 1.

## Per field (pipeline)

| Field | Precision | Recall | Unsupported | Catch | False reject |
| --- | --- | --- | --- | --- | --- |
| design_temperature | 7 / 7 | 7 / 10 | 0 / 7 | 3 / 3 | 1 / 8 |
| efficiency | 14 / 14 | 14 / 15 | 0 / 14 | 3 / 3 | 0 / 14 |
| frequency | 4 / 4 | 4 / 5 | 0 / 4 | 2 / 2 | 0 / 4 |
| max_working_pressure | 5 / 5 | 5 / 8 | 0 / 5 | 2 / 2 | 1 / 6 |
| npsh_required | 5 / 6 | 5 / 9 | 1 / 6 | 2 / 3 | 2 / 7 |
| rated_current | 2 / 2 | 2 / 6 | 0 / 2 | 3 / 3 | 0 / 2 |
| rated_flow | 8 / 8 | 8 / 11 | 0 / 8 | 3 / 3 | 0 / 8 |
| rated_head | 7 / 7 | 7 / 10 | 0 / 7 | 3 / 3 | 1 / 8 |
| rated_power | 13 / 13 | 13 / 18 | 0 / 13 | 4 / 4 | 2 / 15 |
| rated_speed | 13 / 13 | 13 / 16 | 0 / 13 | 3 / 3 | 1 / 14 |
| rated_voltage | 3 / 3 | 3 / 6 | 0 / 3 | 2 / 2 | 0 / 3 |

## Skipped documents

None.

## Limits

- The corpus is synthetic: generated datasheets with designed difficult cases, not vendor documents. Rates describe this corpus and say nothing about real documents.
- A document counts once per field of its equipment class; fields within a document are not independent, so the intervals are optimistic.
- Correct means within 0.5 percent of the ground truth after SI conversion, with a quote that is the expected one or contains the expected value.
- The pipeline measured is extraction, the verifier, the per-field pick and reconciliation; human review is not simulated.
