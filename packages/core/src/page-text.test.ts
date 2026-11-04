import { describe, expect, it } from 'vitest';

import { assemblePageText } from './page-text.js';

const item = (text: string, x: number, y: number, width = text.length * 5) => ({
  text,
  x,
  y,
  width,
});

describe('assemblePageText', () => {
  it('orders lines top to bottom and items left to right, whatever the input order', () => {
    expect(
      assemblePageText([
        item('1450-1780 rpm', 200, 700),
        item('Footer', 72, 50),
        item('Rated speed', 72, 700),
        item('Title', 72, 750),
      ]),
    ).toBe('Title\nRated speed 1450-1780 rpm\nFooter');
  });

  it('joins items without a visible gap and separates items with one', () => {
    expect(assemblePageText([item('Rated', 72, 700, 30), item('flow', 102, 700, 20)])).toBe(
      'Ratedflow',
    );
    expect(assemblePageText([item('Rated', 72, 700, 30), item('flow', 105, 700, 20)])).toBe(
      'Rated flow',
    );
  });

  it('treats baselines within half a unit as one line', () => {
    expect(assemblePageText([item('A', 72, 700.1, 5), item('B', 90, 699.9, 5)])).toBe('A B');
  });

  it('drops whitespace-only items, empty pages and NUL characters', () => {
    expect(assemblePageText([item('   ', 72, 700), item('\u0000', 72, 600)])).toBe('');
    expect(assemblePageText([])).toBe('');
    expect(assemblePageText([item('50\u0000 Hz', 72, 700)])).toBe('50 Hz');
  });
});
