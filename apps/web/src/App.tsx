import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createApiClient } from './api/client.js';
import { AuditView } from './components/AuditView.js';
import { ConflictsPanel } from './components/ConflictsPanel.js';
import { Dialog } from './components/Dialog.js';
import { DocumentList } from './components/DocumentList.js';
import { PublishDialog } from './components/PublishDialog.js';
import { ReviewScreen } from './components/ReviewScreen.js';
import { TokenForm } from './components/TokenForm.js';
import { ServicesContext } from './context.js';
import type { AppServices } from './context.js';
import type { PollOptions } from './lib/backoff.js';
import { hrefFor, parseRoute } from './lib/router.js';
import type { Route } from './lib/router.js';
import { clearTokens, createTokenHolder, loadTokens, NO_TOKENS, saveTokens } from './lib/tokens.js';
import type { Tokens } from './lib/tokens.js';

export interface AppProps {
  readonly baseUrl: string;
  readonly storage: Storage;
  readonly queryClient: QueryClient;
  readonly poll?: PollOptions;
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

export function App({ baseUrl, storage, queryClient, poll = NO_POLL_OPTIONS }: AppProps) {
  const route = useRoute();
  const [tokens, setTokens] = useState<Tokens>(() => loadTokens(storage));
  // Updated together with the state, in the handlers below.
  const [held] = useState(() => createTokenHolder(tokens));
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState<'publish' | 'tokens' | null>(null);
  useCloseOnRouteChange(route, () => {
    setDialog(null);
  });

  const announce = useCallback((text: string) => {
    setMessage(text);
  }, []);
  const services = useMemo<AppServices>(
    () => ({
      client: createApiClient({ baseUrl, tokens: held.get }),
      poll,
      announce,
    }),
    [baseUrl, poll, announce, held],
  );

  const updateTokens = (next: Tokens) => {
    saveTokens(storage, next);
    held.set(next);
    setTokens(next);
    setDialog(null);
    queryClient.clear();
  };
  const forgetTokens = () => {
    clearTokens(storage);
    held.set(NO_TOKENS);
    setTokens(NO_TOKENS);
    setDialog(null);
    queryClient.clear();
  };
  const hasTokens = tokens.engineer !== null || tokens.approver !== null;

  return (
    <QueryClientProvider client={queryClient}>
      <ServicesContext.Provider value={services}>
        <a href="#main" className="sr-only focus:not-sr-only">
          Skip to content
        </a>
        <header className="border-b bg-white px-4 py-2">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4">
            <h1 className="text-lg font-bold">SpecLedger review</h1>
            <nav aria-label="Main" className="flex gap-3 text-sm">
              <a href={hrefFor({ name: 'documents' })} className="text-blue-800 underline">
                Documents
              </a>
              <a href={hrefFor({ name: 'conflicts' })} className="text-blue-800 underline">
                Conflicts
              </a>
            </nav>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setDialog('publish');
                }}
                className="rounded border border-slate-700 px-3 py-1 text-sm font-medium"
              >
                Publish register
              </button>
              <button
                type="button"
                onClick={() => {
                  setDialog('tokens');
                }}
                className="rounded border px-3 py-1 text-sm"
              >
                API tokens
              </button>
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-7xl p-4">
          {hasTokens ? (
            <Screen route={route} />
          ) : (
            <section aria-labelledby="tokens-heading">
              <h2 id="tokens-heading" className="mb-3 text-xl font-semibold">
                API tokens
              </h2>
              <TokenForm tokens={tokens} onSave={updateTokens} onForget={forgetTokens} />
            </section>
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

function Screen({ route }: { readonly route: Route }) {
  switch (route.name) {
    case 'documents':
      return <DocumentList />;
    case 'review':
      return <ReviewScreen key={route.documentId} documentId={route.documentId} />;
    case 'conflicts':
      return <ConflictsPanel />;
    case 'audit':
      return <AuditView key={`${route.kind}:${route.id}`} kind={route.kind} id={route.id} />;
    case 'not_found':
      return (
        <section aria-labelledby="missing-heading">
          <h2 id="missing-heading" className="text-xl font-semibold">
            Page not found
          </h2>
          <a href={hrefFor({ name: 'documents' })} className="text-blue-800 underline">
            Back to the documents
          </a>
        </section>
      );
  }
}
