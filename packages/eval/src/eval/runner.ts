import {
  FIELD_DEFINITIONS,
  normalizeValue,
  pickFields,
  reconcile,
  valuesAgree,
  verifyCandidate,
} from '@specledger/core';
import type {
  Candidate,
  FieldDefinition,
  NormalizedValue,
  ReconcileCandidate,
} from '@specledger/core';

import type { DesignedCase, GroundTruth, Split } from '../corpus/truth.js';
import { isCorrect } from './correctness.js';
import type { ExtractionSet } from './extraction-set.js';
import { metricsFor, proportion } from './metrics.js';
import type { FieldOutcome, Metrics, Proportion } from './metrics.js';

export interface EvalDocument {
  readonly id: string;
  readonly split: Split;
  readonly cases: readonly DesignedCase[];
  readonly truth: GroundTruth;
  // The text of each page, or null for a document without a text layer.
  readonly pages: readonly string[] | null;
}

export type SkipReason = 'NO_TEXT_LAYER' | 'NO_EXTRACTION' | 'EXTRACTION_FAILED';

export interface EvaluationReport {
  readonly schemaVersion: 1;
  // The extraction set's date, never the clock, so a rerun gives the same bytes.
  readonly date: string;
  readonly extraction: {
    readonly origin: ExtractionSet['origin'];
    readonly label: string;
    readonly modelId: string;
    readonly promptVersion: string;
    readonly date: string;
    readonly setSha256: string;
  };
  readonly corpus: {
    readonly corpusSha256: string;
    readonly split: Split;
    readonly holdout: boolean;
  };
  readonly documents: {
    readonly inSplit: number;
    readonly evaluated: number;
    readonly skipped: readonly { readonly id: string; readonly reason: SkipReason }[];
  };
  readonly pipeline: {
    readonly overall: Metrics;
    readonly perField: Readonly<Record<string, Metrics>>;
  };
  readonly naive: {
    readonly overall: Metrics;
    readonly perField: Readonly<Record<string, Metrics>>;
  };
  readonly prevented: {
    readonly naiveWrongAccepted: number;
    readonly pipelineWrongAccepted: number;
    readonly prevented: number;
    readonly naiveUnsupportedAccepted: number;
    readonly pipelineUnsupportedAccepted: number;
  };
  readonly reconciliation: {
    readonly equipment: number;
    // Of the equipment fields the rules select a value for from the ground truth, how many the
    // pipeline's reconciled value matches.
    readonly expected: Proportion;
    readonly conflicts: number;
    readonly missing: number;
    // Selected by both, with values that disagree.
    readonly wrong: number;
    // Fields the pipeline selected a value for where the truth selects none.
    readonly unexpected: number;
  };
  readonly limits: readonly string[];
}

export interface EvaluationInput {
  readonly documents: readonly EvalDocument[];
  readonly set: ExtractionSet;
  readonly split: Split;
  readonly corpusSha256: string;
  readonly setSha256: string;
}

const LIMITS = [
  'The corpus is synthetic: generated datasheets with designed difficult cases, not vendor documents. Rates describe this corpus and say nothing about real documents.',
  'A document counts once per field of its equipment class; fields within a document are not independent, so the intervals are optimistic.',
  'Correct means within 0.5 percent of the ground truth after SI conversion, with a quote that is the expected one or contains the expected value.',
  'The pipeline measured is extraction, the verifier, the per-field pick and reconciliation; human review is not simulated.',
];

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Evaluated {
  readonly document: EvalDocument;
  readonly pipeline: FieldOutcome[];
  readonly naive: FieldOutcome[];
  // Verified values the pipeline keeps, for reconciliation.
  readonly accepted: { readonly field: string; readonly value: NormalizedValue }[];
}

function evaluateDocument(
  document: EvalDocument,
  pages: readonly string[],
  candidates: readonly Candidate[],
): Evaluated {
  const fields = FIELD_DEFINITIONS[document.truth.equipmentClass];
  const definitions = new Map<string, FieldDefinition>(fields.map((f) => [f.name, f]));
  // Exactly what the worker does: verify every candidate against its page, then keep one per field.
  const verified = candidates.flatMap((candidate) => {
    const definition = definitions.get(candidate.fieldName);
    if (definition === undefined) return [];
    const text = pages[candidate.page - 1] ?? '';
    return [{ candidate, verdict: verifyCandidate(candidate, text, definition) }];
  });
  const picked = new Map(pickFields(verified).map((p) => [p.candidate.fieldName, p]));

  const pipeline: FieldOutcome[] = [];
  const naive: FieldOutcome[] = [];
  const accepted: Evaluated['accepted'] = [];
  for (const field of fields) {
    const truth = document.truth.fields[field.name] ?? null;
    const outcome = (c: Candidate, ok: boolean) => ({
      correct: isCorrect(c, truth, field),
      verified: ok,
    });
    const forField = verified.filter((v) => v.candidate.fieldName === field.name);
    const all = forField.map((v) => outcome(v.candidate, v.verdict.status === 'verified'));
    const kept = picked.get(field.name);
    const first = forField[0];
    pipeline.push({
      field: field.name,
      truthPresent: truth !== null,
      candidates: all,
      picked:
        kept === undefined ? null : outcome(kept.candidate, kept.verdict.status === 'verified'),
    });
    // The naive baseline keeps the model's first candidate and believes it.
    naive.push({
      field: field.name,
      truthPresent: truth !== null,
      candidates: all,
      picked: first === undefined ? null : outcome(first.candidate, true),
    });
    if (kept?.verdict.status === 'verified' && kept.verdict.normalizedValue !== null) {
      accepted.push({ field: field.name, value: kept.verdict.normalizedValue });
    }
  }
  return { document, pipeline, naive, accepted };
}

