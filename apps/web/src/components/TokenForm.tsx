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
      <label className="field">
        Engineer token
        <input
          type="password"
          autoComplete="off"
          value={engineer}
          onChange={(e) => {
            setEngineer(e.target.value);
          }}
          className="input"
        />
      </label>
      <label className="field">
        Approver token
        <input
          type="password"
          autoComplete="off"
          value={approver}
          onChange={(e) => {
            setApprover(e.target.value);
          }}
          className="input"
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary">
          Save tokens
        </button>
        <button type="button" onClick={onForget} className="btn btn-secondary">
          Forget tokens
        </button>
      </div>
    </form>
  );
}
