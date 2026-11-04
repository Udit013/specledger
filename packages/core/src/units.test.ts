import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CANONICAL_UNITS, DIMENSIONS } from './equipment.js';
import type { Dimension } from './equipment.js';
import { PROPERTY_SEED } from '../test/property-seed.js';
import { convert, fromCanonical, listUnits, parseUnit, toCanonical } from './units.js';

const unit = (text: string) => {
  const parsed = parseUnit(text);
  if (!parsed.ok) throw new Error(`${text} did not parse`);
  return parsed.value;
};

// |actual - expected| within `relative` of |expected| (or of 1 near zero).
function expectClose(actual: number, expected: number, relative = 1e-12) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    relative * Math.max(1, Math.abs(expected)),
  );
}

const GPM = 3.785411784e-3 / 60;

describe('parseUnit', () => {
  it.each<[string, string, Dimension]>([
    ['m3/s', 'm3/s', 'volumetric_flow'],
    ['m3/h', 'm3/h', 'volumetric_flow'],
    ['m³/h', 'm3/h', 'volumetric_flow'],
    ['m3/hr', 'm3/h', 'volumetric_flow'],
    ['cu m/h', 'm3/h', 'volumetric_flow'],
    ['cum/h', 'm3/h', 'volumetric_flow'],
    ['l/s', 'l/s', 'volumetric_flow'],
    ['L/s', 'l/s', 'volumetric_flow'],
    ['lps', 'l/s', 'volumetric_flow'],
    ['gpm', 'gpm', 'volumetric_flow'],
    ['US gpm', 'gpm', 'volumetric_flow'],
    ['usgpm', 'gpm', 'volumetric_flow'],
    ['GPM', 'gpm', 'volumetric_flow'],
    ['gal/min', 'gpm', 'volumetric_flow'],
    [' gpm ', 'gpm', 'volumetric_flow'],
    ['m', 'm', 'length'],
    ['ft', 'ft', 'length'],
    ['feet', 'ft', 'length'],
    ['foot', 'ft', 'length'],
    ['W', 'W', 'power'],
    ['kW', 'kW', 'power'],
    ['KW', 'kW', 'power'],
    ['hp', 'hp', 'power'],
    ['HP', 'hp', 'power'],
    ['rpm', 'rpm', 'rotational_speed'],
    ['RPM', 'rpm', 'rotational_speed'],
    ['r/min', 'rpm', 'rotational_speed'],
    ['1/min', 'rpm', 'rotational_speed'],
    ['min-1', 'rpm', 'rotational_speed'],
    ['min⁻¹', 'rpm', 'rotational_speed'],
    ['Pa', 'Pa', 'pressure'],
    ['kPa', 'kPa', 'pressure'],
    ['MPa', 'MPa', 'pressure'],
    ['bar', 'bar', 'pressure'],
    ['psi', 'psi', 'pressure'],
    ['V', 'V', 'voltage'],
    ['A', 'A', 'current'],
    ['Hz', 'Hz', 'frequency'],
    ['%', '%', 'efficiency'],
    ['K', 'K', 'temperature'],
    ['°C', '°C', 'temperature'],
    ['℃', '°C', 'temperature'],
    ['C', '°C', 'temperature'],
    ['degC', '°C', 'temperature'],
    ['°F', '°F', 'temperature'],
    ['F', '°F', 'temperature'],
    ['degF', '°F', 'temperature'],
  ])('%j is %s (%s)', (text, symbol, dimension) => {
    expect(unit(text)).toMatchObject({ symbol, dimension });
  });

  it.each(['furlong', '', '   ', 'm3', 'mw', 'kw/h', 'gpm2', 'Btu/h', 'kg'])(
    '%j is UNIT_UNKNOWN',
    (text) => {
      expect(parseUnit(text)).toEqual({ ok: false, error: { code: 'UNIT_UNKNOWN' } });
    },
  );
});