function perField(results: readonly Evaluated[], mode: 'pipeline' | 'naive') {
  const names = [...new Set(results.flatMap((r) => r[mode].map((o) => o.field)))].sort(byText);
  return Object.fromEntries(
    names.map((name) => [
      name,
      metricsFor(
        results.flatMap((r) => r[mode].filter((o) => o.field === name)),
        mode,
      ),
    ]),
  );
}

// Reconciliation per piece of equipment, twice: on the values the pipeline accepted and on the
// ground truth itself. The truth's reconciled value is what a perfect extraction would end with;
// the pipeline's is compared with it within 0.5 percent.
function reconciliation(results: readonly Evaluated[]): EvaluationReport['reconciliation'] {
  const byTag = new Map<string, Evaluated[]>();
  for (const result of results) {
    const tag = result.document.truth.equipmentTag;
    byTag.set(tag, [...(byTag.get(tag) ?? []), result]);
  }
  let expected = 0;
  let matched = 0;
  let conflicts = 0;
  let missing = 0;
  let wrong = 0;
  let unexpected = 0;
  for (const [tag, group] of [...byTag.entries()].sort(([a], [b]) => byText(a, b))) {
    const candidatesOf = (values: (r: Evaluated) => { field: string; value: NormalizedValue }[]) =>
      group.flatMap((r) =>
        values(r).map((v): ReconcileCandidate => ({
          id: `${r.document.id}/${v.field}`,
          fieldName: v.field,
          lineage: `${tag}:${r.document.truth.sourceType}`,
          sourceType: r.document.truth.sourceType,
          revision: r.document.truth.revision,
          verification: 'verified',
          value: v.value,
        })),
      );
    const truthValues = (r: Evaluated) => {
      const fields = FIELD_DEFINITIONS[r.document.truth.equipmentClass];
      return fields.flatMap((field) => {
        const truth = r.document.truth.fields[field.name];
        const value = truth == null ? null : normalizeValue(truth.value, truth.unit, field);
        return value === null ? [] : [{ field: field.name, value }];
      });
    };
    const truth = reconcile({ candidates: candidatesOf(truthValues), decisions: [] });
    const actual = reconcile({ candidates: candidatesOf((r) => r.accepted), decisions: [] });
    if (!truth.ok || !actual.ok) throw new Error(`reconciliation refused the inputs for ${tag}`);
    const outcomes = new Map(actual.value.fields.map((f) => [f.fieldName, f]));
    const selectedInTruth = new Set<string>();
    for (const field of truth.value.fields) {
      if (field.status !== 'selected') continue;
      selectedInTruth.add(field.fieldName);
      expected += 1;
      const outcome = outcomes.get(field.fieldName);
      if (outcome?.status === 'selected') {
        if (valuesAgree(outcome.value, field.value)) matched += 1;
        else wrong += 1;
      } else if (outcome?.status === 'conflict') {
        conflicts += 1;
      } else {
        missing += 1;
      }
    }
    for (const field of actual.value.fields) {
      if (field.status === 'selected' && !selectedInTruth.has(field.fieldName)) unexpected += 1;
    }
  }
  return {
    equipment: byTag.size,
    expected: proportion(matched, expected),
    conflicts,
    missing,
    wrong,
    unexpected,
  };
}

// The evaluation itself: pure, given the documents, their page text and the extraction set.
export function runEvaluation(input: EvaluationInput): EvaluationReport {
  const skipped: { id: string; reason: SkipReason }[] = [];
  const results: Evaluated[] = [];
  const documents = [...input.documents].sort((a, b) => byText(a.id, b.id));
  for (const document of documents) {
    const extraction = input.set.documents[document.id];
    if (document.pages === null) {
      skipped.push({ id: document.id, reason: 'NO_TEXT_LAYER' });
    } else if (extraction === undefined) {
      skipped.push({ id: document.id, reason: 'NO_EXTRACTION' });
    } else if ('error' in extraction) {
      skipped.push({ id: document.id, reason: 'EXTRACTION_FAILED' });
    } else {
      results.push(evaluateDocument(document, document.pages, extraction.candidates));
    }
  }

  const pipeline = metricsFor(
    results.flatMap((r) => r.pipeline),
    'pipeline',
  );
  const naive = metricsFor(
    results.flatMap((r) => r.naive),
    'naive',
  );
  return {
    schemaVersion: 1,
    date: input.set.date,
    extraction: {
      origin: input.set.origin,
      label: input.set.label,
      modelId: input.set.modelId,
      promptVersion: input.set.promptVersion,
      date: input.set.date,
      setSha256: input.setSha256,
    },
    corpus: {
      corpusSha256: input.corpusSha256,
      split: input.split,
      holdout: input.split === 'holdout',
    },
    documents: { inSplit: documents.length, evaluated: results.length, skipped },
    pipeline: { overall: pipeline, perField: perField(results, 'pipeline') },
    naive: { overall: naive, perField: perField(results, 'naive') },
    prevented: {
      naiveWrongAccepted: naive.counts.wrongAccepted,
      pipelineWrongAccepted: pipeline.counts.wrongAccepted,
      prevented: naive.counts.wrongAccepted - pipeline.counts.wrongAccepted,
      naiveUnsupportedAccepted: naive.counts.unsupportedAccepted,
      pipelineUnsupportedAccepted: pipeline.counts.unsupportedAccepted,
    },
    reconciliation: reconciliation(results),
    limits: LIMITS,
  };
}
