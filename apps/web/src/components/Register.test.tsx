import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeApi } from '../../test/fake-api.js';
import { expectNoAxeViolations, renderApp } from '../../test/render.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the equipment register', () => {
  it('says what publishing needs before anything is published', async () => {
    fakeApi();
    renderApp({ hash: '#/register' });
    expect(await screen.findByText('Nothing has been published yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Register' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('lists published versions newest first and opens one with its equipment values', async () => {
    const state = fakeApi();
    state.published = 2;
    const { user, container } = renderApp({ hash: '#/register' });
    const links = await screen.findAllByRole('link', { name: /^Version \d$/ });
    expect(links.map((l) => l.textContent)).toEqual(['Version 2', 'Version 1']);
    await user.click(links[0] as HTMLElement);

    expect(await screen.findByRole('heading', { name: 'Register version 2' })).toBeTruthy();
    const item = screen.getByRole('heading', { name: 'P-106' }).closest('li') as HTMLElement;
    expect(within(item).getByText('rated_flow')).toBeTruthy();
    expect(within(item).getByText('1997 gpm')).toBeTruthy();
    await waitFor(async () => {
      await expectNoAxeViolations(container);
    });
  });

  it('previews the asset-system handoff and says that nothing is sent', async () => {
    const state = fakeApi();
    state.published = 1;
    const { user } = renderApp({ hash: '#/register/1' });
    const handoff = (
      await screen.findByRole('heading', {
        name: 'Asset-system handoff preview',
      })
    ).closest('section') as HTMLElement;
    expect(handoff.textContent).toMatch(/Nothing is sent/);
    expect(handoff.textContent).toMatch(/not the real Autodesk API/);
    await user.click(await within(handoff).findByText('POST /assets/upsert'));
    expect(within(handoff).getByText('Idempotency-Key: specledger:register:v1:P-106')).toBeTruthy();
    expect(handoff.textContent).toContain('"externalId": "specledger:P-106"');
  });

  it('downloads an export with the credentials of the current session', async () => {
    const state = fakeApi();
    state.published = 1;
    const created = vi.fn(() => 'blob:export');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { user } = renderApp({ hash: '#/register/1' });
    await user.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalled();
    });
    expect(state.requests).toContain('GET /register/versions/1/export');
    expect(created).toHaveBeenCalled();
  });

  it('is part of the read-only showcase', async () => {
    const state = fakeApi({ user: null });
    state.published = 1;
    renderApp({ hash: '#/register' });
    expect(await screen.findByRole('link', { name: 'Version 1' })).toBeTruthy();
    expect(state.requests).toContain('GET /showcase/register/versions');
  });

  it('links a fresh publish to its register version', async () => {
    const state = fakeApi();
    state.fields = state.fields.map((f) => ({ ...f, reviewStatus: 'accepted' as const }));
    state.conflicts = state.conflicts.map((c) => ({ ...c, status: 'resolved' as const }));
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await user.click(screen.getByRole('button', { name: 'Publish register' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish register' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish now' }));
    const link = await within(dialog).findByRole('link', { name: 'Open it in the register' });
    expect(link.getAttribute('href')).toBe('#/register/1');
  });
});
