import { ACCOUNT_LIMITS, USER_ROLES } from '@specledger/core';
import type { UserRole, UserView } from '@specledger/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { useServices } from '../context.js';
import { ErrorNotice, Loading, Status } from './Status.js';

const ROLE_HELP: Readonly<Record<UserRole, string>> = {
  engineer: 'uploads documents and corrects values',
  reviewer: 'accepts or rejects values and resolves conflicts',
  approver: 'publishes register versions',
  admin: 'manages users and operations',
};

// User administration: create accounts, change roles, disable and enable. Role changes apply at
// once; disabling ends the user's sessions. The server keeps at least one active admin.
export function UsersAdmin() {
  const { client, announce } = useServices();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => client.listUsers() });
  const update = useMutation({
    mutationFn: (input: { user: UserView; roles?: UserRole[]; disabled?: boolean }) =>
      client.updateUser(input.user.id, {
        ...(input.roles === undefined ? {} : { roles: input.roles }),
        ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
      }),
    onSuccess: async (user) => {
      announce(`Saved ${user.email}.`);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  return (
    <section aria-labelledby="users-heading">
      <h2 id="users-heading" className="page-title">
        Users
      </h2>
      <p className="page-lead mb-6">
        Who can sign in to this workspace, and what each person may do. A person can hold several
        roles.
      </p>
      <CreateUser />
      <DemoReset />
      <h3 className="mt-8 mb-3 text-sm font-semibold tracking-wide text-slate-600 uppercase">
        Accounts
      </h3>
      {update.isError ? (
        <div className="mb-3">
          <ErrorNotice title="The change was not saved." error={update.error} />
        </div>
      ) : null}
      {users.isPending ? (
        <Loading label="Loading users" />
      ) : users.isError ? (
        <ErrorNotice
          title="The users could not be loaded."
          error={users.error}
          onRetry={() => void users.refetch()}
        />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Users and their roles</caption>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Roles</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((user) => (
                <tr key={user.id}>
                  <td>
                    <span className="block font-medium">{user.displayName}</span>
                    <span className="block text-xs text-slate-600">{user.email}</span>
                  </td>
                  <td>
                    <RoleEditor
                      user={user}
                      busy={update.isPending}
                      onSave={(roles) => {
                        update.mutate({ user, roles });
                      }}
                    />
                  </td>
                  <td>
                    <Status
                      text={user.disabled ? 'Disabled' : 'Active'}
                      symbol={user.disabled ? '○' : '●'}
                      tone={user.disabled ? 'neutral' : 'good'}
                    />
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      aria-disabled={update.isPending}
                      onClick={() => {
                        if (!update.isPending) update.mutate({ user, disabled: !user.disabled });
                      }}
                      className="btn btn-secondary"
                    >
                      {user.disabled ? 'Enable' : 'Disable'}{' '}
                      <span className="sr-only">{user.email}</span>
                    </button>
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

function RoleEditor({
  user,
  busy,
  onSave,
}: {
  readonly user: UserView;
  readonly busy: boolean;
  readonly onSave: (roles: UserRole[]) => void;
}) {
  const [roles, setRoles] = useState<readonly UserRole[]>(user.roles);
  const changed = [...roles].sort().join() !== [...user.roles].sort().join();
  return (
    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <legend className="sr-only">Roles of {user.email}</legend>
      {USER_ROLES.map((role) => (
        <label key={role} className="inline-flex items-center gap-1.5 text-sm capitalize">
          <input
            type="checkbox"
            className="accent-brand-700"
            checked={roles.includes(role)}
            onChange={(e) => {
              setRoles((current) =>
                e.target.checked ? [...current, role] : current.filter((r) => r !== role),
              );
            }}
          />
          {role}
        </label>
      ))}
      {changed ? (
        <button
          type="button"
          aria-disabled={busy || roles.length === 0}
          onClick={() => {
            if (!busy && roles.length > 0) onSave([...roles]);
          }}
          className="btn btn-primary px-2.5 py-1"
        >
          Save roles <span className="sr-only">of {user.email}</span>
        </button>
      ) : null}
    </fieldset>
  );
}

// Starts the public demo over: the showcase is wiped and its documents are extracted again (one
// model call each), so it asks before doing it. Visitors' sandboxes are left alone.
function DemoReset() {
  const { client, announce } = useServices();
  const [confirming, setConfirming] = useState(false);
  const reset = useMutation({
    mutationFn: () => client.resetDemo(),
    onSuccess: () => {
      setConfirming(false);
      announce('The demo showcase was reset and is being extracted again.');
    },
  });
  return (
    <div className="card mt-6 flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-lg font-semibold">Demo showcase</h3>
        <p className="mt-1 text-sm text-slate-600">
          Reset wipes the public showcase and extracts its documents again with the model. Visitors'
          sandboxes are not affected.
        </p>
        {reset.isSuccess ? (
          <p className="mt-2 text-sm font-medium">
            Reset. The documents are being extracted again.
          </p>
        ) : null}
        {reset.isError ? (
          <div className="mt-2">
            <ErrorNotice title="The demo was not reset." error={reset.error} />
          </div>
        ) : null}
      </div>
      {confirming ? (
        <div className="flex gap-2">
          <button
            type="button"
            aria-disabled={reset.isPending}
            onClick={() => {
              if (!reset.isPending) reset.mutate();
            }}
            className="btn btn-danger"
          >
            {reset.isPending ? 'Resetting…' : 'Yes, reset the showcase'}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
          className="btn btn-secondary self-start sm:self-auto"
        >
          Reset the demo showcase
        </button>
      )}
    </div>
  );
}

function CreateUser() {
  const { client, announce } = useServices();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<UserRole[]>(['engineer']);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      client.createUser({ email: email.trim(), displayName: displayName.trim(), roles, password }),
    onSuccess: async (user) => {
      announce(`Created ${user.email}.`);
      setEmail('');
      setDisplayName('');
      setPassword('');
      setRoles(['engineer']);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const missing = [
      ...(email.trim() === '' ? ['Enter an email.'] : []),
      ...(displayName.trim() === '' ? ['Enter a name.'] : []),
      ...(password.length < ACCOUNT_LIMITS.passwordMin
        ? [`Choose a password of at least ${String(ACCOUNT_LIMITS.passwordMin)} characters.`]
        : []),
      ...(roles.length === 0 ? ['Choose at least one role.'] : []),
    ];
    setProblem(missing.length === 0 ? null : missing.join(' '));
    if (missing.length === 0 && !create.isPending) create.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="card space-y-4 p-6">
      <h3 className="text-lg font-semibold">Add a user</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="field">
          Email
          <input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            className="input"
          />
        </label>
        <label className="field">
          Name
          <input
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
            }}
            className="input"
          />
        </label>
        <label className="field">
          Initial password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            className="input"
          />
        </label>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-800">Roles</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {USER_ROLES.map((role) => (
            <label key={role} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 accent-brand-700"
                checked={roles.includes(role)}
                onChange={(e) => {
                  setRoles((current) =>
                    e.target.checked ? [...current, role] : current.filter((r) => r !== role),
                  );
                }}
              />
              <span>
                <span className="font-medium capitalize">{role}</span>{' '}
                <span className="text-slate-600">— {ROLE_HELP[role]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {problem === null ? null : (
        <p role="alert" className="notice notice-error">
          {problem}
        </p>
      )}
      {create.isError ? (
        <ErrorNotice title="The user was not created." error={create.error} />
      ) : null}
      <button type="submit" aria-disabled={create.isPending} className="btn btn-primary">
        {create.isPending ? 'Adding…' : 'Add user'}
      </button>
    </form>
  );
}
