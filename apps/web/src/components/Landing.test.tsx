import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEMO_STORAGE_KEY } from '../lib/demo.js';
import { announcements, expectNoAxeViolations, renderApp } from '../../test/render.js';
import { API, DEMO_TOKEN, fakeApi, PASSWORD, USERS } from '../../test/fake-api.js';

describe('the overview', () => {
  it('explains SpecLedger and how a document becomes a published register', async () => {
    fakeApi({ user: null });
    const { container } = renderApp({ hash: '#/' });
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
    expect(screen.getByRole('button', { name: 'Try it yourself' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse the showcase' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await expectNoAxeViolations(container);
  });
});

describe('the demo sandbox', () => {
  it('starts without an account, uses only the demo routes, and can be left', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    fakeApi({
      user: null,
      onRequest: (request) => {
        seen.push({ url: request.url, auth: request.headers.get('authorization') });
      },
    });
    const { user } = renderApp({ hash: '#/' });
    await user.click(screen.getByRole('button', { name: 'Try it yourself' }));

    expect(await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
    expect(window.location.hash).toBe('#/documents');
    expect(screen.getByTitle('You are in your private demo sandbox').textContent).toMatch(/Demo/);
    expect(screen.getByText('Your private demo sandbox.')).toBeTruthy();
    expect(announcements().textContent).toBe('Your demo sandbox is ready.');
    const afterStart = seen.slice(seen.findIndex((r) => r.url === `${API}/demo/session`) + 1);
    expect(afterStart.length).toBeGreaterThan(0);
    expect(afterStart.every((r) => r.url.startsWith(`${API}/demo/`))).toBe(true);
    expect(afterStart.every((r) => r.auth === `Bearer ${DEMO_TOKEN}`)).toBe(true);
    // The session stays in this tab only, never in the URL or localStorage.
    expect(sessionStorage.getItem(DEMO_STORAGE_KEY)).toContain(DEMO_TOKEN);
    expect(localStorage.length).toBe(0);
    expect(window.location.href).not.toContain(DEMO_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Leave demo' }));
    expect(window.location.hash).toBe('#/');
    expect(sessionStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
  });

  it('labels publishing in the sandbox as simulated', async () => {
    fakeApi({ user: null });
    const { user } = renderApp({ demo: true });
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await user.click(screen.getByRole('button', { name: 'Publish register (simulated)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish register (simulated)' });
    expect(dialog.textContent).toMatch(/not a real register/);
  });

  it('can be started from the showcase banner', async () => {
    fakeApi({ user: null });
    const { user } = renderApp({ hash: '#/documents' });
    await user.click(await screen.findByRole('button', { name: 'Try it yourself' }));
    expect(await screen.findByText('Your private demo sandbox.')).toBeTruthy();
  });

  it.each([
    [404, /not enabled/],
    [503, /being prepared/],
  ])('explains a %i when starting', async (status, message) => {
    fakeApi({ user: null, demoSessionStatus: status });
    const { user } = renderApp({ hash: '#/' });
    await user.click(screen.getByRole('button', { name: 'Try it yourself' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
    expect(window.location.hash).toBe('#/');
  });

  it('starts a new session when the server no longer accepts the stored one', async () => {
    fakeApi({ user: null });
    sessionStorage.setItem(
      DEMO_STORAGE_KEY,
      JSON.stringify({
        token: 'demo.revoked',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const { user } = renderApp({ hash: '#/documents' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/demo session ended/);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
    });
  });
});

describe('signing in', () => {
  it('signs in with email and password and signs out again', async () => {
    const state = fakeApi({ user: null });
    const { user, container } = renderApp({ hash: '#/sign-in' });
    await expectNoAxeViolations(container);
    await user.type(screen.getByLabelText('Email'), USERS[0]?.email ?? '');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
    expect(announcements().textContent).toBe('Signed in as Ada Lovelace.');
    expect(screen.queryByText('Read-only showcase.')).toBeNull();
    expect(screen.getByRole('link', { name: 'Users' })).toBeTruthy();
    // The password went to the API once and is kept nowhere in the page's storage.
    expect(sessionStorage.length + localStorage.length).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/');
    });
    expect(state.user).toBeNull();
  });

  it('says when the password is wrong', async () => {
    fakeApi({ user: null });
    const { user } = renderApp({ hash: '#/sign-in' });
    await user.type(screen.getByLabelText('Email'), USERS[0]?.email ?? '');
    await user.type(screen.getByLabelText('Password'), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/incorrect/);
  });
});

describe('user administration', () => {
  it('lets an admin add a user and change roles', async () => {
    const state = fakeApi();
    const { user, container } = renderApp({ hash: '#/users' });
    await screen.findByRole('button', { name: 'Disable ada@example.com' });
    await user.type(screen.getByLabelText('Email'), 'grace@example.com');
    await user.type(screen.getByLabelText('Name'), 'Grace Hopper');
    await user.type(screen.getByLabelText('Initial password'), 'a long enough password');
    await user.click(screen.getByRole('checkbox', { name: /^reviewer —/ }));
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    expect(await screen.findByRole('button', { name: 'Disable grace@example.com' })).toBeTruthy();
    expect(state.users.find((u) => u.email === 'grace@example.com')?.roles).toEqual([
      'engineer',
      'reviewer',
    ]);
    await user.click(screen.getByRole('button', { name: 'Disable grace@example.com' }));
    await waitFor(() => {
      expect(state.users.find((u) => u.email === 'grace@example.com')?.disabled).toBe(true);
    });
    await expectNoAxeViolations(container);
  });

  it('is not offered to other roles', async () => {
    fakeApi({ user: ['reviewer'] });
    renderApp({ hash: '#/users' });
    expect(await screen.findByText(/for signed-in administrators/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
  });
});
