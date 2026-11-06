import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ApiClientError } from '../api/client.js';
import { useServices } from '../context.js';
import { BLOCKER_LABELS } from '../lib/labels.js';
import { hrefFor } from '../lib/router.js';
import { Dialog } from './Dialog.js';
import { ErrorNotice } from './Status.js';

// Publishing is the server's decision: the dialog asks, then shows exactly what the server said,
// either the new version or the blockers it listed.
export function PublishDialog({ onClose }: { readonly onClose: () => void }) {
  const { client, announce, mode } = useServices();
  const simulated = mode === 'demo';
  const queryClient = useQueryClient();
  const publish = useMutation({
    mutationFn: () => client.publish(),
    onSuccess: async (result) => {
      announce(
        `Published ${simulated ? 'demo ' : ''}register version ${String(result.version.number)}${simulated ? ' (simulated)' : ''}.`,
      );
      await queryClient.invalidateQueries();
    },
    onError: (error) => {
      announce(
        error instanceof ApiClientError && error.code === 'PUBLISH_BLOCKED'
          ? 'Publishing is blocked.'
          : 'The register was not published.',
      );
    },
  });
  const error = publish.error;
  const blocked = error instanceof ApiClientError && error.code === 'PUBLISH_BLOCKED';

  return (
    <Dialog
      title={simulated ? 'Publish register (simulated)' : 'Publish register'}
      onClose={onClose}
    >
      {simulated ? (
        <p className="notice notice-info mb-3">
          This is a simulated publish in your private demo sandbox. It runs the real checks and
          creates a demo register version that only you can see; it is not a real register.
        </p>
      ) : null}
      <p className="mb-3 text-sm">
        Publishing creates the next immutable register version from the reviewed values. The server
        refuses while anything is still processing, pending review or in conflict.
      </p>
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          // aria-disabled rather than disabled: a disabled button would drop keyboard focus.
          aria-disabled={publish.isPending}
          onClick={() => {
            if (!publish.isPending) publish.mutate();
          }}
          className="btn btn-primary"
        >
          Publish now
        </button>
        <button type="button" onClick={onClose} className="btn btn-secondary">
          Close
        </button>
      </div>
      {publish.isSuccess ? (
        <p className="text-sm font-medium">
          Published {simulated ? 'demo ' : ''}register version {publish.data.version.number} with{' '}
          {publish.data.itemCount} {publish.data.itemCount === 1 ? 'item' : 'items'}.{' '}
          <a
            href={hrefFor({ name: 'register_version', number: publish.data.version.number })}
            className="link"
          >
            Open it in the register
          </a>
        </p>
      ) : null}
      {blocked ? (
        <div className="text-sm">
          <h3 className="font-semibold">Publishing is blocked</h3>
          <ul className="mt-1 list-disc pl-5">
            {error.blockers.map((blocker) => (
              <li key={`${blocker.kind}:${blocker.subjectId}:${blocker.fieldName ?? ''}`}>
                {BLOCKER_LABELS[blocker.kind]}:{' '}
                {blocker.equipmentTag === null
                  ? `job ${blocker.subjectId.slice(0, 8)}`
                  : `${blocker.equipmentTag} ${blocker.fieldName ?? ''}`.trim()}
              </li>
            ))}
          </ul>
        </div>
      ) : error === null ? null : (
        <ErrorNotice title="The register was not published." error={error} />
      )}
    </Dialog>
  );
}