describe('toCanonical and fromCanonical', () => {
  it.each<[string, number]>([
    ['m3/s', 1],
    ['m3/h', 1 / 3600],
    ['l/s', 1e-3],
    ['gpm', GPM],
    ['m', 1],
    ['ft', 0.3048],
    ['W', 1],
    ['kW', 1000],
    ['hp', 745.7],
    ['rpm', 1],
    ['Pa', 1],
    ['kPa', 1e3],
    ['MPa', 1e6],
    ['bar', 1e5],
    ['psi', 6894.757293168],
    ['V', 1],
    ['A', 1],
    ['Hz', 1],
    ['%', 1],
  ])('1 %s is %d in the canonical unit', (text, factor) => {
    expectClose(toCanonical(1, unit(text)), factor);
    expectClose(fromCanonical(factor, unit(text)), 1);
  });

  it.each<[number, string, number]>([
    [0, '°C', 273.15],
    [100, '°C', 373.15],
    [-40, '°C', 233.15],
    [32, '°F', 273.15],
    [212, '°F', 373.15],
    [-40, '°F', 233.15],
    [300, 'K', 300],
  ])('%d %s is %d K, applying the offset', (value, text, kelvin) => {
    expectClose(toCanonical(value, unit(text)), kelvin);
    expectClose(fromCanonical(kelvin, unit(text)), value);
  });
});

describe('convert', () => {
  it.each<[number, string, string, number]>([
    [500, 'gpm', 'm3/h', 113.56235352],
    [1, 'bar', 'psi', 14.503773773022],
    [100, '°C', '°F', 212],
    [75, 'kW', 'hp', 75_000 / 745.7],
    [10, 'ft', 'm', 3.048],
    [1, 'm³/h', 'l/s', 1 / 3.6],
  ])('%d %s is %d %s', (value, from, to, expected) => {
    const result = convert(value, from, to);
    if (!result.ok) throw new Error(result.error.code);
    expectClose(result.value, expected, 1e-10);
  });

  it('never mixes dimensions', () => {
    expect(convert(1, 'm', 'kW')).toEqual({ ok: false, error: { code: 'UNIT_MISMATCH' } });
    expect(convert(1, '°C', 'bar')).toEqual({ ok: false, error: { code: 'UNIT_MISMATCH' } });
  });

  it('reports an unknown unit on either side', () => {
    expect(convert(1, 'furlong', 'm')).toEqual({ ok: false, error: { code: 'UNIT_UNKNOWN' } });
    expect(convert(1, 'm', 'furlong')).toEqual({ ok: false, error: { code: 'UNIT_UNKNOWN' } });
  });
});

describe('listUnits', () => {
  it('holds every dimension, with its canonical unit at factor 1 and no offset', () => {
    const units = listUnits();
    for (const dimension of DIMENSIONS) {
      expect(units.find((u) => u.symbol === CANONICAL_UNITS[dimension])).toMatchObject({
        dimension,
        factor: 1,
        offset: 0,
      });
    }
  });

  it('has unique symbols and finite, positive factors', () => {
    const units = listUnits();
    expect(new Set(units.map((u) => u.symbol)).size).toBe(units.length);
    for (const u of units) {
      expect(Number.isFinite(u.factor) && u.factor > 0).toBe(true);
      expect(Number.isFinite(u.offset)).toBe(true);
    }
  });
});

describe('unit conversion properties', () => {
  const SPELLINGS: Record<Dimension, string[]> = {
    volumetric_flow: ['m3/s', 'm3/h', 'l/s', 'gpm'],
    length: ['m', 'ft'],
    power: ['W', 'kW', 'hp'],
    rotational_speed: ['rpm'],
    pressure: ['Pa', 'kPa', 'MPa', 'bar', 'psi'],
    voltage: ['V'],
    current: ['A'],
    frequency: ['Hz'],
    efficiency: ['%'],
    temperature: ['K', '°C', '°F'],
  };
  const pairs = Object.values(SPELLINGS).flatMap((spellings) =>
    spellings.flatMap((from) => spellings.map((to) => [from, to] as const)),
  );
  const value = fc.double({ min: -1e7, max: 1e7, noNaN: true, noDefaultInfinity: true });

  it('round-trips every unit through the canonical unit within 1e-9', () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.values(SPELLINGS).flat()), value, (text, x) => {
        expectClose(fromCanonical(toCanonical(x, unit(text)), unit(text)), x, 1e-9);
      }),
      { seed: PROPERTY_SEED, numRuns: 1000 },
    );
  });

  it('round-trips every pair of units of one dimension within 1e-9', () => {
    fc.assert(
      fc.property(fc.constantFrom(...pairs), value, ([from, to], x) => {
        const there = convert(x, from, to);
        if (!there.ok) throw new Error(there.error.code);
        const back = convert(there.value, to, from);
        if (!back.ok) throw new Error(back.error.code);
        expectClose(back.value, x, 1e-9);
      }),
      { seed: PROPERTY_SEED, numRuns: 1000 },
    );
  });
});
