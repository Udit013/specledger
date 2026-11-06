import { useQuery } from '@tanstack/react-query';

import { useServices } from '../context.js';
import { ErrorNotice, Loading } from './Status.js';

const KIND_NAMES = { field: 'field', conflict: 'conflict', register_version: 'register version' };

// The audit log of one field, conflict or register version. Before and after are shown as JSON
// text, never interpreted.
export function AuditView({
  kind,
  id,
}: {
  readonly kind: 'field' | 'conflict' | 'register_version';
  readonly id: string;
}) {
  const { client } = useServices();
  const events = useQuery({ queryKey: ['audit', kind, id], queryFn: () => client.audit(kind, id) });
  return (
    <section aria-labelledby="audit-heading">
      <h2 id="audit-heading" className="page-title">
        History
      </h2>
      <p className="page-lead mb-6">
        Every change to {KIND_NAMES[kind]} <code>{id}</code>, oldest first.
      </p>
      {events.isPending ? (
        <Loading label="Loading the history" />
      ) : events.isError ? (
        <ErrorNotice
          title="The history could not be loaded."
          error={events.error}
          onRetry={() => void events.refetch()}
        />
      ) : events.data.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-slate-600">
          <p>No events recorded.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">History</caption>
            <thead>
              <tr className="text-left">
                <th scope="col" className="w-48">
                  Time
                </th>
                <th scope="col" className="w-32">
                  Actor
                </th>
                <th scope="col" className="w-20">
                  Action
                </th>
                <th scope="col">Reason</th>
                <th scope="col" className="w-2/5">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((event) => (
                <tr key={event.id} className="align-top">
                  <td className="text-slate-700 tabular-nums">{event.createdAt}</td>
                  <td className="font-mono text-xs">{event.actor}</td>
                  <td className="font-medium">{event.action}</td>
                  <td>{event.reason ?? '—'}</td>
                  <td>
                    <pre className="rounded-lg bg-slate-50 p-2 font-mono text-xs break-all whitespace-pre-wrap text-slate-700">
                      {JSON.stringify({ before: event.before, after: event.after }, null, 1)}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
