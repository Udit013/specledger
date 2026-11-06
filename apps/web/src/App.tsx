import type { MeBody, UserRole } from '@specledger/core';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createApiClient } from './api/client.js';
import { AuditView } from './components/AuditView.js';
import { ConflictsPanel } from './components/ConflictsPanel.js';
import { DocumentList } from './components/DocumentList.js';
import { Logo } from './components/Icons.js';
import { Landing } from './components/Landing.js';
import { PublishDialog } from './components/PublishDialog.js';
import { RegisterList, RegisterVersion } from './components/Register.js';
import { ReviewScreen } from './components/ReviewScreen.js';
import { SignIn } from './components/SignIn.js';
import { Loading, Spinner } from './components/Status.js';
import { UploadForm } from './components/UploadForm.js';
import { UsersAdmin } from './components/UsersAdmin.js';
import { ServicesContext } from './context.js';
import type { AppServices, Mode } from './context.js';
import type { PollOptions } from './lib/backoff.js';
import { createDemoAccess, inDemo } from './lib/demo.js';
import { hrefFor, parseRoute } from './lib/router.js';
import type { Route } from './lib/router.js';

export interface AppProps {
  readonly baseUrl: string;
  readonly storage: Storage;
  readonly queryClient: QueryClient;
  readonly poll?: PollOptions;
  readonly fetch?: typeof fetch;
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return route;
}

const NO_POLL_OPTIONS: PollOptions = {};
// A demo visitor acts as every role but admin, in their own sandbox only.
const VISITOR_ROLES: readonly UserRole[] = ['engineer', 'reviewer', 'approver'];
const NO_ROLES: readonly UserRole[] = [];

// Dialogs opened from the header belong to the screen they were opened on.
function useCloseOnRouteChange(route: Route, close: () => void) {
  const [shown, setShown] = useState(route);
  if (shown !== route) {
    setShown(route);
    close();
  }
}

// The screen a route belongs to in the navigation: a document's review is under Documents.
const section = (route: Route): Route['name'] =>
  route.name === 'review' || route.name === 'audit'
    ? 'documents'
    : route.name === 'register_version'
      ? 'register'
      : route.name;

const go = (route: Exclude<Route, { name: 'not_found' }>) => {
  window.location.hash = hrefFor(route);
};

