import { FIELD_DEFINITIONS } from '@specledger/core';
import { describe, expect, it } from 'vitest';

import { isCorrect } from './correctness.js';

const head = FIELD_DEFINITIONS.centrifugal_pump.find((f) => f.name === 'rated_head');
const speed = FIELD_DEFINITIONS.centrifugal_pump.find((f) => f.name === 'rated_speed');
if (head === undefined || speed === undefined) throw new Error('fixture');

const TRUTH = { value: '260', unit: 'ft', page: 1, quote: 'Rated head 260 ft' };
const c = (value: string, unit: string, quote = 'Rated head 260 ft') => ({
  fieldName: 'rated_head' as const,
  value,
  unit,
  quote,
  page: 1,
});

describe('isCorrect', () => {
  it('accepts the expected value and quote', () => {
    expect(isCorrect(c('260', 'ft'), TRUTH, head)).toBe(true);
  });

  it('compares values after SI conversion, within 0.5 percent', () => {
    expect(isCorrect(c('79.25', 'm'), TRUTH, head)).toBe(true); // 260 ft = 79.248 m
    expect(isCorrect(c('79.6', 'm'), TRUTH, head)).toBe(true); // +0.44 %
    expect(isCorrect(c('79.7', 'm'), TRUTH, head)).toBe(false); // +0.57 %
  });

  it('accepts a quote that differs only in whitespace, or another quote containing the value', () => {
    expect(isCorrect(c('260', 'ft', 'Rated   head\n260 ft'), TRUTH, head)).toBe(true);
    expect(isCorrect(c('260', 'ft', 'Head at duty point: 260 ft'), TRUTH, head)).toBe(true);
  });

  it('refuses a right value with a quote that does not support it', () => {
    expect(isCorrect(c('260', 'ft', 'Maximum head 300 ft'), TRUTH, head)).toBe(false);
  });

  it('refuses any value when the document has none, and values that do not read', () => {
    expect(isCorrect(c('260', 'ft'), null, head)).toBe(false);
    expect(isCorrect(c('260', 'kW'), TRUTH, head)).toBe(false);
    expect(isCorrect(c('about 260', 'ft'), TRUTH, head)).toBe(false);
  });

  it('compares both bounds of a range', () => {
    const truth = { value: '1450-1780', unit: 'rpm', page: 1, quote: 'Rated speed 1450-1780 rpm' };
    const range = (value: string) => ({
      fieldName: 'rated_speed' as const,
      value,
      unit: 'rpm',
      quote: 'Rated speed 1450-1780 rpm',
      page: 1,
    });
    expect(isCorrect(range('1450-1780'), truth, speed)).toBe(true);
    expect(isCorrect(range('1450-1800'), truth, speed)).toBe(false);
    expect(isCorrect(range('1450'), truth, speed)).toBe(false);
  });
});
