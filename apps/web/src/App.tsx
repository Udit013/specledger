import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createApiClient } from './api/client.js';
import { AuditView } from './components/AuditView.js';
import { ConflictsPanel } from './components/ConflictsPanel.js';
import { Dialog } from './components/Dialog.js';
import { DocumentList } from './components/DocumentList.js';
import { Logo } from './components/Icons.js';
import { Landing } from './components/Landing.js';
import type { Access } from './components/Landing.js';
import { PublishDialog } from './components/PublishDialog.js';
import { ReviewScreen } from './components/ReviewScreen.js';
import { TokenForm } from './components/TokenForm.js';
import { UploadForm } from './components/UploadForm.js';
import { ServicesContext } from './context.js';
import type { AppServices } from './context.js';
import type { PollOptions } from './lib/backoff.js';
import { createDemoAccess, inDemo } from './lib/demo.js';
import { hrefFor, parseRoute } from './lib/router.js';
import type { Route } from './lib/router.js';
import { clearTokens, createTokenHolder, loadTokens, NO_TOKENS, saveTokens } from './lib/tokens.js';
import type { Tokens } from './lib/tokens.js';

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

// Dialogs opened from the header belong to the screen they were opened on.
function useCloseOnRouteChange(route: Route, close: () => void) {
  const [shown, setShown] = useState(route);
  if (shown !== route) {
    setShown(route);
    close();
  }
}

const hasAny = (tokens: Tokens) => tokens.engineer !== null || tokens.approver !== null;

const NAV = [
  { route: { name: 'home' }, label: 'Overview' },
  { route: { name: 'documents' }, label: 'Documents' },
  { route: { name: 'conflicts' }, label: 'Conflicts' },
  { route: { name: 'upload' }, label: 'Upload' },
] as const;

// The screen a route belongs to in the navigation: a document's review is under Documents.
const section = (route: Route): Route['name'] =>
  route.name === 'review' || route.name === 'audit' ? 'documents' : route.name;

