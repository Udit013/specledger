import { describe, expect, it } from 'vitest';

import { FIELD_DEFINITIONS } from './equipment.js';
import { isPlausible, locateQuote } from './verifier.js';

const PAGE = 'Pump P-106\nRated   head:\t260 ft\nRated flow: 1997 gpm\n';

const slice = (page: string, span: { start: number; end: number } | null) =>
  span === null ? null : page.slice(span.start, span.end);

describe('locateQuote', () => {
  it('returns the offsets of a verbatim quote in the original page', () => {
    expect(slice(PAGE, locateQuote('Rated flow: 1997 gpm', PAGE))).toBe('Rated flow: 1997 gpm');
  });

  it('finds a quote that differs from the page only in whitespace, spanning the original text', () => {
    const span = locateQuote('Rated head: 260 ft', PAGE);
    expect(slice(PAGE, span)).toBe('Rated   head:\t260 ft');
  });

  it('finds a quote across a line break and unified dashes and quotes', () => {
    const page = 'Speed 1450–1780\nrpm “rated”';
    expect(slice(page, locateQuote('Speed 1450-1780 rpm "rated"', page))).toBe(page);
  });

  it('maps through NFKC so the span covers the original characters', () => {
    const page = 'Flow 287 m³/h';
    expect(slice(page, locateQuote('Flow 287 m3/h', page))).toBe('Flow 287 m³/h');
  });

  it.each([
    ['a quote that is not on the page', 'Rated head: 250 ft'],
    ['an empty quote', ''],
    ['a whitespace-only quote', ' \n\t '],
  ])('returns null for %s', (_case, quote) => {
    expect(locateQuote(quote, PAGE)).toBeNull();
  });
});

describe('isPlausible', () => {
  const head = FIELD_DEFINITIONS.centrifugal_pump.find((f) => f.name === 'rated_head');
  if (head === undefined) throw new Error('fixture');
  const { min, max } = head.plausibleRange;

  it('includes both bounds and refuses values just outside them', () => {
    expect(isPlausible({ kind: 'scalar', value: min, unit: 'm' }, head)).toBe(true);
    expect(isPlausible({ kind: 'scalar', value: max, unit: 'm' }, head)).toBe(true);
    expect(isPlausible({ kind: 'scalar', value: max * 1.0001, unit: 'm' }, head)).toBe(false);
    expect(isPlausible({ kind: 'scalar', value: min / 2, unit: 'm' }, head)).toBe(false);
  });

  it('requires both bounds of a range to be plausible', () => {
    expect(isPlausible({ kind: 'range', low: min, high: max, unit: 'm' }, head)).toBe(true);
    expect(isPlausible({ kind: 'range', low: min, high: max * 2, unit: 'm' }, head)).toBe(false);
  });

  it('refuses NaN', () => {
    expect(isPlausible({ kind: 'scalar', value: Number.NaN, unit: 'm' }, head)).toBe(false);
  });
});
