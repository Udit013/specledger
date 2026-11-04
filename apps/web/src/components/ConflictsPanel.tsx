import type { ConflictView } from '@specledger/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { SubmitEvent } from 'react';

import { useServices } from '../context.js';
import { RULE_LABELS, VERIFICATION_LABELS } from '../lib/labels.js';
import { hrefFor } from '../lib/router.js';
import { ErrorNotice, Loading } from './Status.js';

export function ConflictsPanel() {
  const { client } = useServices();
  const conflicts = useQuery({
    queryKey: ['conflicts', 'open'],
    queryFn: () => client.listConflicts('open'),
  });
  return (
    <section aria-labelledby="conflicts-heading">
      <h2 id="conflicts-heading" tabIndex={-1} className="mb-3 text-xl font-semibold">
        Open conflicts
      </h2>
      {conflicts.isPending ? (
        <Loading label="Loading conflicts" />
      ) : conflicts.isError ? (
        <ErrorNotice
          title="The conflicts could not be loaded."
          error={conflicts.error}
          onRetry={() => void conflicts.refetch()}
        />
      ) : conflicts.data.length === 0 ? (
        <p>No open conflicts.</p>
      ) : (
        <div className="space-y-4">
          {conflicts.data.map((conflict) => (
            <ConflictCard key={conflict.id} conflict={conflict} />
          ))}
        </div>
      )}
    </section>
  );
}

function suggestionText(conflict: ConflictView): string {
  const rules = conflict.suggestion.rules.map((rule) => RULE_LABELS[rule]).join(', ');
  const chosen = conflict.candidates.find((c) => c.fieldId === conflict.suggestion.fieldId);
  if (chosen === undefined) {
    return `The rules cannot choose${rules === '' ? '' : `: ${rules}`}. A reviewer has to decide.`;
  }
  return `The rules would choose ${chosen.value} ${chosen.unit} (${rules}). This is a suggestion; nothing is applied until you resolve.`;
}

function ConflictCard({ conflict }: { readonly conflict: ConflictView }) {
  const { client, announce } = useServices();
  const queryClient = useQueryClient();
  const headingId = useId();
  const name = `${conflict.equipmentTag} ${conflict.fieldName}`;
  const [choice, setChoice] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const resolve = useMutation({
    mutationFn: () =>
      client.resolveConflict(conflict.id, {
        choice:
          choice === 'value'
            ? { kind: 'value', value: value.trim(), unit: unit.trim() }
            : { kind: 'candidate', fieldId: choice ?? '' },
        reason: reason.trim(),
      }),
    onSuccess: async (resolved) => {
      announce(
        `${name} resolved: ${resolved.resolution?.value ?? ''} ${resolved.resolution?.unit ?? ''}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['conflicts'] });
      document.getElementById('conflicts-heading')?.focus();
    },
    onError: async () => {
      announce(`${name} was not resolved.`);
      await queryClient.invalidateQueries({ queryKey: ['conflicts'] });
    },
  });

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (choice === null) {
      setProblem('Choose a candidate or enter a value.');
    } else if (choice === 'value' && (value.trim() === '' || unit.trim() === '')) {
      setProblem('Enter the value and its unit.');
    } else if (reason.trim() === '') {
      setProblem('Enter a reason for the decision.');
    } else if (!resolve.isPending) {
      setProblem(null);
      resolve.mutate();
    }
  };

  const group = `choice-${conflict.id}`;
  return (
    <section aria-labelledby={headingId} className="rounded border p-3">
      <h3 id={headingId} className="font-semibold">
        {name}
      </h3>
      <p className="my-2 text-sm">{suggestionText(conflict)}</p>
      <form onSubmit={submit} noValidate className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Choose the value</legend>
          {conflict.candidates.map((candidate) => {
            const id = `${group}-${candidate.fieldId}`;
            const verification = VERIFICATION_LABELS[candidate.verificationStatus];
            const suggested = candidate.fieldId === conflict.suggestion.fieldId;
            return (
              <div key={candidate.fieldId} className="rounded border p-2 text-sm">
                <input
                  type="radio"
                  id={id}
                  name={group}
                  checked={choice === candidate.fieldId}
                  onChange={() => {
                    setChoice(candidate.fieldId);
                  }}
                />{' '}
                <label htmlFor={id}>
                  {candidate.value} {candidate.unit} — {candidate.documentType}{' '}
                  {candidate.revision ?? 'no revision'}, page {candidate.page},{' '}
                  {verification.text.toLowerCase()}
                </label>
                {suggested ? (
                  <span className="ml-2 rounded border border-blue-800 px-1 text-xs">
                    Suggested by the rules
                  </span>
                ) : null}
                {candidate.reviewStatus === 'rejected' ? (
                  <span className="ml-2 rounded border border-red-700 px-1 text-xs">
                    Rejected in review
                  </span>
                ) : null}
                <blockquote className="mt-1 border-l-4 pl-2 font-mono text-xs">
                  {candidate.quote}
                </blockquote>
                <a
                  href={hrefFor({ name: 'review', documentId: candidate.documentId })}
                  className="text-xs text-blue-800 underline"
                >
                  Open this document
                </a>
              </div>
            );
          })}
          <div className="rounded border p-2 text-sm">
            <input
              type="radio"
              id={`${group}-value`}
              name={group}
              checked={choice === 'value'}
              onChange={() => {
                setChoice('value');
              }}
            />{' '}
            <label htmlFor={`${group}-value`}>Enter another value</label>
            {choice === 'value' ? (
              <div className="mt-2 flex gap-2">
                <label className="flex flex-col">
                  Value
                  <input
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                    }}
                    className="rounded border px-2 py-1"
                  />
                </label>
                <label className="flex flex-col">
                  Unit
                  <input
                    value={unit}
                    onChange={(e) => {
                      setUnit(e.target.value);
                    }}
                    className="rounded border px-2 py-1"
                  />
                </label>
              </div>
            ) : null}
          </div>
        </fieldset>
        <label className="flex flex-col text-sm">
          Reason
          <textarea
            value={reason}
            rows={2}
            onChange={(e) => {
              setReason(e.target.value);
            }}
            className="rounded border px-2 py-1"
          />
        </label>
        {problem === null ? null : (
          <p role="alert" className="text-sm text-red-900">
            {problem}
          </p>
        )}
        {resolve.isError ? (
          <ErrorNotice title="The conflict was not resolved." error={resolve.error} />
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            aria-disabled={resolve.isPending}
            className="rounded border border-slate-700 px-3 py-1 text-sm font-medium"
          >
            Resolve conflict
          </button>
          <a
            href={hrefFor({ name: 'audit', kind: 'conflict', id: conflict.id })}
            className="text-sm text-blue-800 underline"
          >
            History of this conflict
          </a>
        </div>
      </form>
    </section>
  );
}
