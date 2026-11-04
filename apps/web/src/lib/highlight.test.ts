import { describe, expect, it } from 'vitest';

import { quoteSpan, segmentText } from './highlight.js';

const marked = (text: string, spans: Parameters<typeof segmentText>[1]) =>
  segmentText(text, spans).map((s) => [s.text, s.ids]);

describe('segmentText', () => {
  it('returns the whole text as one plain segment without spans', () => {
    expect(marked('Rated head 260 ft', [])).toEqual([['Rated head 260 ft', []]]);
  });

  it('marks one span and keeps the text around it', () => {
    expect(marked('abc def ghi', [{ id: 'q', start: 4, end: 7 }])).toEqual([
      ['abc ', []],
      ['def', ['q']],
      [' ghi', []],
    ]);
  });

  it('splits overlapping spans so every character belongs to exactly one segment', () => {
    const segments = segmentText('0123456789', [
      { id: 'a', start: 2, end: 6 },
      { id: 'b', start: 4, end: 8 },
    ]);
    expect(segments.map((s) => [s.text, s.ids])).toEqual([
      ['01', []],
      ['23', ['a']],
      ['45', ['a', 'b']],
      ['67', ['b']],
      ['89', []],
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('0123456789');
  });

  it('handles nested, identical and adjacent spans', () => {
    expect(
      marked('abcdef', [
        { id: 'outer', start: 0, end: 6 },
        { id: 'inner', start: 2, end: 4 },
        { id: 'same', start: 2, end: 4 },
      ]),
    ).toEqual([
      ['ab', ['outer']],
      ['cd', ['inner', 'outer', 'same']],
      ['ef', ['outer']],
    ]);
    expect(
      marked('abcd', [
        { id: 'x', start: 0, end: 2 },
        { id: 'y', start: 2, end: 4 },
      ]),
    ).toEqual([
      ['ab', ['x']],
      ['cd', ['y']],
    ]);
  });

  it('ignores empty spans and clips spans to the text', () => {
    expect(
      marked('abc', [
        { id: 'empty', start: 1, end: 1 },
        { id: 'reversed', start: 2, end: 1 },
        { id: 'wide', start: -5, end: 99 },
      ]),
    ).toEqual([['abc', ['wide']]]);
  });

  it('returns no segments for empty text', () => {
    expect(segmentText('', [{ id: 'a', start: 0, end: 3 }])).toEqual([]);
  });
});

describe('quoteSpan', () => {
  const PAGE = 'Rated   head:\n260 ft\nRated flow: 1997 gpm';

  it('locates a quote that differs from the page only in whitespace', () => {
    const span = quoteSpan('Rated head: 260 ft', PAGE);
    expect(span).not.toBeNull();
    expect(PAGE.slice(span?.start, span?.end)).toBe('Rated   head:\n260 ft');
  });

  it('returns null for a quote that is not on the page', () => {
    expect(quoteSpan('Rated head: 250 ft', PAGE)).toBeNull();
  });
});
