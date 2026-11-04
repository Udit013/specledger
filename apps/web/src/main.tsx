import './styles.css';

import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

// The API is reached through the dev server's /api proxy unless VITE_API_URL names it.
const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(root).render(
  <StrictMode>
    <App baseUrl={baseUrl} storage={sessionStorage} queryClient={queryClient} />
  </StrictMode>,
);
