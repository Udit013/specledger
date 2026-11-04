import type { GroundTruth } from '../corpus/truth.js';
import type { ExtractionSet } from './extraction-set.js';
import type { EvalDocument } from './runner.js';

// Small constructed documents for the runner's tests, counted by hand in runner.test.ts.

const PUMP_FIELDS = [
  'design_temperature',
  'efficiency',
  'max_working_pressure',
  'npsh_required',
  'rated_flow',
  'rated_head',
  'rated_power',
  'rated_speed',
] as const;

type Fields = Partial<Record<(typeof PUMP_FIELDS)[number], GroundTruth['fields'][string]>>;

export function pumpTruth(
  id: string,
  revision: string | null,
  fields: Fields,
  overrides: Partial<GroundTruth> = {},
): GroundTruth {
  return {
    schemaVersion: 1,
    documentId: id,
    lineageId: 'p-900',
    equipmentTag: 'P-900',
    equipmentClass: 'centrifugal_pump',
    sourceType: 'datasheet',
    revision,
    pageCount: 1,
    textLayer: true,
    fields: { ...Object.fromEntries(PUMP_FIELDS.map((name) => [name, null])), ...fields },
    ...overrides,
  };
}

export const PAGE_A = 'P-900 Rev A\nRated flow 500 gpm\nRated head 45 m\nEfficiency 78 %\n';
export const PAGE_B = 'P-900 Rev B\nRated flow 520 gpm\nRated head 45 m\n';

export const DOCS: EvalDocument[] = [
  {
    id: 'p-900-rev-a',
    split: 'dev',
    cases: ['revision'],
    truth: pumpTruth('p-900-rev-a', 'Rev A', {
      rated_flow: { value: '500', unit: 'gpm', page: 1, quote: 'Rated flow 500 gpm' },
      rated_head: { value: '45', unit: 'm', page: 1, quote: 'Rated head 45 m' },
      efficiency: { value: '78', unit: '%', page: 1, quote: 'Efficiency 78 %' },
    }),
    pages: [PAGE_A],
  },
  {
    id: 'p-900-rev-b',
    split: 'dev',
    cases: ['revision'],
    truth: pumpTruth('p-900-rev-b', 'Rev B', {
      rated_flow: { value: '520', unit: 'gpm', page: 1, quote: 'Rated flow 520 gpm' },
      rated_head: { value: '45', unit: 'm', page: 1, quote: 'Rated head 45 m' },
    }),
    pages: [PAGE_B],
  },
  {
    id: 'p-901-scan',
    split: 'dev',
    cases: ['no_text_layer'],
    truth: pumpTruth(
      'p-901-scan',
      null,
      {},
      { textLayer: false, lineageId: 'p-901', equipmentTag: 'P-901' },
    ),
    pages: null,
  },
];

const cand = (fieldName: string, value: string, unit: string, quote: string) => ({
  fieldName,
  value,
  unit,
  quote,
  page: 1,
});

// Rev A: flow correct; head wrong value with the true quote (caught: VALUE_NOT_IN_QUOTE);
//        efficiency correct but paraphrased (falsely rejected: QUOTE_NOT_FOUND).
// Rev B: flow correct; head missing; NPSH hallucinated from another line of the page with a unit
//        of the right kind (verified, so accepted: unsupported), and power hallucinated with a
//        fabricated quote (caught: QUOTE_NOT_FOUND).
export const SET: ExtractionSet = {
  schemaVersion: 1,
  origin: 'simulated',
  label: 'Constructed test extractions.',
  modelId: 'test-model',
  promptVersion: 'test-prompt',
  date: '2030-01-01',
  corpusSha256: 'c'.repeat(64),
  generator: null,
  documents: {
    'p-900-rev-a': {
      candidates: [
        cand('rated_flow', '500', 'gpm', 'Rated flow 500 gpm'),
        cand('rated_head', '54', 'm', 'Rated head 45 m'),
        cand('efficiency', '78', '%', 'The efficiency is 78 percent'),
      ],
    },
    'p-900-rev-b': {
      candidates: [
        cand('rated_flow', '520', 'gpm', 'Rated flow 520 gpm'),
        cand('npsh_required', '45', 'm', 'Rated head 45 m'),
        cand('rated_power', '30', 'kW', 'Rated power 30 kW'),
      ],
    },
  },
};
