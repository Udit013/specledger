import type { FieldView, ReviewFieldBody } from '@specledger/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmitEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';

import { ApiClientError } from '../api/client.js';
import { useServices } from '../context.js';
import { REVIEW_DONE, REVIEW_LABELS, VERIFICATION_LABELS } from '../lib/labels.js';
import { hrefFor } from '../lib/router.js';
import { isTypingTarget, SHORTCUT_HELP, shortcutFor } from '../lib/shortcuts.js';
import { Dialog } from './Dialog.js';
import { SourcePage } from './SourcePage.js';
import { ErrorNotice, Loading, Status } from './Status.js';

type Mode = { readonly kind: 'idle' } | { readonly kind: 'edit' } | { readonly kind: 'reason' };

// A review the server refused because the field changed: what the server has now, and what the
// reviewer tried, kept so it can be reapplied rather than lost.
interface StaleReview {
  readonly current: FieldView;
  readonly attempted: ReviewFieldBody;
}

const REVIEW_TONES = {
  pending: 'neutral',
  accepted: 'good',
  edited: 'good',
  rejected: 'bad',
} as const;

const modalOpen = () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

const describeChange = (body: ReviewFieldBody) =>
  body.action === 'edit'
    ? `Edit to ${body.value} ${body.unit}`
    : body.action === 'accept'
      ? 'Accept'
      : 'Reject';

