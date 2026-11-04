import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DOC_ID, fakeApi, FIELD_IDS, HOSTILE_PAGE } from '../../test/fake-api.js';
import { announcements, expectNoAxeViolations, renderApp } from '../../test/render.js';

const REVIEW = `#/documents/${DOC_ID}`;

const fieldButton = (name: string) =>
  screen.findByRole('button', { name: new RegExp(`^${name} `) });
const current = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Fields"] [aria-current="true"]');

describe('review screen', () => {
  it('shows the fields beside the source page with the selected quote highlighted', async () => {
    fakeApi();
    renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    const page = await screen.findByRole('region', { name: 'Source page 1' });
    const mark = await within(page).findByText('Rated flow: 1997 gpm', { selector: 'mark' });
    expect(mark.getAttribute('data-current')).toBe('true');
  });

  it('highlights a quote that differs from the page only in whitespace', async () => {
    fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await user.keyboard('j');
    const page = await screen.findByRole('region', { name: 'Source page 1' });
    await waitFor(() => {
      const mark = page.querySelector('mark[data-current="true"]');
      expect(mark?.textContent).toBe('Rated   head:\n260 ft');
    });
  });

  it('says so visibly when the quote cannot be located', async () => {
    fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await user.keyboard('jj');
    expect(await screen.findByText('The quote could not be located on this page.')).toBeTruthy();
    const page = screen.getByRole('region', { name: 'Source page 1' });
    expect(page.querySelector('mark[data-current="true"]')).toBeNull();
  });

  it('moves with j and k, accepts with a, and announces the result in text', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await user.keyboard('j');
    await waitFor(() => {
      expect(current()?.textContent).toMatch(/rated_head/);
    });
    await user.keyboard('k');
    await waitFor(() => {
      expect(current()?.textContent).toMatch(/rated_flow/);
    });
    await user.keyboard('a');
    await waitFor(() => {
      expect(announcements().textContent).toBe('rated_flow accepted.');
    });
    expect(state.fields.find((f) => f.id === FIELD_IDS.flow)?.reviewStatus).toBe('accepted');
    // Status is text, not only color; selection and focus move on to the next field.
    expect((await fieldButton('rated_flow')).textContent).toMatch(/Accepted/);
    await waitFor(() => {
      expect(document.activeElement).toBe(current());
      expect(current()?.textContent).toMatch(/rated_head/);
    });
  });

  it('edits with e, keeps shortcuts off while typing, and saves with Enter', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await user.keyboard('je');
    const value = await screen.findByLabelText('Value');
    expect(document.activeElement).toBe(value);
    // "r", "a" and "j" typed here are text, not shortcuts.
    await user.clear(value);
    await user.type(value, '296');
    await user.type(screen.getByLabelText('Reason (optional)'), 'rejaj erratum');
    expect(state.fields.find((f) => f.id === FIELD_IDS.head)?.reviewStatus).toBe('pending');
    await user.type(screen.getByLabelText('Unit'), '{Enter}');
    await waitFor(() => {
      expect(announcements().textContent).toBe('rated_head edited.');
    });
    expect(state.fields.find((f) => f.id === FIELD_IDS.head)).toMatchObject({
      reviewStatus: 'edited',
      value: '296',
      unit: 'ft',
    });
  });

  it('closes the edit form with Escape and returns focus to the field', async () => {
    fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await user.keyboard('e');
    await screen.findByLabelText('Value');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByLabelText('Value')).toBeNull();
      expect(document.activeElement).toBe(current());
    });
  });

  it('rejects with r', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await user.keyboard('r');
    await waitFor(() => {
      expect(announcements().textContent).toBe('rated_flow rejected.');
    });
    expect(state.fields.find((f) => f.id === FIELD_IDS.flow)?.reviewStatus).toBe('rejected');
  });

  it('asks for a reason before accepting an unverified value', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await user.keyboard('jja');
    const reason = await screen.findByLabelText('Reason for accepting an unverified value');
    expect(document.activeElement).toBe(reason);
    await user.type(reason, 'checked with the vendor{Enter}');
    await waitFor(() => {
      expect(announcements().textContent).toBe('rated_power accepted.');
    });
    expect(state.fields.find((f) => f.id === FIELD_IDS.power)?.reviewStatus).toBe('accepted');
  });

  it('on 409 shows the server value, keeps the reviewer input, and reapplies on request', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    // Someone else accepts rated_head after this screen loaded it.
    const head = state.fields.findIndex((f) => f.id === FIELD_IDS.head);
    const before = state.fields[head];
    if (before === undefined) throw new Error('fixture');
    state.fields[head] = { ...before, reviewStatus: 'accepted', value: '255', version: 2 };

    await user.keyboard('je');
    const value = await screen.findByLabelText('Value');
    await user.clear(value);
    await user.type(value, '296{Enter}');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/This field changed on the server/)).toBeTruthy();
    expect(alert.textContent).toMatch(/255 ft/);
    expect(alert.textContent).toMatch(/Accepted/);
    expect(alert.textContent).toMatch(/296 ft/);
    // Nothing was overwritten.
    expect(state.fields.find((f) => f.id === FIELD_IDS.head)?.value).toBe('255');

    await user.click(within(alert).getByRole('button', { name: 'Reapply my change' }));
    await waitFor(() => {
      expect(state.fields[head]).toMatchObject({
        reviewStatus: 'edited',
        value: '296',
        version: 3,
      });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('on 409 can discard the reviewer input and show the server state', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    const flow = state.fields.findIndex((f) => f.id === FIELD_IDS.flow);
    const before = state.fields[flow];
    if (before === undefined) throw new Error('fixture');
    state.fields[flow] = { ...before, reviewStatus: 'rejected', version: 2 };
    await user.keyboard('a');
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Discard my change' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect((await fieldButton('rated_flow')).textContent).toMatch(/Rejected/);
    expect(state.fields.find((f) => f.id === FIELD_IDS.flow)?.version).toBe(2);
  });

  it('opens help with ? and closes it with Escape, restoring focus', async () => {
    fakeApi();
    const { user } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    const before = document.activeElement;
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.textContent).toMatch(/Accept/);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(before);
  });

  it('displays hostile page text literally and creates no HTML from it', async () => {
    fakeApi({ page: HOSTILE_PAGE });
    renderApp({ hash: REVIEW });
    const page = await screen.findByRole('region', { name: 'Source page 1' });
    await waitFor(() => {
      expect(page.textContent).toContain('<script>window.__pwned=2</script>');
    });
    expect(page.querySelector('img, script, b')).toBeNull();
    expect(document.querySelector('img, script')).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('has no accessibility violations', async () => {
    fakeApi();
    const { container } = renderApp({ hash: REVIEW });
    await fieldButton('rated_flow');
    await screen.findByRole('region', { name: 'Source page 1' });
    await expectNoAxeViolations(container);
  });
});
