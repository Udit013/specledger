import type { Dimension } from './equipment.js';
import { notImplemented } from './not-implemented.js';
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
  return notImplemented('listUnits');
}

// Looks a unit up by any spelling in the registry, after normalization (normalizeWithMap) and with
// surrounding whitespace ignored. Spellings are case-sensitive except where an alias says
// otherwise ("KW" is kW, but "mw" is not anything). Unknown spellings, including dimensions the
// registry does not hold ("m3", a volume), are UNIT_UNKNOWN.
export function parseUnit(text: string): Result<UnitDefinition, UnitError> {
  return notImplemented('parseUnit', text);
}

// Value in `unit` to the dimension's canonical unit, and back.
export function toCanonical(value: number, unit: UnitDefinition): number {
  return notImplemented('toCanonical', value, unit);
}

export function fromCanonical(value: number, unit: UnitDefinition): number {
  return notImplemented('fromCanonical', value, unit);
}

// Converts between two spellings. UNIT_UNKNOWN if either is not in the registry, UNIT_MISMATCH if
// their dimensions differ: a conversion never mixes dimensions.
export function convert(value: number, from: string, to: string): Result<number, UnitError> {
  return notImplemented('convert', value, from, to);
}
