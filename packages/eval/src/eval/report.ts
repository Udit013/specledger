import type { ClusteredInterval, Metrics, Proportion } from './metrics.js';
import type { EvaluationReport } from './runner.js';

export const README_START = '<!-- evaluation-results:start -->';
export const README_END = '<!-- evaluation-results:end -->';

// Key order is fixed by how runEvaluation builds the report, so this is byte-stable.
export function reportJson(report: EvaluationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const percent = (p: Proportion) =>
  p.rate === null || p.low === null || p.high === null
    ? 'n/a'
    : `${(p.rate * 100).toFixed(1)} % (${(p.low * 100).toFixed(1)} to ${(p.high * 100).toFixed(1)})`;
const counted = (p: Proportion) => `${String(p.numerator)} / ${String(p.denominator)}`;
const clusteredText = (c: ClusteredInterval | null) =>
  c === null
    ? 'n/a'
    : `${(c.low * 100).toFixed(1)} to ${(c.high * 100).toFixed(1)} (n ≈ ${c.effectiveN.toFixed(1)})`;

const RATES: readonly [keyof Omit<Metrics, 'counts'>, string][] = [
  ['precision', 'Precision'],
  ['recall', 'Recall'],
  ['unsupportedRate', 'Unsupported-value rate'],
  ['catchRate', 'Verifier catch rate'],
  ['falseRejectRate', 'False-reject rate'],
];

function overallTable(report: EvaluationReport): string[] {
  const rows = RATES.map(
    ([key, name]) =>
      `| ${name} | ${percent(report.pipeline.overall[key])} | ${clusteredText(report.pipeline.clustered[key])} | ${counted(report.pipeline.overall[key])} | ${percent(report.naive.overall[key])} | ${counted(report.naive.overall[key])} |`,
  );
  return [
    '| Rate | Pipeline (95 % Wilson, fields) | Pipeline, document-clustered 95 % | Count | Naive baseline | Count |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ];
}

function provenance(report: EvaluationReport): string[] {
  const { extraction, corpus } = report;
  return [
    `- Extractions: **${extraction.origin}** (see the note above)`,
    `- Model id: \`${extraction.modelId}\`; prompt version: \`${extraction.promptVersion}\``,
    `- Corpus: \`${corpus.corpusSha256}\`, split **${corpus.split}**${corpus.holdout ? ' (holdout, run once after tuning)' : ''}`,
    `- Extraction set: \`${extraction.setSha256}\`, dated ${extraction.date}`,
    `- ${String(report.documents.evaluated)} documents evaluated of ${String(report.documents.inSplit)} in the split; ${String(report.pipeline.overall.counts.fields)} document fields, ${String(report.pipeline.overall.counts.truthPresent)} with a value in the ground truth, ${String(report.pipeline.overall.counts.candidates)} candidates`,
  ];
}

export function renderMarkdown(report: EvaluationReport): string {
  const lines = [
    '# Evaluation report',
    '',
    `> ${report.extraction.label}`,
    '',
    ...provenance(report),
    '',
    '## Overall',
    '',
    ...overallTable(report),
    '',
    `The verifier prevented ${String(report.prevented.prevented)} wrong values from being accepted: the naive baseline, which believes the model, accepts ${String(report.prevented.naiveWrongAccepted)} wrong values (${String(report.prevented.naiveUnsupportedAccepted)} where the document has none); the pipeline accepts ${String(report.prevented.pipelineWrongAccepted)} (${String(report.prevented.pipelineUnsupportedAccepted)}).`,
    '',
    '## Reconciliation',
    '',
    `Across ${String(report.reconciliation.equipment)} pieces of equipment, the pipeline's reconciled value matches what the rules select from the ground truth for ${counted(report.reconciliation.expected)} fields: ${percent(report.reconciliation.expected)}. Conflicts: ${String(report.reconciliation.conflicts)}; no value: ${String(report.reconciliation.missing)}; wrong value: ${String(report.reconciliation.wrong)}; a value where the truth has none: ${String(report.reconciliation.unexpected)}.`,
    '',
    '## Per field (pipeline)',
    '',
    '| Field | Precision | Recall | Unsupported | Catch | False reject |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(report.pipeline.perField).map(
      ([name, m]) =>
        `| ${name} | ${counted(m.precision)} | ${counted(m.recall)} | ${counted(m.unsupportedRate)} | ${counted(m.catchRate)} | ${counted(m.falseRejectRate)} |`,
    ),
    '',
    '## Skipped documents',
    '',
    ...(report.documents.skipped.length === 0
      ? ['None.']
      : report.documents.skipped.map((s) => `- ${s.id}: ${s.reason}`)),
    '',
    '## Limits',
    '',
    ...report.limits.map((limit) => `- ${limit}`),
    '',
  ];
  return lines.join('\n');
}

// The README's results section, generated from report.json so that no number is typed by hand.
export function renderReadmeSection(report: EvaluationReport): string {
  return [
    `> ${report.extraction.label}`,
    '',
    ...provenance(report),
    '',
    ...overallTable(report),
    '',
    `The verifier prevented ${String(report.prevented.prevented)} wrong values (naive baseline ${String(report.prevented.naiveWrongAccepted)}, pipeline ${String(report.prevented.pipelineWrongAccepted)}). Full report: [evaluation/report.md](evaluation/report.md).`,
    '',
  ].join('\n');
}

export function replaceReadmeSection(readme: string, section: string): string {
  const starts = readme.split(README_START).length - 1;
  const ends = readme.split(README_END).length - 1;
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error(`the README needs exactly one pair of ${README_START} / ${README_END} markers`);
  }
  return `${readme.slice(0, start + README_START.length)}\n${section}${readme.slice(end)}`;
}
