import { useState } from 'react';
import type { SubmitEvent } from 'react';

import type { Tokens } from '../lib/tokens.js';

// The demo has no accounts: a reviewer pastes the role tokens the operator configured. They are
// kept in memory and sessionStorage only.
export function TokenForm({
  tokens,
  onSave,
  onForget,
}: {
  readonly tokens: Tokens;
  readonly onSave: (tokens: Tokens) => void;
  readonly onForget: () => void;
}) {
  const [engineer, setEngineer] = useState(tokens.engineer ?? '');
  const [approver, setApprover] = useState(tokens.approver ?? '');
  const save = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({
      engineer: engineer.trim() === '' ? null : engineer.trim(),
      approver: approver.trim() === '' ? null : approver.trim(),
    });
  };
  return (
    <form onSubmit={save} className="max-w-md space-y-3">
      <p className="text-sm">
        Enter the API tokens for your roles. Reviewing and resolving use the engineer token;
        publishing uses the approver token. They stay in this browser tab only.
      </p>
      <label className="flex flex-col text-sm">
        Engineer token
        <input
          type="password"
          autoComplete="off"
          value={engineer}
          onChange={(e) => {
            setEngineer(e.target.value);
          }}
          className="rounded border px-2 py-1"
        />
      </label>
      <label className="flex flex-col text-sm">
        Approver token
        <input
          type="password"
          autoComplete="off"
          value={approver}
          onChange={(e) => {
            setApprover(e.target.value);
          }}
          className="rounded border px-2 py-1"
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" className="rounded border border-slate-700 px-3 py-1 text-sm">
          Save tokens
        </button>
        <button type="button" onClick={onForget} className="rounded border px-3 py-1 text-sm">
          Forget tokens
        </button>
      </div>
    </form>
  );
}
