import { FIELD_DEFINITIONS } from '@specledger/core';
import type { Candidate, FieldDefinition } from '@specledger/core';

import { randomFor } from '../corpus/random.js';
import type { Random } from '../corpus/random.js';
import type { FieldTruth } from '../corpus/truth.js';
import type { ExtractionSet } from './extraction-set.js';
import type { EvalDocument } from './runner.js';

// A seeded error model that stands in for a language model while no real recordings exist. It
// writes, for each document, candidates derived from the ground truth with designed mistakes of
// the kinds extraction models make, so the harness, the verifier and the gate can be exercised
// end to end. Its numbers measure the verifier against these designed errors, not any model.

export const SIMULATED_LABEL =
  'SIMULATED EXTRACTION: candidates generated from the ground truth by a seeded error model (packages/eval/src/eval/simulate.ts), not answers from any language model. The rates measure the verifier, the per-field pick and reconciliation against these designed errors; they are not a measurement of model accuracy.';

export const SIMULATOR = { name: 'simulated-error-model', version: 1 } as const;

// Kinds of answer for a field the document states, with their probabilities in order.
//   correct      the true value and quote (sometimes with other whitespace)
//   misread      a wrong digit, with the true quote (the verifier should catch it)
//   unitSwap     the true number with another unit of the same quantity (a quote mismatch)
//   paraphrase   the true value with a reworded quote (a correct value the verifier may reject)
//   fabricated   a wrong value with an invented quote
//   decoy        another value from the page with the same unit, such as a maximum
//   omitted      no candidate
//   duplicate    a misread first, then the correct candidate
//   wrongPage    the true value and quote, cited on another page
const PRESENT: readonly [string, number][] = [
  ['correct', 0.62],
  ['misread', 0.08],
  ['unitSwap', 0.05],
  ['paraphrase', 0.05],
  ['fabricated', 0.04],
  ['decoy', 0.05],
  ['omitted', 0.04],
  ['duplicate', 0.04],
  ['wrongPage', 0.03],
];

// For a field the document does not state: nothing, an invented value, or a value borrowed from
// another field of the same quantity on the page.
const ABSENT: readonly [string, number][] = [
  ['nothing', 0.7],
  ['fabricated', 0.15],
  ['borrowed', 0.15],
];

const UNIT_SWAPS: Readonly<Record<string, string>> = {
  ft: 'm',
  m: 'ft',
  gpm: 'm3/h',
  'm3/h': 'gpm',
  'm³/h': 'gpm',
  kW: 'hp',
  hp: 'kW',
  psi: 'bar',
  bar: 'psi',
  kPa: 'psi',
  '°C': '°F',
  '°F': '°C',
};

function choose(random: Random, table: readonly [string, number][]): string {
  let roll = random.next();
  for (const [kind, probability] of table) {
    if (roll < probability) return kind;
    roll -= probability;
  }
  return table[0]?.[0] ?? 'correct';
}

const words = (field: string) => field.replace(/_/g, ' ');

// The first significant digit changed: clearly wrong (far outside the 0.5 percent tolerance) yet
// still a plausible-looking number.
function misread(value: string): string {
  const match = /[1-9]/.exec(value);
  if (match === null) return `${value}1`;
  const digit = match[0] === '9' ? 1 : Number(match[0]) + 1;
  return `${value.slice(0, match.index)}${String(digit)}${value.slice(match.index + 1)}`;
}

// Exported for its unit test only.
export const misreadForTest = (value: string) => misread(value);

