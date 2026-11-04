import { screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { API, document, fakeApi, server } from '../../test/fake-api.js';
import { expectNoAxeViolations, renderApp } from '../../test/render.js';
import { DOCUMENT_PAGE_SIZE } from '../api/client.js';

describe('document list', () => {
  it('shows a loading state, then the documents with their processing status as text', async () => {
    fakeApi();
    server.use(
      http.get(`${API}/documents`, async () => {
        await delay(50);
        return HttpResponse.json({ documents: [document()] });
      }),
    );
    renderApp();
    expect(await screen.findByRole('status', { name: 'Loading documents' })).toBeTruthy();
    const row = (await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' })).closest(
      'tr',
    );
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Succeeded')).toBeTruthy();
  });

  it('says so when the list is cut at the page size, instead of hiding older documents', async () => {
    const many = Array.from({ length: DOCUMENT_PAGE_SIZE }, (_, i) =>
      document({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        originalFilename: `doc-${String(i)}.pdf`,
      }),
    );
    fakeApi({ documents: many });
    renderApp();
    expect(
      await screen.findByText(
        `Showing the newest ${String(DOCUMENT_PAGE_SIZE)} documents. Older ones are not listed here.`,
      ),
    ).toBeTruthy();
  });

  it('does not show the notice for a shorter list', async () => {
    fakeApi();
    renderApp();
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    expect(screen.queryByText(/Older ones are not listed/)).toBeNull();
  });

  it('shows an empty state', async () => {
    fakeApi({ documents: [] });
    renderApp();
    expect(await screen.findByText(/No documents yet/)).toBeTruthy();
  });

  it('shows an error with a retry, and recovers', async () => {
    let fail = true;
    fakeApi();
    server.use(
      http.get(`${API}/documents`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: 'INTERNAL', message: 'An unexpected error occurred.' } },
              { status: 500 },
            )
          : HttpResponse.json({ documents: [document()] }),
      ),
    );
    const { user } = renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not be loaded/i);
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
  });

  it('polls while a document is processing, then stops once it settles', async () => {
    let calls = 0;
    fakeApi();
    server.use(
      http.get(`${API}/documents`, () => {
        calls += 1;
        const status = calls < 3 ? 'running' : 'succeeded';
        return HttpResponse.json({
          documents: [
            document({ processing: { status, jobId: null, attempts: 1, lastErrorCode: null } }),
          ],
        });
      }),
    );
    renderApp({ poll: { baseMs: 10, maxMs: 20 } });
    expect(await screen.findByText('Running')).toBeTruthy();
    expect(await screen.findByText('Succeeded', {}, { timeout: 2_000 })).toBeTruthy();
    const settled = calls;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toBe(settled);
  });

  it('asks for tokens when none are stored, and keeps them out of the URL', async () => {
    fakeApi();
    const { user } = renderApp({ tokens: null });
    await user.type(
      await screen.findByLabelText('Engineer token'),
      'engineer-token-0123456789abcdef',
    );
    await user.click(screen.getByRole('button', { name: 'Save tokens' }));
    expect(await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' })).toBeTruthy();
    expect(window.location.href).not.toContain('engineer-token');
    expect(localStorage.length).toBe(0);
  });

  it('explains a rejected token', async () => {
    fakeApi();
    renderApp({ tokens: { engineer: 'wrong-token-wrong-token-wrong-token', approver: null } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/token/i);
  });

  it('has no accessibility violations', async () => {
    fakeApi();
    const { container } = renderApp();
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await waitFor(async () => {
      await expectNoAxeViolations(container);
    });
  });
});
