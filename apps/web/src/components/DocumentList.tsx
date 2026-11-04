import type { DocumentSummary } from '@specledger/core';
import { useQuery } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { useRef } from 'react';

import { DOCUMENT_PAGE_SIZE } from '../api/client.js';
import { useServices } from '../context.js';
import { pollDelay } from '../lib/backoff.js';
import { JOB_LABELS } from '../lib/labels.js';
import { hrefFor } from '../lib/router.js';
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
      <h2 id="documents-heading" className="mb-3 text-xl font-semibold">
        Documents
      </h2>
      {documents.isPending ? (
        <Loading label="Loading documents" />
      ) : documents.isError ? (
        <ErrorNotice
          title="The documents could not be loaded."
          error={documents.error}
          onRetry={() => void documents.refetch()}
        />
      ) : documents.data.length === 0 ? (
        <p>No documents yet. Upload one with POST /documents, then it appears here.</p>
      ) : (
        <>
          {documents.data.length >= DOCUMENT_PAGE_SIZE ? (
            <p className="mb-2 text-sm">
              Showing the newest {DOCUMENT_PAGE_SIZE} documents. Older ones are not listed here.
            </p>
          ) : null}
          <table className="w-full table-fixed border-collapse text-sm">
            <caption className="sr-only">Documents and their processing status</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="w-2/5 py-1">
                  Document
                </th>
                <th scope="col">Type</th>
                <th scope="col">Revision</th>
                <th scope="col">Pages</th>
                <th scope="col" className="w-40">
                  Processing
                </th>
              </tr>
            </thead>
            <tbody>
              {documents.data.map((d) => {
                const label = JOB_LABELS[d.processing.status];
                return (
                  <tr key={d.id} className="border-b">
                    <td className="truncate py-1">
                      <a
                        href={hrefFor({ name: 'review', documentId: d.id })}
                        className="text-blue-800 underline"
                        aria-label={`Review ${d.originalFilename}`}
                      >
                        {d.originalFilename}
                      </a>
                    </td>
                    <td>{d.documentType}</td>
                    <td>{d.revision ?? '—'}</td>
                    <td>{d.pageCount}</td>
                    <td>
                      <Status
                        text={label.text}
                        symbol={label.symbol}
                        tone={TONES[d.processing.status]}
                      />
                      {d.processing.lastErrorCode === null ? null : (
                        <span className="ml-1 text-xs">{d.processing.lastErrorCode}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
