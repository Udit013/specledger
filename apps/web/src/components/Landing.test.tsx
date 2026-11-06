import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEMO_STORAGE_KEY } from '../lib/demo.js';
import { announcements, expectNoAxeViolations, renderApp } from '../../test/render.js';
import { API, DEMO_TOKEN, fakeApi } from '../../test/fake-api.js';

describe('the overview', () => {
  it('explains SpecLedger and how a document becomes a published register', async () => {
    fakeApi();
    const { container } = renderApp({ tokens: null, hash: '#/' });
    expect(screen.getByRole('heading', { level: 2, name: /register you can trust/ })).toBeTruthy();
    const steps = within(
      screen.getByRole('heading', { name: /six steps/ }).closest('section') as HTMLElement,
    ).getAllByRole('heading', { level: 3 });
    expect(steps.map((h) => h.textContent)).toEqual([
      'Upload',
      'Extract',
      'Verify',
      'Reconcile',
      'Review',
      'Publish',
    ]);
    expect(screen.getByRole('button', { name: 'Explore the live demo' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await expectNoAxeViolations(container);
  });
});

describe('the demo workspace', () => {
  it('starts without any token, uses only the demo routes, and can be left', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    fakeApi({
      demo: {},
      onRequest: (request) => {
        seen.push({ url: request.url, auth: request.headers.get('authorization') });
      },
    });
    const { user } = renderApp({ tokens: null, hash: '#/' });
    await user.click(screen.getByRole('button', { name: 'Explore the live demo' }));

    expect(await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
    expect(window.location.hash).toBe('#/documents');
    expect(screen.getByTitle('You are in the demo workspace').textContent).toMatch(/Demo/);
    expect(announcements().textContent).toBe('The demo workspace is ready.');
    expect(seen[0]).toEqual({ url: `${API}/demo/session`, auth: null });
    expect(seen.slice(1).every((r) => r.url.startsWith(`${API}/demo/`))).toBe(true);
    expect(seen.slice(1).every((r) => r.auth === `Bearer ${DEMO_TOKEN}`)).toBe(true);
    // The session stays in this tab only, never in the URL or localStorage.
    expect(sessionStorage.getItem(DEMO_STORAGE_KEY)).toContain(DEMO_TOKEN);
    expect(localStorage.length).toBe(0);
    expect(window.location.href).not.toContain(DEMO_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Leave demo' }));
    expect(window.location.hash).toBe('#/');
    expect(sessionStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Explore the live demo' })).toBeTruthy();
  });

  it('can be started from a workspace page', async () => {
    fakeApi({ demo: {} });
    const { user } = renderApp({ tokens: null, hash: '#/documents' });
    expect(screen.getByRole('heading', { name: 'Choose how to explore' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Explore the live demo' }));
    expect(await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
  });

  it('says so when the server has no demo workspace', async () => {
    fakeApi({ demo: { sessionStatus: 404 } });
    const { user } = renderApp({ tokens: null, hash: '#/' });
    await user.click(screen.getByRole('button', { name: 'Explore the live demo' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not enabled/);
    expect(window.location.hash).toBe('#/');
  });

  it('starts a new session when the server no longer accepts the stored one', async () => {
    fakeApi({ demo: {} });
    sessionStorage.setItem(
      DEMO_STORAGE_KEY,
      JSON.stringify({
        token: 'demo.revoked',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const { user } = renderApp({ tokens: null, hash: '#/documents' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/demo session ended/);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
    });
  });
});
