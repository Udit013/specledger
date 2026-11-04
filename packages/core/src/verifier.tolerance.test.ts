import { describe, expect, it } from 'vitest';

import { candidate, pumpField } from '../test/verifier-fixtures.js';
import { DUAL_UNIT_TOLERANCE, verifyCandidate } from './verifier.js';

// The dual-unit tolerance is relative, measured after conversion to the canonical unit, which for
// temperature is the kelvin (the specification: "within 0.5 percent after conversion" to SI). In
// kelvin, 0.5 percent of 353.15 K (80 °C) is about 1.8 K, so 80 °C agrees with any statement from
// about 172.8 °F to 179.2 °F. A relative tolerance in °C or °F would be meaningless near zero:
// "-18 °C (0 °F)" is a correct rounding but 1.2 percent apart in °C, and 0 °C has no relative scale.
const verdict = (line: string, value = '80') =>
  verifyCandidate(
    candidate('design_temperature', value, '°C', line),
    `Pump\n${line}`,
    pumpField('design_temperature'),
  ).reasons;

describe('dual-unit tolerance on temperatures', () => {
  it('is half a percent', () => {
    expect(DUAL_UNIT_TOLERANCE).toBe(0.005);
  });

  it('accepts a statement inside the band in kelvin', () => {
    // 179 °F = 354.82 K, 0.47 percent from 353.15 K.
    expect(verdict('Design temperature: 80 °C (179 °F)')).toEqual([]);
  });

  it('rejects a statement just outside it', () => {
    // 179.5 °F = 355.09 K, 0.55 percent from 353.15 K.
    expect(verdict('Design temperature: 80 °C (179.5 °F)')).toEqual(['UNIT_MISMATCH']);
  });

  it('accepts correct roundings near and below zero, which a °C-relative check would reject', () => {
    expect(verdict('Design temperature: 0 °C (32 °F)', '0')).toEqual([]);
    expect(verdict('Design temperature: -18 °C (0 °F)', '-18')).toEqual([]);
  });
});
