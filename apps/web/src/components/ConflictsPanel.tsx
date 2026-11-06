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
      <h2 id="conflicts-heading" tabIndex={-1} className="page-title">
        Open conflicts
      </h2>
      <p className="page-lead mb-6">
        Documents that disagree about the same value, where the rules alone should not decide.
        Compare the candidates and their quotes, choose one or enter the correct value, and give a
        reason. Publishing waits until every conflict is resolved.
      </p>
      {conflicts.isPending ? (
        <Loading label="Loading conflicts" />
      ) : conflicts.isError ? (
        <ErrorNotice
          title="The conflicts could not be loaded."
          error={conflicts.error}
          onRetry={() => void conflicts.refetch()}
        />
      ) : conflicts.data.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="font-semibold">No open conflicts.</p>
          <p className="mt-1 text-sm text-slate-600">
            When two documents disagree about a value, the conflict appears here for a decision.
          </p>
        </div>
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
  const { client, announce, can, mode } = useServices();
  const canResolve = can('reviewer');
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
    <section aria-labelledby={headingId} className="card p-5">
      <h3 id={headingId} className="text-lg font-semibold">
        {name}
      </h3>
      <p className="mt-1 mb-4 text-sm text-slate-600">{suggestionText(conflict)}</p>
      <form onSubmit={submit} noValidate className="space-y-4">
        <fieldset className="space-y-2" disabled={!canResolve}>
          <legend className="mb-1 text-sm font-medium text-slate-800">
            {canResolve ? 'Choose the value' : 'The candidates'}
          </legend>
          {conflict.candidates.map((candidate) => {
            const id = `${group}-${candidate.fieldId}`;
            const verification = VERIFICATION_LABELS[candidate.verificationStatus];
            const suggested = candidate.fieldId === conflict.suggestion.fieldId;
            return (
              <div key={candidate.fieldId} className="panel p-4 text-sm">
                <input
                  className="accent-brand-700"
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
                  <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 ring-1 ring-brand-600/30 ring-inset">
                    Suggested by the rules
                  </span>
                ) : null}
                {candidate.reviewStatus === 'rejected' ? (
                  <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800 ring-1 ring-red-600/30 ring-inset">
                    Rejected in review
                  </span>
                ) : null}
                <blockquote className="my-2 rounded-r-lg border-l-4 border-brand-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
                  {candidate.quote}
                </blockquote>
                <a
                  href={hrefFor({ name: 'review', documentId: candidate.documentId })}
                  className="link text-xs"
                >
                  Open this document
                </a>
              </div>
            );
          })}
          <div className="panel p-4 text-sm">
            <input
              className="accent-brand-700"
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
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="field">
                  Value
                  <input
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                    }}
                    className="input"
                  />
                </label>
                <label className="field">
                  Unit
                  <input
                    value={unit}
                    onChange={(e) => {
                      setUnit(e.target.value);
                    }}
                    className="input"
                  />
                </label>
              </div>
            ) : null}
          </div>
        </fieldset>
        {canResolve ? null : (
          <p className="text-sm text-slate-600">
            {mode === 'showcase'
              ? 'This is the read-only showcase. Try it yourself to resolve conflicts in a private sandbox.'
              : 'Resolving a conflict needs the reviewer role.'}
          </p>
        )}
        {canResolve ? (
          <label className="field">
            Reason
            <textarea
              value={reason}
              rows={2}
              onChange={(e) => {
                setReason(e.target.value);
              }}
              className="input"
            />
          </label>
        ) : null}
        {problem === null ? null : (
          <p role="alert" className="notice notice-error">
            {problem}
          </p>
        )}
        {resolve.isError ? (
          <ErrorNotice title="The conflict was not resolved." error={resolve.error} />
        ) : null}
        <div className="flex items-center gap-3">
          {canResolve ? (
            <button type="submit" aria-disabled={resolve.isPending} className="btn btn-primary">
              Resolve conflict
            </button>
          ) : null}
          <a
            href={hrefFor({ name: 'audit', kind: 'conflict', id: conflict.id })}
            className="link text-sm"
          >
            History of this conflict
          </a>
        </div>
      </form>
    </section>
  );
}
