import type { Dimension } from './equipment.js';
import { normalizeWithMap } from './normalize.js';
import { err, ok } from './result.js';
import type { Result } from './result.js';

// One unit of measure. A value v in this unit is v * factor + offset in the dimension's canonical
// unit (CANONICAL_UNITS: SI, except rpm for rotational speed and % for efficiency). Only
// temperatures have an offset.
export interface UnitDefinition {
  // The registry's spelling, for example "m3/h" for "m³/h", "cu m/h" and "m3/hr".
  readonly symbol: string;
  readonly dimension: Dimension;
  readonly factor: number;
  readonly offset: number;
}

export type UnitErrorCode = 'UNIT_UNKNOWN' | 'UNIT_MISMATCH';

export interface UnitError {
  readonly code: UnitErrorCode;
}

const unit = (symbol: string, dimension: Dimension, factor: number, offset = 0): UnitDefinition =>
  Object.freeze({ symbol, dimension, factor, offset });

// Exact definitions: the US gallon is 3.785411784 l, the foot 0.3048 m, mechanical horsepower
// 745.7 W, the psi 6894.757293168 Pa (one pound-force per square inch), and K = (°F + 459.67) * 5/9.
const UNITS: readonly UnitDefinition[] = Object.freeze([
  unit('m3/s', 'volumetric_flow', 1),
  unit('m3/h', 'volumetric_flow', 1 / 3600),
  unit('l/s', 'volumetric_flow', 1e-3),
  unit('gpm', 'volumetric_flow', 3.785411784e-3 / 60),
  unit('m', 'length', 1),
  unit('ft', 'length', 0.3048),
  unit('W', 'power', 1),
  unit('kW', 'power', 1e3),
  unit('hp', 'power', 745.7),
  unit('rpm', 'rotational_speed', 1),
  unit('Pa', 'pressure', 1),
  unit('kPa', 'pressure', 1e3),
  unit('MPa', 'pressure', 1e6),
  unit('bar', 'pressure', 1e5),
  unit('psi', 'pressure', 6894.757293168),
  unit('V', 'voltage', 1),
  unit('A', 'current', 1),
  unit('Hz', 'frequency', 1),
  unit('%', 'efficiency', 1),
  unit('K', 'temperature', 1),
  unit('°C', 'temperature', 1, 273.15),
  unit('°F', 'temperature', 5 / 9, (459.67 * 5) / 9),
]);

// Spellings, after normalization, that mean a registry symbol. "m³/h", "℃" and "min⁻¹" need no
// entry: NFKC already turns them into "m3/h", "°C" and "min-1".
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'm3/hr': 'm3/h',
  'cu m/h': 'm3/h',
  'cum/h': 'm3/h',
  'L/s': 'l/s',
  lps: 'l/s',
  'US gpm': 'gpm',
  usgpm: 'gpm',
  GPM: 'gpm',
  'gal/min': 'gpm',
  feet: 'ft',
  foot: 'ft',
  KW: 'kW',
  HP: 'hp',
  RPM: 'rpm',
  'r/min': 'rpm',
  '1/min': 'rpm',
  'min-1': 'rpm',
  C: '°C',
  degC: '°C',
  F: '°F',
  degF: '°F',
});

const BY_SYMBOL: ReadonlyMap<string, UnitDefinition> = new Map(UNITS.map((u) => [u.symbol, u]));

// The registry (Phase 5 requirement 3). Each unit with its common spellings:
//   volumetric flow  m3/s; m3/h (m³/h, m3/hr, cu m/h, cum/h); l/s (L/s, lps); gpm (US gpm,
//                    usgpm, GPM, gal/min) = 3.785411784 l per minute
//   length           m; ft (feet, foot) = 0.3048 m
//   power            W; kW (KW); hp (HP) = 745.7 W, mechanical horsepower
//   rotational speed rpm (RPM, r/min, 1/min, min-1)
//   pressure         Pa; kPa; MPa; bar = 100 000 Pa; psi = 6894.757293168 Pa
//   voltage          V
//   current          A
//   frequency        Hz
//   efficiency       %
//   temperature      K; °C (C, degC) offset 273.15; °F (F, degF) factor 5/9, offset 459.67 * 5/9
export function listUnits(): readonly UnitDefinition[] {
  return UNITS;
}

// Looks a unit up by any spelling in the registry, after normalization (normalizeWithMap) and with
// surrounding whitespace ignored. Spellings are case-sensitive except where an alias says
// otherwise ("KW" is kW, but "mw" is not anything). Unknown spellings, including dimensions the
// registry does not hold ("m3", a volume), are UNIT_UNKNOWN.
export function parseUnit(text: string): Result<UnitDefinition, UnitError> {
  const spelling = normalizeWithMap(text).normalized;
  const found = BY_SYMBOL.get(ALIASES[spelling] ?? spelling);
  return found === undefined ? err({ code: 'UNIT_UNKNOWN' }) : ok(found);
}

// Value in `unit` to the dimension's canonical unit, and back.
export function toCanonical(value: number, definition: UnitDefinition): number {
  return value * definition.factor + definition.offset;
}

export function fromCanonical(value: number, definition: UnitDefinition): number {
  return (value - definition.offset) / definition.factor;
}

// Converts between two spellings. UNIT_UNKNOWN if either is not in the registry, UNIT_MISMATCH if
// their dimensions differ: a conversion never mixes dimensions.
export function convert(value: number, from: string, to: string): Result<number, UnitError> {
  const source = parseUnit(from);
  if (!source.ok) return source;
  const target = parseUnit(to);
  if (!target.ok) return target;
  if (source.value.dimension !== target.value.dimension) return err({ code: 'UNIT_MISMATCH' });
  return ok(fromCanonical(toCanonical(value, source.value), target.value));
}
