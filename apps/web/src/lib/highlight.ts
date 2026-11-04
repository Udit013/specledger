import { locateQuote } from '@specledger/core';

// A range of page text to mark, as UTF-16 offsets [start, end).
export interface HighlightSpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

// A run of page text and the spans that cover all of it.
export interface Segment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  // The covering spans' ids, sorted; empty for unmarked text.
  readonly ids: readonly string[];
}

// Cuts the text at every span boundary, so overlapping, nested and identical spans become plain
// consecutive segments, each knowing which spans cover it. Every character is in exactly one
// segment, in order. Spans are clipped to the text; empty and reversed ones are ignored.
export function segmentText(text: string, spans: readonly HighlightSpan[]): Segment[] {
  if (text.length === 0) return [];
  const clipped = spans
    .map((span) => ({
      id: span.id,
      start: Math.max(0, Math.min(text.length, span.start)),
      end: Math.max(0, Math.min(text.length, span.end)),
    }))
    .filter((span) => span.start < span.end);
  const cuts = [
    ...new Set([0, text.length, ...clipped.flatMap((span) => [span.start, span.end])]),
  ].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const start = cuts[i] ?? 0;
    const end = cuts[i + 1] ?? text.length;
    const ids = clipped
      .filter((span) => span.start <= start && span.end >= end)
      .map((span) => span.id)
      .sort();
    segments.push({ text: text.slice(start, end), start, end, ids });
  }
  return segments;
}

// Where a field's quote is on its page, matched exactly as the verifier matched it (core's
// normalization and offset map), or null when it is not there.
export function quoteSpan(quote: string, pageText: string): { start: number; end: number } | null {
  return locateQuote(quote, pageText);
}
