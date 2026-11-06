import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { hrefFor } from '../lib/router.js';
import { ErrorNotice } from './Status.js';

// Sign-in for the real workspace. The password goes to the API once, over the same origin; the
// session comes back as an HttpOnly cookie that no script, including this one, can read.
export function SignIn({
  onSignIn,
  busy,
  error,
}: {
  readonly onSignIn: (email: string, password: string) => void;
  readonly busy: boolean;
  readonly error: unknown;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (email.trim() === '' || password === '') {
      setProblem('Enter your email and password.');
      return;
    }
    setProblem(null);
    if (!busy) onSignIn(email.trim(), password);
  };
  return (
    <section aria-labelledby="sign-in-heading" className="mx-auto max-w-md">
      <h2 id="sign-in-heading" className="page-title">
        Sign in
      </h2>
      <p className="page-lead mb-6">
        For your company workspace: uploading documents, reviewing and publishing. Accounts are
        created by your administrator. Just looking?{' '}
        <a href={hrefFor({ name: 'documents' })} className="link">
          Browse the showcase
        </a>{' '}
        without an account.
      </p>
      <form onSubmit={submit} noValidate className="card space-y-4 p-6">
        <label className="field">
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            className="input"
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            className="input"
          />
        </label>
        {problem === null ? null : (
          <p role="alert" className="notice notice-error">
            {problem}
          </p>
        )}
        {error === null || error === undefined ? null : (
          <ErrorNotice title="You were not signed in." error={error} />
        )}
        <button type="submit" aria-disabled={busy} className="btn btn-primary w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
