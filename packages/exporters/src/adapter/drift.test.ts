import { describe, expect, it } from 'vitest';

import { detectDrift } from './drift.js';
import type { ContractShape } from './drift.js';

const SHAPE: ContractShape = {
  assetId: 'string',
  revision: 'number',
  created: 'boolean',
  source: { system: 'string', registerVersion: 'number' },
};
const VALID = {
  assetId: 'a-1',
  revision: 1,
  created: true,
  source: { system: 'specledger', registerVersion: 3 },
};

describe('detectDrift', () => {
  it('reports nothing for a matching value', () => {
    expect(detectDrift(SHAPE, VALID)).toEqual({ compatible: true, differences: [] });
  });

  it('lists added fields, top-level and nested, and stays compatible', () => {
    expect(
      detectDrift(SHAPE, { ...VALID, debug: 'x', source: { ...VALID.source, region: 'eu' } }),
    ).toEqual({
      compatible: true,
      differences: [
        { path: 'debug', kind: 'added', expected: null, actual: 'string' },
        { path: 'source.region', kind: 'added', expected: null, actual: 'string' },
      ],
    });
  });

  it('lists removed fields as incompatible', () => {
    const rest = Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== 'revision'));
    expect(detectDrift(SHAPE, rest)).toEqual({
      compatible: false,
      differences: [{ path: 'revision', kind: 'removed', expected: 'number', actual: null }],
    });
  });

  it('lists retyped fields as incompatible, including objects and null', () => {
    expect(
      detectDrift(SHAPE, { ...VALID, revision: '1', created: null, source: 'specledger' }),
    ).toEqual({
      compatible: false,
      differences: [
        { path: 'created', kind: 'type_changed', expected: 'boolean', actual: 'null' },
        { path: 'revision', kind: 'type_changed', expected: 'number', actual: 'string' },
        { path: 'source', kind: 'type_changed', expected: 'object', actual: 'string' },
      ],
    });
  });

  it('treats an array or a non-object at the root as a type change, never throwing', () => {
    for (const value of [null, 'x', 42, [], undefined]) {
      const report = detectDrift(SHAPE, value);
      expect(report.compatible).toBe(false);
      expect(report.differences[0]?.path).toBe('');
    }
  });

  it('does not count NaN or an array as a number or object', () => {
    expect(detectDrift(SHAPE, { ...VALID, revision: Number.NaN }).compatible).toBe(false);
    expect(detectDrift(SHAPE, { ...VALID, source: [] }).compatible).toBe(false);
  });
});
