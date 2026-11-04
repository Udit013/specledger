import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { expect } from 'vitest';

import { App } from '../src/App.js';
import type { PollOptions } from '../src/lib/backoff.js';
import { saveTokens } from '../src/lib/tokens.js';
import type { Tokens } from '../src/lib/tokens.js';
import { API, TOKENS } from './fake-api.js';

export function renderApp(
  options: { tokens?: Tokens | null; hash?: string; poll?: PollOptions } = {},
) {
  const tokens = options.tokens === undefined ? TOKENS : options.tokens;
  if (tokens !== null) saveTokens(sessionStorage, tokens);
  window.location.hash = options.hash ?? '';
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const user = userEvent.setup();
  const view = render(
    <App
      baseUrl={API}
      storage={sessionStorage}
      queryClient={queryClient}
      poll={options.poll ?? { baseMs: 20, maxMs: 80 }}
    />,
  );
  return { user, ...view };
}

export const announcements = () => screen.getByRole('status', { name: 'Announcements' });

// Presses Tab until the element with this accessible name has focus, as a keyboard user would.
export async function tabTo(
  user: ReturnType<typeof userEvent.setup>,
  role: Parameters<typeof screen.getByRole>[0],
  name: string | RegExp,
  limit = 60,
) {
  const target = await screen.findByRole(role, { name });
  for (let i = 0; i < limit && document.activeElement !== target; i += 1) await user.tab();
  expect(document.activeElement).toBe(target);
  return target;
}

// axe in jsdom: there is no layout, so color contrast cannot be computed and is checked by hand.
export async function expectNoAxeViolations(container: Element) {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}
