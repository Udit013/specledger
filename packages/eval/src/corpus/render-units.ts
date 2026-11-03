import type { Dimension } from '@specledger/core';

// How the generator writes quantities into synthetic documents. This is deliberately independent
// of the verifier's unit registry (Phase 5): the corpus is the oracle that registry is tested
// against, so it must not be derived from it.

interface RenderUnit {
  readonly dimension: Dimension;
  // Converts a value in this unit to the dimension's canonical unit, and back.
  readonly toCanonical: (value: number) => number;
  readonly fromCanonical: (canonical: number) => number;
  // Decimals used when this unit is the primary statement.
  readonly decimals: number;
}

const linear = (dimension: Dimension, factor: number, decimals: number): RenderUnit => ({
  dimension,
  toCanonical: (value) => value * factor,
  fromCanonical: (canonical) => canonical / factor,
  decimals,
});

const US_GALLON_PER_MINUTE_M3_S = 0.003785411784 / 60;
const KELVIN_OFFSET = 273.15;

export const RENDER_UNITS = {
  'm3/h': linear('volumetric_flow', 1 / 3600, 1),
  'm³/h': linear('volumetric_flow', 1 / 3600, 1),
  'l/s': linear('volumetric_flow', 1 / 1000, 1),
  gpm: linear('volumetric_flow', US_GALLON_PER_MINUTE_M3_S, 0),
  m: linear('length', 1, 1),
  ft: linear('length', 0.3048, 0),
  kW: linear('power', 1000, 1),
  hp: linear('power', 745.7, 1),
  rpm: linear('rotational_speed', 1, 0),
  '%': linear('efficiency', 1, 1),
  bar: linear('pressure', 1e5, 1),
  psi: linear('pressure', 6894.757293168, 0),
  kPa: linear('pressure', 1000, 0),
  V: linear('voltage', 1, 0),
  A: linear('current', 1, 1),
  Hz: linear('frequency', 1, 0),
  '°C': {
    dimension: 'temperature',
    toCanonical: (value) => value + KELVIN_OFFSET,
    fromCanonical: (canonical) => canonical - KELVIN_OFFSET,
    decimals: 0,
  },
  '°F': {
    dimension: 'temperature',
    toCanonical: (value) => ((value - 32) * 5) / 9 + KELVIN_OFFSET,
    fromCanonical: (canonical) => ((canonical - KELVIN_OFFSET) * 9) / 5 + 32,
    decimals: 0,
  },
} as const satisfies Record<string, RenderUnit>;

export type RenderUnitName = keyof typeof RENDER_UNITS;

// The unit used for the parenthetical second statement in dual-unit documents.
export const SECONDARY_UNIT: Partial<Record<RenderUnitName, RenderUnitName>> = {
  'm3/h': 'gpm',
  'm³/h': 'gpm',
  gpm: 'm3/h',
  m: 'ft',
  ft: 'm',
  kW: 'hp',
  hp: 'kW',
  bar: 'psi',
  psi: 'bar',
  '°C': '°F',
  '°F': '°C',
};

export type DecimalMark = 'point' | 'comma';

export function formatNumber(value: number, decimals: number, mark: DecimalMark): string {
  const text = value.toFixed(decimals);
  return mark === 'comma' ? text.replace('.', ',') : text;
}

export function parseFormatted(text: string): number {
  return Number(text.replace(',', '.'));
}

// Four significant figures keeps a secondary statement within 0.05 percent of the primary one,
// well inside the verifier's 0.5 percent agreement rule.
export function significantDecimals(value: number, figures = 4): number {
  if (value === 0) return 0;
  return Math.max(0, figures - 1 - Math.floor(Math.log10(Math.abs(value))));
}