export function ReviewScreen({ documentId }: { readonly documentId: string }) {
  const { client, announce, can, mode: access } = useServices();
  // Editing a value needs an engineer or a reviewer; accepting or rejecting one, a reviewer.
  const canEdit = can('engineer') || can('reviewer');
  const canDecide = can('reviewer');
  const queryClient = useQueryClient();

  const document = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => client.getDocument(documentId),
  });
  const fields = useQuery({
    queryKey: ['fields', documentId],
    queryFn: () => client.listFields(documentId),
  });

  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [stale, setStale] = useState<StaleReview | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const list = fields.data ?? [];
  const selected = list[Math.min(index, Math.max(0, list.length - 1))];

  const page = useQuery({
    queryKey: ['page', documentId, selected?.page ?? 0],
    queryFn: () => client.getPage(documentId, selected?.page ?? 1),
    enabled: selected !== undefined,
  });

  // Focus follows the selection after every action, so the keyboard flow never loses its place.
  useEffect(() => {
    if (focusRequest === 0 || selected === undefined) return;
    buttons.current.get(selected.id)?.focus();
  }, [focusRequest, selected]);
  const focusSelected = () => {
    setFocusRequest((n) => n + 1);
  };

  const replaceField = useCallback(
    (field: FieldView) => {
      queryClient.setQueryData<FieldView[]>(['fields', documentId], (old) =>
        (old ?? []).map((f) => (f.id === field.id ? field : f)),
      );
    },
    [queryClient, documentId],
  );

  const review = useMutation({
    mutationFn: ({ field, body }: { field: FieldView; body: ReviewFieldBody }) =>
      client.reviewField(field.id, body),
    onSuccess: (updated, { body }) => {
      replaceField(updated);
      setStale(null);
      setFailure(null);
      setMode({ kind: 'idle' });
      announce(`${updated.name} ${REVIEW_DONE[body.action]}.`);
      setIndex((i) => Math.min(i + 1, list.length - 1));
      focusSelected();
    },
    onError: (error, { body }) => {
      if (error instanceof ApiClientError && error.currentField !== null) {
        // Show the server's state, keep the reviewer's change for reapplying, overwrite nothing.
        replaceField(error.currentField);
        setStale({ current: error.currentField, attempted: body });
        setMode({ kind: 'idle' });
        announce(`${error.currentField.name} changed on the server. Your change was not saved.`);
        return;
      }
      setFailure(error);
      announce('The review was not saved.');
    },
  });

  const submit = useCallback(
    (body: ReviewFieldBody) => {
      if (selected === undefined || review.isPending) return;
      review.mutate({ field: selected, body });
    },
    [review, selected],
  );

  const act = useCallback(
    (action: 'accept' | 'reject' | 'edit') => {
      if (selected === undefined) return;
      if (action === 'edit' ? !canEdit : !canDecide) return;
      setStale(null);
      if (action === 'edit') {
        setMode({ kind: 'edit' });
      } else if (action === 'accept' && selected.verificationStatus !== 'verified') {
        setMode({ kind: 'reason' });
      } else {
        submit({ action, expectedVersion: selected.version });
      }
    },
    [selected, submit, canEdit, canDecide],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Off while typing, and while any modal (help, publish, tokens) is open over the screen.
      if (helpOpen || isTypingTarget(event.target) || modalOpen()) return;
      const shortcut = shortcutFor(event);
      if (shortcut === null) return;
      if (shortcut === 'help') {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (mode.kind !== 'idle' || list.length === 0) return;
      event.preventDefault();
      if (shortcut === 'next' || shortcut === 'previous') {
        setIndex((i) =>
          shortcut === 'next' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0),
        );
        focusSelected();
        return;
      }
      act(shortcut);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [act, helpOpen, list.length, mode.kind]);

  const cancel = () => {
    setMode({ kind: 'idle' });
    focusSelected();
  };

  if (document.isPending || fields.isPending) return <Loading label="Loading the document" />;
  if (document.isError || fields.isError) {
    return (
      <ErrorNotice
        title="The document could not be loaded."
        error={document.error ?? fields.error}
        onRetry={() => {
          void document.refetch();
          void fields.refetch();
        }}
      />
    );
  }

  return (
    <section aria-labelledby="review-heading">
      <a href={hrefFor({ name: 'documents' })} className="link text-sm">
        ← All documents
      </a>
      <h2 id="review-heading" className="page-title mt-2 break-all">
        {document.data.originalFilename}
      </h2>
      <p className="page-lead mb-6">
        <span className="capitalize">{document.data.documentType}</span>,{' '}
        {document.data.revision ?? 'no revision'}. Each value is shown next to its source page, with
        the quote it came from highlighted. Press <kbd>?</kbd> for keyboard shortcuts.
      </p>
      {list.length === 0 || selected === undefined ? (
        <div className="card px-6 py-12 text-center">
          <p className="font-semibold">No fields were extracted from this document yet.</p>
          <p className="mt-1 text-sm text-slate-600">
            Extraction runs in the background; the document list shows its progress.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0">
            <h3 className="mb-3 text-sm font-semibold tracking-wide text-slate-600 uppercase">
              Fields
            </h3>
            <ol aria-label="Fields" className="space-y-1">
              {list.map((field, i) => {
                const verification = VERIFICATION_LABELS[field.verificationStatus];
                const status = REVIEW_LABELS[field.reviewStatus];
                const isSelected = field.id === selected.id;
                return (
                  <li key={field.id}>
                    <button
                      type="button"
                      ref={(element) => {
                        if (element === null) buttons.current.delete(field.id);
                        else buttons.current.set(field.id, element);
                      }}
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => {
                        setIndex(i);
                      }}
                      className={`flex w-full flex-wrap items-center gap-2 rounded-xl border p-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                        isSelected
                          ? 'border-brand-600 bg-brand-50 shadow-xs ring-1 ring-brand-600'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <span className="min-w-44 break-all font-mono">{field.name}</span>{' '}
                      <span className="min-w-24">
                        {field.value} {field.unit}
                      </span>{' '}
                      <Status
                        text={verification.text}
                        symbol={verification.symbol}
                        tone={field.verificationStatus === 'verified' ? 'good' : 'warn'}
                      />{' '}
                      <Status
                        text={status.text}
                        symbol={status.symbol}
                        tone={REVIEW_TONES[field.reviewStatus]}
                      />
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="card mt-4 space-y-4 p-4 lg:sticky lg:bottom-4">
              {canEdit ? null : (
                <p className="text-sm text-slate-600">
                  {access === 'showcase'
                    ? 'This is the read-only showcase. Try it yourself to review values in a private sandbox.'
                    : 'Your role can view these values but not review them.'}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {canDecide ? (
                  <ActionButton
                    label="Accept"
                    shortcut="a"
                    onClick={() => {
                      act('accept');
                    }}
                  />
                ) : null}
                {canEdit ? (
                  <ActionButton
                    label="Edit"
                    shortcut="e"
                    onClick={() => {
                      act('edit');
                    }}
                  />
                ) : null}
                {canDecide ? (
                  <ActionButton
                    label="Reject"
                    shortcut="r"
                    onClick={() => {
                      act('reject');
                    }}
                  />
                ) : null}
                <a
                  href={hrefFor({ name: 'audit', kind: 'field', id: selected.id })}
                  className="link self-center text-sm"
                >
                  History of {selected.name}
                </a>
              </div>
              {selected.verificationStatus === 'verified' ? null : (
                <p className="notice notice-warn">
                  The verifier could not confirm this value:{' '}
                  {selected.verificationReasons.join(', ')}.
                </p>
              )}
              {mode.kind === 'edit' ? (
                <EditForm
                  field={selected}
                  busy={review.isPending}
                  onSubmit={(value, unit, reason) => {
                    submit({
                      action: 'edit',
                      expectedVersion: selected.version,
                      value,
                      unit,
                      ...(reason === '' ? {} : { reason }),
                    });
                  }}
                  onCancel={cancel}
                />
              ) : null}
              {mode.kind === 'reason' ? (
                <ReasonForm
                  busy={review.isPending}
                  onSubmit={(reason) => {
                    submit({ action: 'accept', expectedVersion: selected.version, reason });
                  }}
                  onCancel={cancel}
                />
              ) : null}
              {stale === null ? null : (
                <StaleNotice
                  stale={stale}
                  busy={review.isPending}
                  onReapply={() => {
                    const field = list.find((f) => f.id === stale.current.id) ?? stale.current;
                    review.mutate({
                      field,
                      body: { ...stale.attempted, expectedVersion: stale.current.version },
                    });
                  }}
                  onDiscard={() => {
                    setStale(null);
                    focusSelected();
                  }}
                />
              )}
              {failure === null ? null : (
                <ErrorNotice title="The review was not saved." error={failure} />
              )}
            </div>
          </div>
          {page.isPending ? (
            <Loading label="Loading the source page" />
          ) : page.isError ? (
            <ErrorNotice
              title="The source page could not be loaded."
              error={page.error}
              onRetry={() => void page.refetch()}
            />
          ) : (
            <SourcePage
              pageNumber={page.data.pageNumber}
              content={page.data.content}
              fields={list}
              selected={selected}
            />
          )}
        </div>
      )}
      {helpOpen ? (
        <Dialog
          title="Keyboard shortcuts"
          onClose={() => {
            setHelpOpen(false);
          }}
        >
          <button
            type="button"
            className="input mb-2"
            onClick={() => {
              setHelpOpen(false);
            }}
          >
            Close
          </button>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {SHORTCUT_HELP.map((entry) => (
              <div key={entry.key} className="contents">
                <dt>
                  <kbd>{entry.key}</kbd>
                </dt>
                <dd>{entry.action}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-sm">Shortcuts are off while you type in a form.</p>
        </Dialog>
      ) : null}
    </section>
  );
}

function ActionButton({
  label,
  shortcut,
  onClick,
}: {
  readonly label: string;
  readonly shortcut: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={shortcut}
      className={label === 'Accept' ? 'btn btn-primary' : 'btn btn-secondary'}
    >
      {label} <kbd className="ml-0.5">{shortcut}</kbd>
    </button>
  );
}

const escapeCloses = (onCancel: () => void) => (event: ReactKeyboardEvent<HTMLFormElement>) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    onCancel();
  }
};

function EditForm({
  field,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly field: FieldView;
  readonly busy: boolean;
  readonly onSubmit: (value: string, unit: string, reason: string) => void;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(field.value);
  const [unit, setUnit] = useState(field.unit);
  const [reason, setReason] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Selected, so typing replaces the extracted value instead of appending to it.
    first.current?.focus();
    first.current?.select();
  }, []);
  const save = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(value.trim(), unit.trim(), reason.trim());
  };
  return (
    <form onSubmit={save} onKeyDown={escapeCloses(onCancel)} className="panel space-y-3 p-4">
      <p className="text-sm font-semibold">Edit {field.name}</p>
      <div className="flex gap-2">
        <label className="field">
          Value
          <input
            ref={first}
            value={value}
            required
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
            required
            onChange={(e) => {
              setUnit(e.target.value);
            }}
            className="input"
          />
        </label>
      </div>
      <label className="field">
        Reason (optional)
        <input
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          className="input"
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary">
          Save edit
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReasonForm({
  busy,
  onSubmit,
  onCancel,
}: {
  readonly busy: boolean;
  readonly onSubmit: (reason: string) => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const save = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    onSubmit(reason.trim());
  };
  return (
    <form onSubmit={save} onKeyDown={escapeCloses(onCancel)} className="panel space-y-3 p-4">
      <label className="field">
        Reason for accepting an unverified value
        <input
          ref={input}
          value={reason}
          aria-invalid={missing ? 'true' : undefined}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          className="input"
        />
      </label>
      {missing ? <p className="text-sm text-red-900">Enter a reason.</p> : null}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary">
          Accept with reason
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function StaleNotice({
  stale,
  busy,
  onReapply,
  onDiscard,
}: {
  readonly stale: StaleReview;
  readonly busy: boolean;
  readonly onReapply: () => void;
  readonly onDiscard: () => void;
}) {
  const { current } = stale;
  return (
    <div role="alert" className="notice notice-warn space-y-2">
      <p className="font-semibold">This field changed on the server since you loaded it.</p>
      <p>
        Server value: {current.value} {current.unit}, {REVIEW_LABELS[current.reviewStatus].text},
        version {current.version}.
      </p>
      <p>Your change: {describeChange(stale.attempted)}. It was not saved.</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onReapply} className="btn btn-primary">
          Reapply my change
        </button>
        <button type="button" onClick={onDiscard} className="btn btn-secondary">
          Discard my change
        </button>
      </div>
    </div>
  );
}