// Three ways to use the app. Anyone can browse the read-only showcase. "Try it yourself" starts
// a private demo sandbox, no account needed. Signing in opens the real workspace, where what a
// person can do follows their roles. The server enforces all of it; the UI only hides what it
// would refuse.
export function App({ baseUrl, storage, queryClient, poll = NO_POLL_OPTIONS, fetch }: AppProps) {
  const route = useRoute();
  const send = useMemo(() => (fetch === undefined ? {} : { fetch }), [fetch]);
  const [demo] = useState(() => createDemoAccess({ baseUrl, storage, ...send }));
  const [inSandbox, setInSandbox] = useState(() => inDemo(storage));
  const [account, setAccount] = useState<MeBody | null>(null);
  const [checking, setChecking] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [publishing, setPublishing] = useState(false);
  useCloseOnRouteChange(route, () => {
    setPublishing(false);
  });

  const announce = useCallback((text: string) => {
    setMessage(text);
  }, []);
  const signedOut = useCallback(() => {
    setAccount(null);
  }, []);
  // The workspace client: the session cookie travels by itself, on the same origin.
  const workspace = useMemo(
    () => createApiClient({ baseUrl, onUnauthenticated: signedOut, ...send }),
    [baseUrl, send, signedOut],
  );

  // Wake the API as soon as the page opens: on the free plan it sleeps when idle, and waking it
  // takes up to a minute, so by the time a visitor chooses what to do it is already starting.
  // /health touches no database. The answer does not matter.
  useEffect(() => {
    void (fetch ?? globalThis.fetch)(`${baseUrl}/health`).catch(() => undefined);
  }, [baseUrl, fetch]);

  // Who is signed in, if anyone, when the app opens.
  useEffect(() => {
    let current = true;
    workspace
      .me()
      .then(
        (me) => {
          if (current) setAccount(me);
        },
        () => {
          if (current) setAccount(null);
        },
      )
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [workspace]);

  const mode: Mode = inSandbox ? 'demo' : account !== null ? 'account' : 'showcase';
  const roles: readonly UserRole[] =
    mode === 'demo'
      ? VISITOR_ROLES
      : mode === 'account'
        ? (account?.user.roles ?? NO_ROLES)
        : NO_ROLES;

  const services = useMemo<AppServices>(() => {
    const client =
      mode === 'demo'
        ? createApiClient({
            baseUrl: `${baseUrl}/demo`,
            bearer: () => demo.token(),
            demo: true,
            onUnauthenticated: () => {
              demo.forget();
            },
            ...send,
          })
        : mode === 'account'
          ? workspace
          : createApiClient({ baseUrl: `${baseUrl}/showcase`, ...send });
    return { client, poll, mode, can: (role) => roles.includes(role), announce };
  }, [mode, roles, baseUrl, demo, send, workspace, poll, announce]);

  const switchMode = () => {
    setPublishing(false);
    queryClient.clear();
  };
  const tryDemo = () => {
    setStarting(true);
    setStartError(null);
    demo.token().then(
      () => {
        setStarting(false);
        setInSandbox(true);
        switchMode();
        announce('Your demo sandbox is ready.');
        go({ name: 'documents' });
      },
      (error: unknown) => {
        setStarting(false);
        setStartError(error instanceof Error ? error.message : 'The demo could not be started.');
      },
    );
  };
  const leaveDemo = () => {
    demo.forget();
    setInSandbox(false);
    switchMode();
    announce('You left the demo sandbox.');
    go({ name: 'home' });
  };
  const signIn = (email: string, password: string) => {
    setSigningIn(true);
    setSignInError(null);
    workspace.login(email, password).then(
      (me) => {
        setSigningIn(false);
        demo.forget();
        setInSandbox(false);
        setAccount(me);
        switchMode();
        announce(`Signed in as ${me.user.displayName}.`);
        go({ name: 'documents' });
      },
      (error: unknown) => {
        setSigningIn(false);
        setSignInError(error);
      },
    );
  };
  const signOut = () => {
    void workspace
      .logout()
      .catch(() => undefined)
      .finally(() => {
        setAccount(null);
        switchMode();
        announce('You signed out.');
        go({ name: 'home' });
      });
  };

  const current = section(route);
  const nav: { route: Exclude<Route, { name: 'not_found' }>; label: string }[] = [
    { route: { name: 'home' }, label: 'Overview' },
    { route: { name: 'documents' }, label: 'Documents' },
    { route: { name: 'conflicts' }, label: 'Conflicts' },
    { route: { name: 'register' }, label: 'Register' },
    ...(mode === 'account' && roles.includes('engineer')
      ? [{ route: { name: 'upload' } as const, label: 'Upload' }]
      : []),
    ...(mode === 'account' && roles.includes('admin')
      ? [{ route: { name: 'users' } as const, label: 'Users' }]
      : []),
  ];
  const workspaceRoute = route.name !== 'home' && route.name !== 'sign_in';

  return (
    <QueryClientProvider client={queryClient}>
      <ServicesContext.Provider value={services}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-40 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:shadow"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <a
              href={hrefFor({ name: 'home' })}
              className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              <Logo />
              <h1 className="text-lg font-bold tracking-tight max-[380px]:sr-only">SpecLedger</h1>
            </a>
            <nav
              aria-label="Main"
              className="order-3 -mx-1 w-full overflow-x-auto [scrollbar-width:none] md:order-none md:w-auto"
            >
              <ul className="flex gap-1 px-1">
                {nav.map((item) => {
                  const active = current === item.route.name;
                  return (
                    <li key={item.label}>
                      <a
                        href={hrefFor(item.route)}
                        aria-current={active ? 'page' : undefined}
                        className={`block rounded-lg px-2.5 py-1.5 text-sm font-medium whitespace-nowrap sm:px-3 focus-visible:outline-2 focus-visible:outline-brand-600 ${
                          active
                            ? 'bg-brand-50 text-brand-800'
                            : 'text-slate-700 hover:bg-slate-100 hover:text-ink'
                        }`}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {mode === 'demo' ? (
                <span
                  title="You are in your private demo sandbox"
                  className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-emerald-800 ring-1 ring-emerald-600/30 ring-inset"
                >
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                  <span>
                    Demo<span className="hidden sm:inline"> sandbox</span>
                  </span>
                </span>
              ) : null}
              {mode === 'account' && account !== null ? (
                <span
                  className="hidden text-sm text-slate-700 lg:inline"
                  title={account.user.email}
                >
                  {account.user.displayName}
                </span>
              ) : null}
              {roles.includes('approver') ? (
                <button
                  type="button"
                  onClick={() => {
                    setPublishing(true);
                  }}
                  aria-label={mode === 'demo' ? 'Publish register (simulated)' : 'Publish register'}
                  className="btn btn-primary max-sm:px-3 max-sm:py-1.5"
                >
                  <span>
                    Publish<span className="hidden sm:inline"> register</span>
                  </span>
                </button>
              ) : null}
              {mode === 'demo' ? (
                <button
                  type="button"
                  onClick={leaveDemo}
                  className="btn btn-secondary max-sm:px-3 max-sm:py-1.5"
                >
                  Leave demo
                </button>
              ) : mode === 'account' ? (
                <button
                  type="button"
                  onClick={signOut}
                  className="btn btn-secondary max-sm:px-3 max-sm:py-1.5"
                >
                  Sign out
                </button>
              ) : (
                <a
                  href={hrefFor({ name: 'sign_in' })}
                  className="btn btn-secondary max-sm:px-3 max-sm:py-1.5"
                >
                  Sign in
                </a>
              )}
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          {workspaceRoute && mode === 'showcase' && !checking ? (
            <div className="notice notice-info mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p>
                <strong className="font-semibold">Read-only showcase.</strong> Synthetic datasheets
                extracted by a real model. To review, resolve conflicts and publish, try it in a
                private sandbox; no account needed.
              </p>
              <button
                type="button"
                aria-disabled={starting}
                onClick={() => {
                  if (!starting) tryDemo();
                }}
                className="btn btn-primary self-start sm:self-auto"
              >
                {starting ? <Spinner /> : null}
                {starting ? 'Preparing your sandbox…' : 'Try it yourself'}
              </button>
            </div>
          ) : null}
          {workspaceRoute && mode === 'showcase' && startError !== null ? (
            <div role="alert" className="notice notice-error mb-6">
              {startError}
            </div>
          ) : null}
          {workspaceRoute && mode === 'demo' ? (
            <p className="notice notice-info mb-6">
              <strong className="font-semibold">Your private demo sandbox.</strong> Your changes are
              visible only to you and are deleted when the session ends. Publishing here is
              simulated: it creates a demo register version, not a real one.
            </p>
          ) : null}
          {route.name === 'home' ? (
            <Landing mode={mode} starting={starting} startError={startError} onTryDemo={tryDemo} />
          ) : route.name === 'sign_in' ? (
            account !== null ? (
              <section aria-labelledby="signed-in-heading" className="card mx-auto max-w-md p-8">
                <h2 id="signed-in-heading" className="page-title">
                  Signed in
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  You are signed in as {account.user.displayName} ({account.user.email}).
                </p>
                <a href={hrefFor({ name: 'documents' })} className="btn btn-primary mt-5">
                  Open the documents
                </a>
              </section>
            ) : (
              <SignIn onSignIn={signIn} busy={signingIn} error={signInError} />
            )
          ) : checking && !inSandbox ? (
            <Loading label="Loading" />
          ) : (
            <Screen route={route} mode={mode} roles={roles} />
          )}
          {publishing ? (
            <PublishDialog
              onClose={() => {
                setPublishing(false);
              }}
            />
          ) : null}
          {starting ? <StartingNotice /> : null}
          <div role="status" aria-live="polite" aria-label="Announcements" className="sr-only">
            {message}
          </div>
        </main>
      </ServicesContext.Provider>
    </QueryClientProvider>
  );
}

// Shown while a demo sandbox is being prepared. Normally that takes about a second; when the
// free server was asleep it takes up to a minute, so after a few seconds the card says why.
function StartingNotice() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSlow(true);
    }, 4_000);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <div
      role="status"
      aria-label="Preparing your sandbox"
      className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-md items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-xl sm:bottom-6"
    >
      <Spinner className="mt-0.5 h-5 w-5 shrink-0 text-brand-700" />
      <div>
        <p className="font-semibold">Preparing your private sandbox…</p>
        <p className="mt-0.5 text-slate-600">
          {slow
            ? 'The free server was asleep and is waking up. This can take up to a minute, once.'
            : 'Copying the showcase into a workspace of your own.'}
        </p>
      </div>
    </div>
  );
}

function Restricted({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <section aria-labelledby="restricted-heading" className="card mx-auto max-w-lg p-8 text-center">
      <h2 id="restricted-heading" className="page-title">
        {title}
      </h2>
      <p className="mt-2 text-sm text-slate-600">{text}</p>
      <a href={hrefFor({ name: 'sign_in' })} className="btn btn-primary mt-5">
        Sign in
      </a>
    </section>
  );
}

function Screen({
  route,
  mode,
  roles,
}: {
  readonly route: Exclude<Route, { name: 'home' | 'sign_in' }>;
  readonly mode: Mode;
  readonly roles: readonly UserRole[];
}) {
  switch (route.name) {
    case 'documents':
      return <DocumentList />;
    case 'review':
      return <ReviewScreen key={route.documentId} documentId={route.documentId} />;
    case 'conflicts':
      return <ConflictsPanel />;
    case 'register':
      return <RegisterList />;
    case 'register_version':
      return <RegisterVersion key={route.number} number={route.number} />;
    case 'upload':
      return mode === 'account' && roles.includes('engineer') ? (
        <UploadForm />
      ) : (
        <Restricted
          title="Upload a document"
          text="Uploading documents is for signed-in engineers of a workspace. The demo comes with its documents already extracted."
        />
      );
    case 'users':
      return mode === 'account' && roles.includes('admin') ? (
        <UsersAdmin />
      ) : (
        <Restricted title="Users" text="Managing users is for signed-in administrators." />
      );
    case 'audit':
      return <AuditView key={`${route.kind}:${route.id}`} kind={route.kind} id={route.id} />;
    case 'not_found':
      return (
        <section
          aria-labelledby="missing-heading"
          className="card mx-auto max-w-lg p-8 text-center"
        >
          <h2 id="missing-heading" className="page-title">
            Page not found
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            This link does not lead to a SpecLedger page.
          </p>
          <a href={hrefFor({ name: 'documents' })} className="btn btn-primary mt-5">
            Back to the documents
          </a>
        </section>
      );
  }
}
