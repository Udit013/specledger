import type { HandoffPreview, RegisterVersionDetail } from '@specledger/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import { useServices } from '../context.js';
import { hrefFor } from '../lib/router.js';
import { Icon } from './Icons.js';
import { ErrorNotice, Loading } from './Status.js';

const ADAPTER_CONTRACT = 'https://github.com/Udit013/specledger/blob/main/docs/adapter-contract.md';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const who = (actor: string) => actor.replace(/^user:/, '').replace(/^demo:.*/, 'you (demo)');

// The published equipment register: the output of the whole workflow. Every version is
// immutable; each value in it was confirmed by a reviewer against its source document.
export function RegisterList() {
  const { client, mode } = useServices();
  const versions = useQuery({
    queryKey: ['register'],
    queryFn: () => client.listRegisterVersions(),
  });
  return (
    <section aria-labelledby="register-heading">
      <h2 id="register-heading" className="page-title">
        Equipment register
      </h2>
      <p className="page-lead mb-6">
        The register is what downstream teams and tools consume: one record per piece of equipment,
        every value confirmed by a reviewer against its source. Each published version is numbered
        and immutable.
      </p>
      {versions.isPending ? (
        <Loading label="Loading the register" />
      ) : versions.isError ? (
        <ErrorNotice
          title="The register could not be loaded."
          error={versions.error}
          onRetry={() => void versions.refetch()}
        />
      ) : versions.data.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="font-semibold">Nothing has been published yet.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
            {mode === 'showcase'
              ? 'Publishing needs an approver. Try it yourself to review, resolve conflicts and publish a version in a private sandbox.'
              : 'Once every value is reviewed and every conflict resolved, an approver publishes version 1. The server refuses earlier and lists what is missing.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Published register versions</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Published</th>
                <th scope="col" className="max-sm:hidden">
                  Approved by
                </th>
                <th scope="col">Equipment</th>
              </tr>
            </thead>
            <tbody>
              {versions.data.map((version) => (
                <tr key={version.id}>
                  <td>
                    <a
                      href={hrefFor({ name: 'register_version', number: version.number })}
                      className="link"
                    >
                      Version {version.number}
                    </a>
                  </td>
                  <td className="text-slate-700">{when(version.publishedAt)}</td>
                  <td className="text-slate-700 max-sm:hidden">{who(version.approvedBy)}</td>
                  <td className="text-slate-700 tabular-nums">{version.itemCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function RegisterVersion({ number }: { readonly number: number }) {
  const { client, mode } = useServices();
  const detail = useQuery({
    queryKey: ['register', number],
    queryFn: () => client.getRegisterVersion(number),
  });
  const handoff = useQuery({
    queryKey: ['register', number, 'handoff'],
    queryFn: () => client.getHandoff(number),
  });
  const download = useMutation({
    mutationFn: async (format: 'csv' | 'json') => {
      const file = await client.exportVersion(number, format);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
      return file.filename;
    },
  });

  return (
    <section aria-labelledby="version-heading">
      <a href={hrefFor({ name: 'register' })} className="link text-sm">
        ← Equipment register
      </a>
      {detail.isPending ? (
        <Loading label="Loading the version" />
      ) : detail.isError ? (
        <ErrorNotice
          title="The version could not be loaded."
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <>
          <div className="mt-2 mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="version-heading" className="page-title">
                Register version {detail.data.version.number}
                {mode === 'demo' ? (
                  <span className="ml-2 align-middle text-sm font-medium text-slate-600">
                    (demo, simulated)
                  </span>
                ) : null}
              </h2>
              <p className="page-lead">
                Published {when(detail.data.version.publishedAt)} by{' '}
                {who(detail.data.version.approvedBy)}. Immutable: a correction becomes the next
                version.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(['csv', 'json'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  aria-disabled={download.isPending}
                  onClick={() => {
                    if (!download.isPending) download.mutate(format);
                  }}
                  className="btn btn-secondary"
                >
                  <Icon name="document" className="h-4 w-4" />
                  Download {format.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {download.isError ? (
            <div className="mb-4">
              <ErrorNotice title="The file was not downloaded." error={download.error} />
            </div>
          ) : null}
          <Items detail={detail.data} />
        </>
      )}
      <Handoff query={handoff} />
    </section>
  );
}

function Items({ detail }: { readonly detail: RegisterVersionDetail }) {
  if (detail.items.length === 0) {
    return <p className="card p-6 text-sm text-slate-600">This version has no equipment.</p>;
  }
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {detail.items.map((item) => (
        <li key={item.tag} className="card p-5">
          <h3 className="text-lg font-semibold">{item.tag}</h3>
          <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
            {Object.keys(item.values)
              .sort()
              .map((field) => (
                <div key={field} className="contents">
                  <dt className="font-mono text-xs leading-5 break-all text-slate-600">{field}</dt>
                  <dd className="text-right font-medium tabular-nums">
                    {item.values[field]?.value} {item.values[field]?.unit}
                  </dd>
                </div>
              ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

// What handing this version to an asset system would send. Computed by the API with the same
// functions as the tested ACC-style client; nothing is sent and no asset system is connected.
function Handoff({ query }: { readonly query: UseQueryResult<HandoffPreview> }) {
  return (
    <section aria-labelledby="handoff-heading" className="card mt-8 p-6">
      <p className="eyebrow">Integration</p>
      <h3 id="handoff-heading" className="mt-1 text-lg font-semibold">
        Asset-system handoff preview
      </h3>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        The requests a sync of this version would send to an asset system, in an ACC-style upsert
        contract: one per piece of equipment, each with an idempotency key so a retried sync never
        writes twice. <strong className="font-semibold">Nothing is sent:</strong> no asset system is
        connected, and the contract has been tested against a mock, not the real Autodesk API.{' '}
        <a href={ADAPTER_CONTRACT} className="link" rel="noreferrer" target="_blank">
          Read the contract
        </a>
        .
      </p>
      {query.isPending ? (
        <Loading label="Loading the handoff preview" />
      ) : query.isError ? (
        <div className="mt-4">
          <ErrorNotice title="The handoff preview could not be loaded." error={query.error} />
        </div>
      ) : (
        <ol className="mt-4 space-y-3">
          {query.data.requests.map((request) => (
            <li key={request.idempotencyKey} className="panel overflow-hidden">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-brand-600">
                  <span className="font-mono text-xs font-semibold text-brand-800">
                    {request.method} {request.path}
                  </span>
                  <span className="font-medium">{request.payload.name}</span>
                  <span className="text-slate-600">
                    {request.payload.attributes.length} attributes
                  </span>
                </summary>
                <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="font-mono text-xs break-all text-slate-700">
                    Idempotency-Key: {request.idempotencyKey}
                  </p>
                  <pre className="mt-2 max-h-80 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-800">
                    {JSON.stringify(request.payload, null, 2)}
                  </pre>
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
