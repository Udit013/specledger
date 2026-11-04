import { describe, expect, it } from 'vitest';

import { parseNumber } from './numbers.js';
import type { NumberHints, ParsedNumber } from './numbers.js';

const scalar = (value: number): ParsedNumber => ({ kind: 'scalar', value });
const range = (low: number, high: number): ParsedNumber => ({ kind: 'range', low, high });
const POINT: NumberHints = { decimalMark: 'point' };
const COMMA: NumberHints = { decimalMark: 'comma' };

describe('parseNumber: accepted formats', () => {
  it.each<[string, NumberHints, ParsedNumber]>([
    ['500', {}, scalar(500)],
    ['113.6', {}, scalar(113.6)],
    ['1,234.5', {}, scalar(1234.5)],
    ['1.234,5', {}, scalar(1234.5)],
    ['1 234,5', {}, scalar(1234.5)],
    ['1 234.5', {}, scalar(1234.5)],
    ['1 234 567', {}, scalar(1234567)],
    ['1,234,567', {}, scalar(1234567)],
    ['1.234.567', {}, scalar(1234567)],
    ['74,3', {}, scalar(74.3)],
    ['12,34', {}, scalar(12.34)],
    ['1,2345', {}, scalar(1.2345)],
    ['12345,678', {}, scalar(12345.678)],
    ['0,750', {}, scalar(0.75)],
    ['0.750', {}, scalar(0.75)],
    ['-5', {}, scalar(-5)],
    ['-0,5', {}, scalar(-0.5)],
    [' 500 ', {}, scalar(500)],
    // A hint never overrides a token that is unambiguous on its own.
    ['74,3', POINT, scalar(74.3)],
    ['113.6', COMMA, scalar(113.6)],
  ])('%j with hints %j', (token, hints, expected) => {
    expect(parseNumber(token, hints)).toEqual({ ok: true, value: expected });
  });
});

describe('parseNumber: ambiguous thousands or decimal', () => {
  it.each(['1,234', '1.234', '999,999', '12.500'])('%j is ambiguous without a hint', (token) => {
    expect(parseNumber(token)).toEqual({ ok: false, error: { code: 'AMBIGUOUS_NUMBER_FORMAT' } });
  });

  it.each<[string, NumberHints, number]>([
    ['1,234', POINT, 1234],
    ['1,234', COMMA, 1.234],
    ['1.234', POINT, 1.234],
    ['1.234', COMMA, 1234],
  ])('%j with hints %j is %d', (token, hints, value) => {
    expect(parseNumber(token, hints)).toEqual({ ok: true, value: scalar(value) });
  });

  it('reports a range with an ambiguous bound as ambiguous', () => {
    expect(parseNumber('2,900-3,600')).toEqual({
      ok: false,
      error: { code: 'AMBIGUOUS_NUMBER_FORMAT' },
    });
    expect(parseNumber('2,900-3,600', POINT)).toEqual({ ok: true, value: range(2900, 3600) });
  });
});

describe('parseNumber: ranges', () => {
  it.each<[string, ParsedNumber]>([
    ['2900-3600', range(2900, 3600)],
    ['2900 - 3600', range(2900, 3600)],
    ['2900 to 3600', range(2900, 3600)],
    ['1450-1780', range(1450, 1780)],
    ['-20 to 40', range(-20, 40)],
    ['74,3-80,1', range(74.3, 80.1)],
    ['5-5', range(5, 5)],
  ])('%j', (token, expected) => {
    expect(parseNumber(token)).toEqual({ ok: true, value: expected });
  });
});

describe('parseNumber: rejected tokens', () => {
  it.each([
    '1e3',
    '1E3',
    '+5',
    '.5',
    '',
    '   ',
    'abc',
    '12a',
    'about 500',
    '1,23,4',
    '1,234,5',
    '1 23',
    '--5',
    'NaN',
    'Infinity',
    '5-',
    '3600-2900',
    '2900 to',
    '1,23.4',
    '1.234,5,6',
    '9'.repeat(400),
  ])('%j is INVALID_NUMBER', (token) => {
    expect(parseNumber(token)).toEqual({ ok: false, error: { code: 'INVALID_NUMBER' } });
  });
});