// Three ways to use the app: not yet (the overview only), the demo workspace (a visitor session
// the server issues; no tokens to paste, its own database), or the operator's role tokens on the
// real workspace. The demo is entered from the overview and left from the header.
export function App({ baseUrl, storage, queryClient, poll = NO_POLL_OPTIONS, fetch }: AppProps) {
  const route = useRoute();
  const [tokens, setTokens] = useState<Tokens>(() => loadTokens(storage));
  // Updated together with the state, in the handlers below.
  const [held] = useState(() => createTokenHolder(tokens));
  const [demo] = useState(() =>
    createDemoAccess({ baseUrl, storage, ...(fetch === undefined ? {} : { fetch }) }),
  );
  const [access, setAccess] = useState<Access>(() =>
    inDemo(storage) ? 'demo' : hasAny(tokens) ? 'tokens' : 'none',
  );
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState<'publish' | 'tokens' | null>(null);
  useCloseOnRouteChange(route, () => {
    setDialog(null);
  });

  const announce = useCallback((text: string) => {
    setMessage(text);
  }, []);
  const services = useMemo<AppServices>(() => {
    const send = fetch === undefined ? {} : { fetch };
    const client =
      access === 'demo'
        ? createApiClient({
            baseUrl: `${baseUrl}/demo`,
            tokens: async () => {
              const token = await demo.token();
              return { engineer: token, approver: token };
            },
            demo: {
              onUnauthenticated: () => {
                demo.forget();
              },
            },
            ...send,
          })
        : createApiClient({ baseUrl, tokens: held.get, ...send });
    return { client, poll, announce };
  }, [access, baseUrl, demo, fetch, held, poll, announce]);

  const switchTo = (next: Access) => {
    setAccess(next);
    setDialog(null);
    queryClient.clear();
  };
  const startDemo = () => {
    setStarting(true);
    setStartError(null);
    demo.token().then(
      () => {
        setStarting(false);
        switchTo('demo');
        announce('The demo workspace is ready.');
        window.location.hash = hrefFor({ name: 'documents' });
      },
      (error: unknown) => {
        setStarting(false);
        setStartError(error instanceof Error ? error.message : 'The demo could not be started.');
      },
    );
  };
  const leaveDemo = () => {
    demo.forget();
    switchTo(hasAny(tokens) ? 'tokens' : 'none');
    announce('You left the demo workspace.');
    window.location.hash = hrefFor({ name: 'home' });
  };
  const updateTokens = (next: Tokens) => {
    saveTokens(storage, next);
    held.set(next);
    setTokens(next);
    demo.forget();
    switchTo(hasAny(next) ? 'tokens' : 'none');
  };
  const forgetTokens = () => {
    clearTokens(storage);
    held.set(NO_TOKENS);
    setTokens(NO_TOKENS);
    switchTo(access === 'demo' ? 'demo' : 'none');
  };
  const openTokens = () => {
    setDialog('tokens');
  };

  const current = section(route);
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
                {NAV.map((item) => {
                  const active = current === item.route.name;
                  return (
                    <li key={item.label}>
                      <a
                        href={hrefFor(item.route)}
                        aria-current={active ? 'page' : undefined}
                        className={`block rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-brand-600 ${
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
              {access === 'demo' ? (
                <span
                  title="You are in the demo workspace"
                  className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-emerald-800 ring-1 ring-emerald-600/30 ring-inset"
                >
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                  <span>
                    Demo<span className="hidden sm:inline"> workspace</span>
                  </span>
                </span>
              ) : null}
              {access === 'none' ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setDialog('publish');
                  }}
                  aria-label="Publish register"
                  className="btn btn-primary max-sm:px-3 max-sm:py-1.5"
                >
                  <span>
                    Publish<span className="hidden sm:inline"> register</span>
                  </span>
                </button>
              )}
              {access === 'demo' ? (
                <button
                  type="button"
                  onClick={leaveDemo}
                  className="btn btn-secondary max-sm:px-3 max-sm:py-1.5"
                >
                  Leave demo
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openTokens}
                  className="btn btn-secondary max-sm:px-3 max-sm:py-1.5"
                >
                  API tokens
                </button>
              )}
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          {route.name === 'home' ? (
            <Landing
              access={access}
              starting={starting}
              startError={startError}
              onStartDemo={startDemo}
              onUseTokens={openTokens}
            />
          ) : access === 'none' ? (
            <AccessPanel
              tokens={tokens}
              starting={starting}
              startError={startError}
              onStartDemo={startDemo}
              onSave={updateTokens}
              onForget={forgetTokens}
            />
          ) : (
            <Screen route={route} />
          )}
          {dialog === 'publish' ? (
            <PublishDialog
              onClose={() => {
                setDialog(null);
              }}
            />
          ) : null}
          {dialog === 'tokens' ? (
            <Dialog
              title="API tokens"
              onClose={() => {
                setDialog(null);
              }}
            >
              <TokenForm tokens={tokens} onSave={updateTokens} onForget={forgetTokens} />
            </Dialog>
          ) : null}
          <div role="status" aria-live="polite" aria-label="Announcements" className="sr-only">
            {message}
          </div>
        </main>
      </ServicesContext.Provider>
    </QueryClientProvider>
  );
}

// Shown on a workspace screen before the visitor has chosen how to explore.
function AccessPanel({
  tokens,
  starting,
  startError,
  onStartDemo,
  onSave,
  onForget,
}: {
  readonly tokens: Tokens;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly onStartDemo: () => void;
  readonly onSave: (tokens: Tokens) => void;
  readonly onForget: () => void;
}) {
  return (
    <section aria-labelledby="access-heading" className="mx-auto max-w-3xl">
      <h2 id="access-heading" className="page-title">
        Choose how to explore
      </h2>
      <p className="page-lead">
        Try SpecLedger in the demo workspace, or use the API tokens your operator gave you.
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="card flex flex-col p-6">
          <h3 className="text-lg font-semibold">Demo workspace</h3>
          <p className="mt-2 flex-1 text-sm text-slate-600">
            A separate workspace with synthetic datasheets. Review, resolve and publish as both
            roles; nothing reaches real data.
          </p>
          <button
            type="button"
            aria-disabled={starting}
            onClick={() => {
              if (!starting) onStartDemo();
            }}
            className="btn btn-primary mt-5 self-start"
          >
            {starting ? 'Starting the demo…' : 'Explore the live demo'}
          </button>
          {startError === null ? null : (
            <div role="alert" className="notice notice-error mt-3">
              {startError}
            </div>
          )}
        </div>
        <div className="card p-6">
          <h3 className="mb-3 text-lg font-semibold">API tokens</h3>
          <TokenForm tokens={tokens} onSave={onSave} onForget={onForget} />
        </div>
      </div>
    </section>
  );
}

function Screen({ route }: { readonly route: Exclude<Route, { name: 'home' }> }) {
  switch (route.name) {
    case 'documents':
      return <DocumentList />;
    case 'review':
      return <ReviewScreen key={route.documentId} documentId={route.documentId} />;
    case 'conflicts':
      return <ConflictsPanel />;
    case 'upload':
      return <UploadForm />;
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
