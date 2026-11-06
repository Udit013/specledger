import type { DocumentSummary } from '@specledger/core';
import { useQuery } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { useRef } from 'react';

import { DOCUMENT_PAGE_SIZE } from '../api/client.js';
import { useServices } from '../context.js';
import { pollDelay } from '../lib/backoff.js';
import { JOB_LABELS } from '../lib/labels.js';
import { hrefFor } from '../lib/router.js';
import { Icon } from './Icons.js';
import { ErrorNotice, Loading, Status } from './Status.js';

const ACTIVE = new Set(['queued', 'running']);
const TONES = {
  none: 'neutral',
  queued: 'neutral',
  running: 'warn',
  succeeded: 'good',
  failed: 'bad',
  dead: 'bad',
} as const;

const signature = (documents: readonly DocumentSummary[] | undefined) =>
  (documents ?? [])
    .map((d) => `${d.id}:${d.processing.status}:${String(d.processing.attempts)}`)
    .join('|');

export function DocumentList() {
  const { client, poll } = useServices();
  // Polls only while some document is queued or running, backing off while nothing changes and
  // starting again from the base delay when something does.
  const polling = useRef({ updatedAt: 0, signature: '', unchanged: 0 });
  const documents = useQuery({
    queryKey: ['documents'],
    queryFn: () => client.listDocuments(),
    refetchInterval: (query: Query<DocumentSummary[]>) => {
      const { data, dataUpdatedAt, status } = query.state;
      if (status === 'error') return false;
      const state = polling.current;
      if (dataUpdatedAt !== state.updatedAt) {
        const next = signature(data);
        state.unchanged = next === state.signature ? state.unchanged + 1 : 0;
        state.signature = next;
        state.updatedAt = dataUpdatedAt;
      }
      const active = (data ?? []).some((d) => ACTIVE.has(d.processing.status));
      return active ? pollDelay(state.unchanged, poll) : false;
    },
  });

  return (
    <section aria-labelledby="documents-heading">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="documents-heading" className="page-title">
            Documents
          </h2>
          <p className="page-lead">
            Every uploaded document and where its extraction stands. Open one to review its values
            against the source page.
          </p>
        </div>
        <a href={hrefFor({ name: 'upload' })} className="btn btn-secondary self-start sm:self-auto">
          <Icon name="upload" className="h-4 w-4" />
          Upload a document
        </a>
      </div>
      {documents.isPending ? (
        <Loading label="Loading documents" />
      ) : documents.isError ? (
        <ErrorNotice
          title="The documents could not be loaded."
          error={documents.error}
          onRetry={() => void documents.refetch()}
        />
      ) : documents.data.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
            <Icon name="document" className="h-6 w-6" />
          </span>
          <p className="mt-4 font-semibold">No documents yet.</p>
          <p className="mt-1 max-w-sm text-sm text-slate-600">
            Upload a datasheet and it appears here while it is extracted.
          </p>
          <a href={hrefFor({ name: 'upload' })} className="btn btn-primary mt-5">
            Upload a document
          </a>
        </div>
      ) : (
        <>
          {documents.data.length >= DOCUMENT_PAGE_SIZE ? (
            <p className="mb-3 text-sm text-slate-600">
              Showing the newest {DOCUMENT_PAGE_SIZE} documents. Older ones are not listed here.
            </p>
          ) : null}
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">Documents and their processing status</caption>
              <thead>
                <tr className="text-left">
                  <th scope="col" className="w-2/5">
                    Document
                  </th>
                  <th scope="col" className="max-sm:hidden">
                    Type
                  </th>
                  <th scope="col">Revision</th>
                  <th scope="col" className="max-sm:hidden">
                    Pages
                  </th>
                  <th scope="col" className="sm:w-44">
                    Processing
                  </th>
                </tr>
              </thead>
              <tbody>
                {documents.data.map((d) => {
                  const label = JOB_LABELS[d.processing.status];
                  return (
                    <tr key={d.id}>
                      <td>
                        <a
                          href={hrefFor({ name: 'review', documentId: d.id })}
                          className="inline-flex items-start gap-2 font-medium text-ink hover:text-brand-700 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-brand-600"
                          aria-label={`Review ${d.originalFilename}`}
                        >
                          <Icon
                            name="document"
                            className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                          />
                          <span className="break-words">{d.originalFilename}</span>
                        </a>
                      </td>
                      <td className="text-slate-700 capitalize max-sm:hidden">{d.documentType}</td>
                      <td className="text-slate-700">{d.revision ?? '—'}</td>
                      <td className="text-slate-700 tabular-nums max-sm:hidden">{d.pageCount}</td>
                      <td>
                        <Status
                          text={label.text}
                          symbol={label.symbol}
                          tone={TONES[d.processing.status]}
                        />
                        {d.processing.lastErrorCode === null ? null : (
                          <span className="mt-1 block font-mono text-xs break-all text-red-800">
                            {d.processing.lastErrorCode}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