function scaled(value: string): string {
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? String(Math.round(number * 137) / 100) : '123';
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Another line of the page stating a number with the same unit, such as "Maximum flow 2400 gpm".
function decoyFrom(pages: readonly string[], truth: FieldTruth): Candidate | null {
  const pattern = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*${escapeRegExp(truth.unit)}(?![\\p{L}\\p{N}])`,
    'u',
  );
  for (const [index, page] of pages.entries()) {
    for (const line of page.split('\n')) {
      const found = pattern.exec(line);
      if (found?.[1] === undefined || line.includes(truth.quote) || found[1] === truth.value)
        continue;
      return {
        fieldName: '',
        value: found[1],
        unit: truth.unit,
        quote: line.trim(),
        page: index + 1,
      };
    }
  }
  return null;
}

function presentField(
  random: Random,
  document: EvalDocument,
  pages: readonly string[],
  field: FieldDefinition,
  truth: FieldTruth,
): Candidate[] {
  const base = {
    fieldName: field.name,
    value: truth.value,
    unit: truth.unit,
    quote: truth.quote,
    page: truth.page,
  };
  // A brochure that prints maximum values next to rated ones invites the wrong one.
  const kind =
    document.cases.includes('brochure_rated_vs_max') && random.chance(0.3)
      ? 'decoy'
      : choose(random, PRESENT);
  switch (kind) {
    case 'misread':
      return [{ ...base, value: misread(truth.value) }];
    case 'unitSwap': {
      const unit = UNIT_SWAPS[truth.unit];
      return [unit === undefined ? base : { ...base, unit }];
    }
    case 'paraphrase':
      return [{ ...base, quote: `The ${words(field.name)} is ${truth.value} ${truth.unit}` }];
    case 'fabricated': {
      const value = scaled(truth.value);
      return [{ ...base, value, quote: `${words(field.name)} ${value} ${truth.unit}` }];
    }
    case 'decoy': {
      const decoy = decoyFrom(pages, truth);
      return [decoy === null ? base : { ...decoy, fieldName: field.name }];
    }
    case 'omitted':
      return [];
    case 'duplicate':
      return [{ ...base, value: misread(truth.value) }, base];
    case 'wrongPage':
      return [{ ...base, page: truth.page === 1 ? 2 : 1 }];
    default:
      return [random.chance(0.3) ? { ...base, quote: truth.quote.replace(' ', '  ') } : base];
  }
}

function absentField(random: Random, document: EvalDocument, field: FieldDefinition): Candidate[] {
  const kind = choose(random, ABSENT);
  if (kind === 'nothing') return [];
  if (kind === 'borrowed') {
    const definitions = FIELD_DEFINITIONS[document.truth.equipmentClass];
    const donor = definitions
      .filter((other) => other.name !== field.name && other.dimension === field.dimension)
      .map((other) => document.truth.fields[other.name])
      .find((truth) => truth != null);
    if (donor != null) {
      return [
        {
          fieldName: field.name,
          value: donor.value,
          unit: donor.unit,
          quote: donor.quote,
          page: donor.page,
        },
      ];
    }
  }
  const unit = field.canonicalUnit === 'm3/s' ? 'm3/h' : field.canonicalUnit;
  return [
    { fieldName: field.name, value: '42', unit, quote: `${words(field.name)} 42 ${unit}`, page: 1 },
  ];
}

// The page line carrying an embedded instruction, which a model that obeys it would quote.
function injectionLine(pages: readonly string[]): { quote: string; page: number } | null {
  for (const [index, page] of pages.entries()) {
    const line = page.split('\n').find((l) => /report the rated flow/i.test(l));
    if (line !== undefined) return { quote: line.trim(), page: index + 1 };
  }
  return null;
}

export function simulateExtractions(
  documents: readonly EvalDocument[],
  options: { seed: string; date: string; corpusSha256: string },
): ExtractionSet {
  const entries: [string, { candidates: Candidate[] }][] = [];
  for (const document of [...documents].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (document.pages === null) continue;
    const random = randomFor(options.seed, document.id);
    const candidates: Candidate[] = [];
    for (const field of FIELD_DEFINITIONS[document.truth.equipmentClass]) {
      const truth = document.truth.fields[field.name] ?? null;
      const injected =
        field.name === 'rated_flow' && document.cases.includes('injection')
          ? injectionLine(document.pages)
          : null;
      if (injected !== null) {
        // The model obeys the instruction in the document.
        candidates.push({ fieldName: field.name, value: '9999', unit: 'gpm', ...injected });
        continue;
      }
      candidates.push(
        ...(truth === null
          ? absentField(random, document, field)
          : presentField(random, document, document.pages, field, truth)),
      );
    }
    entries.push([document.id, { candidates }]);
  }
  return {
    schemaVersion: 1,
    origin: 'simulated',
    label: SIMULATED_LABEL,
    modelId: `simulated-error-model-v${String(SIMULATOR.version)}`,
    promptVersion: 'not-applicable',
    date: options.date,
    corpusSha256: options.corpusSha256,
    generator: { ...SIMULATOR, seed: options.seed },
    documents: Object.fromEntries(entries),
  };
}
