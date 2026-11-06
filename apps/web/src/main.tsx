import './styles.css';

import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

// The API is always reached on the page's own origin, under /api: the Vite dev server proxies it
// locally and Vercel rewrites it to the API in production. Same origin is what lets the session
// live in an HttpOnly, SameSite=Strict cookie.
const baseUrl = '/api';
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(root).render(
  <StrictMode>
    <App baseUrl={baseUrl} storage={sessionStorage} queryClient={queryClient} />
  </StrictMode>,
);
