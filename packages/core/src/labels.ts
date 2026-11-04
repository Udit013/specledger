import type { EquipmentClass } from './equipment.js';

// The words a datasheet puts before a value to say which quantity it is, per field, lower case.
// They are matched as whole words in the verifier's normalized quote. A label that contains
// another ("net positive suction head" contains "head") wins over it, because the longest match at
// a position is the one that counts.
//
// Kept apart from FieldDefinition on purpose: field definitions are sent to the model and are
// part of every Replay key, and labels are only the verifier's business.
export const FIELD_LABELS: Readonly<
  Record<EquipmentClass, Readonly<Record<string, readonly string[]>>>
> = {
  centrifugal_pump: {
    rated_flow: [
      'rated flow',
      'flow rate',
      'rated capacity',
      'capacity',
      'duty flow',
      'design flow',
      'flow',
    ],
    rated_head: [
      'rated head',
      'total head',
      'total dynamic head',
      'tdh',
      'differential head',
      'duty head',
      'design head',
      'head',
    ],
    rated_speed: ['rated speed', 'rotational speed', 'pump speed', 'speed'],
    rated_power: ['rated power', 'absorbed power', 'shaft power', 'motor power', 'power', 'bhp'],
    efficiency: ['efficiency', 'eff.'],
    npsh_required: [
      'npsh required',
      'npshr',
      'npsh r',
      'npsh',
      'net positive suction head required',
      'net positive suction head',
    ],
    max_working_pressure: [
      'max. working pressure',
      'max working pressure',
      'maximum working pressure',
      'maximum allowable working pressure',
      'mawp',
      'working pressure',
      'design pressure',
    ],
    design_temperature: [
      'design temperature',
      'max. temperature',
      'maximum temperature',
      'temperature',
    ],
  },
  electric_motor: {
    rated_power: ['rated power', 'rated output', 'output power', 'power', 'output'],
    rated_voltage: ['rated voltage', 'voltage', 'supply voltage'],
    rated_current: ['rated current', 'full load current', 'full-load current', 'fla', 'current'],
    frequency: ['frequency', 'supply frequency'],
    rated_speed: [
      'rated speed',
      'speed',
      'synchronous speed',
      'full load speed',
      'full-load speed',
    ],
    efficiency: ['efficiency', 'eff.'],
  },
};

// Labels of quantities that are not fields, so a value stated under them is never taken for a
// field: a maximum is not a rated value, and NPSH available is not NPSH required.
export const OTHER_QUANTITY_LABELS: readonly string[] = [
  'maximum flow',
  'max. flow',
  'max flow',
  'minimum flow',
  'min. flow',
  'min flow',
  'maximum head',
  'max. head',
  'max head',
  'shut-off head',
  'shutoff head',
  'maximum power',
  'max. power',
  'maximum speed',
  'max. speed',
  'npsh available',
  'npsha',
  'npsh a',
  'test pressure',
  'suction pressure',
  'discharge pressure',
  'ambient temperature',
  'starting current',
  'locked rotor current',
  'no-load current',
];

interface Occurrence {
  readonly start: number;
  readonly end: number;
  readonly owner: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Labels of both classes together. A field name shared by the classes (rated_power, rated_speed,
// efficiency) is the same quantity in both, and no label names two different fields, so the
// verifier needs no equipment class to read a quote.
const ALL_LABELS: readonly [string, string][] = Object.values(FIELD_LABELS).flatMap((fields) =>
  Object.entries(fields).flatMap(([field, labels]) =>
    labels.map((label): [string, string] => [label, field]),
  ),
);

// Every label occurrence in a lower-case quote, with contained shorter matches removed.
function occurrences(quote: string): Occurrence[] {
  const found: Occurrence[] = [];
  const add = (label: string, owner: string) => {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(label)}(?![\\p{L}\\p{N}])`, 'gu');
    for (const match of quote.matchAll(pattern)) {
      found.push({ start: match.index, end: match.index + match[0].length, owner });
    }
  };
  for (const [label, field] of ALL_LABELS) add(label, field);
  for (const label of OTHER_QUANTITY_LABELS) add(label, 'other');
  return found.filter(
    (a) =>
      !found.some(
        (b) => b !== a && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start,
      ),
  );
}

// Which field the label nearest before `position` belongs to: a field name, 'other' for a quantity
// that is not a field, or null when no label precedes it. `quote` must be lower case and
// normalized as the verifier normalizes it.
export function labelOwnerBefore(quote: string, position: number): string | null {
  let nearest: Occurrence | null = null;
  for (const occurrence of occurrences(quote)) {
    if (occurrence.end > position) continue;
    if (
      nearest === null ||
      occurrence.end > nearest.end ||
      (occurrence.end === nearest.end && occurrence.start < nearest.start)
    ) {
      nearest = occurrence;
    }
  }
  return nearest?.owner ?? null;
}
