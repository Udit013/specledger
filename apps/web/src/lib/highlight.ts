import { notImplemented } from './not-implemented.js';
export interface HighlightSpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}
export interface Segment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly ids: readonly string[];
}
export function segmentText(text: string, spans: readonly HighlightSpan[]): Segment[] {
  return notImplemented(`segmentText(${String(text.length + spans.length)})`);
}
export function quoteSpan(quote: string, pageText: string): { start: number; end: number } | null {
  return notImplemented(`quoteSpan(${quote}${pageText})`);
}
