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
      <h2 id="audit-heading" className="mb-1 text-xl font-semibold">
        History
      </h2>
      <p className="mb-3 text-sm">
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
        <p>No events recorded.</p>
      ) : (
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">History</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="w-48 py-1">
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
              <tr key={event.id} className="border-b align-top">
                <td className="py-1">{event.createdAt}</td>
                <td>{event.actor}</td>
                <td>{event.action}</td>
                <td>{event.reason ?? '—'}</td>
                <td>
                  <pre className="whitespace-pre-wrap break-all font-mono text-xs">
                    {JSON.stringify({ before: event.before, after: event.after }, null, 1)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
