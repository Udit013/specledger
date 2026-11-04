# The holdout report in this folder is superseded

`report.json` and `report.md` here were produced once, after tuning, by the pipeline as it was at
commit `e5d10e1`. The audit that followed changed the verifier (rule (g), `LABEL_MISMATCH`: a value
must be stated under its own field's label). The holdout had been seen by then, so it no longer
gives an unbiased number for the current pipeline, and it was deliberately not re-run.

What would give one again: a fresh holdout split (new lineages generated with the corpus
generator, never looked at), evaluated once after all tuning. The report is kept as the record of
the earlier run.
