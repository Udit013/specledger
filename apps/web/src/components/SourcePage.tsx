import type { FieldView } from '@specledger/core';
import { useMemo } from 'react';

import { quoteSpan, segmentText } from '../lib/highlight.js';
import type { HighlightSpan } from '../lib/highlight.js';

// The page text as plain text. It is untrusted document content: it is passed to React as text
// children only, so markup in it is shown literally and never parsed. Every field quoted on this
// page is marked; the selected field's quote is the current mark.
export function SourcePage({
  pageNumber,
  content,
  fields,
  selected,
}: {
  readonly pageNumber: number;
  readonly content: string;
  readonly fields: readonly FieldView[];
  readonly selected: FieldView;
}) {
  const { segments, selectedFound } = useMemo(() => {
    const spans: HighlightSpan[] = [];
    let found = false;
    for (const field of fields) {
      if (field.page !== pageNumber) continue;
      const span = quoteSpan(field.quote, content);
      if (span === null) continue;
      spans.push({ id: field.id, ...span });
      if (field.id === selected.id) found = true;
    }
    return { segments: segmentText(content, spans), selectedFound: found };
  }, [content, fields, pageNumber, selected.id]);

  return (
    <section aria-label={`Source page ${String(pageNumber)}`} className="min-w-0">
      <h3 className="mb-2 font-semibold">Page {pageNumber}</h3>
      {selectedFound ? null : (
        <div className="mb-2 rounded border border-amber-700 bg-amber-50 p-2 text-sm text-amber-950">
          <p className="font-semibold">The quote could not be located on this page.</p>
          <p>
            Quote given for {selected.name}: <q>{selected.quote}</q>
          </p>
        </div>
      )}
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded border bg-slate-50 p-3 font-mono text-sm leading-relaxed">
        {segments.map((segment) =>
          segment.ids.length === 0 ? (
            segment.text
          ) : (
            <mark
              key={segment.start}
              data-current={segment.ids.includes(selected.id) ? 'true' : undefined}
              className={
                segment.ids.includes(selected.id)
                  ? 'bg-yellow-300 outline outline-2 outline-yellow-700'
                  : 'bg-sky-100'
              }
            >
              {segment.text}
            </mark>
          ),
        )}
      </pre>
    </section>
  );
}
