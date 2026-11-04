import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { http, HttpResponse } from 'msw';

import {
  API,
  CONFLICT_ID,
  DOC_ID,
  fakeApi,
  FIELD_IDS,
  server,
  TOKENS,
} from '../../test/fake-api.js';
import { announcements, expectNoAxeViolations, renderApp, tabTo } from '../../test/render.js';

describe('conflicts panel', () => {
  it('shows both candidates with their evidence and the rule suggestion', async () => {
    fakeApi();
    renderApp({ hash: '#/conflicts' });
    const section = await screen.findByRole('region', { name: 'P-106 rated_head' });
    const radios = within(section).getAllByRole('radio');
    expect(
      radios.map(
        (r) => r.getAttribute('aria-label') ?? (r as HTMLInputElement).labels?.[0]?.textContent,
      ),
    ).toEqual([
      expect.stringMatching(/260 ft/),
      expect.stringMatching(/250 ft/),
      expect.stringMatching(/Enter another value/),
    ]);
    expect(section.textContent).toContain('Rated head: 260 ft');
    expect(section.textContent).toContain('Rated head 250 ft');
    expect(section.textContent).toMatch(/page 2/);
    expect(section.textContent).toMatch(/The rules cannot choose/);
  });

  it('marks the candidate the rules would choose', async () => {
    const state = fakeApi();
    const conflict = state.conflicts[0];
    if (conflict === undefined) throw new Error('fixture');
    state.conflicts[0] = {
      ...conflict,
      suggestion: { fieldId: FIELD_IDS.head, rules: ['LATER_REVISION', 'ONLY_CANDIDATE'] },
    };
    renderApp({ hash: '#/conflicts' });
    const section = await screen.findByRole('region', { name: 'P-106 rated_head' });
    expect(section.textContent).toMatch(/The rules would choose 260 ft/);
    expect(section.textContent).toMatch(/later revision/i);
    expect(within(section).getByText('Suggested by the rules')).toBeTruthy();
  });

  it('requires a reason, then resolves by keyboard and announces it', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: '#/conflicts' });
    await screen.findByRole('region', { name: 'P-106 rated_head' });
    const first = await tabTo(user, 'radio', /260 ft/);
    await user.keyboard(' ');
    expect((first as HTMLInputElement).checked).toBe(true);
    await tabTo(user, 'button', 'Resolve conflict');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Enter a reason for the decision.')).toBeTruthy();
    await tabTo(user, 'textbox', 'Reason');
    await user.keyboard('datasheet confirmed by vendor');
    await tabTo(user, 'button', 'Resolve conflict');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(announcements().textContent).toBe('P-106 rated_head resolved: 260 ft.');
    });
    expect(state.conflicts[0]).toMatchObject({ id: CONFLICT_ID, status: 'resolved' });
    expect(await screen.findByText('No open conflicts.')).toBeTruthy();
  });

  it('resolves with an entered value', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: '#/conflicts' });
    const section = await screen.findByRole('region', { name: 'P-106 rated_head' });
    await user.click(within(section).getByRole('radio', { name: /Enter another value/ }));
    await user.type(within(section).getByLabelText('Value'), '255');
    await user.type(within(section).getByLabelText('Unit'), 'ft');
    await user.type(within(section).getByLabelText('Reason'), 'average of both');
    await user.click(within(section).getByRole('button', { name: 'Resolve conflict' }));
    await waitFor(() => {
      expect(state.conflicts[0]?.resolution).toMatchObject({ value: '255', unit: 'ft' });
    });
  });
});

describe('publish dialog', () => {
  it('lists the blockers from the server', async () => {
    fakeApi();
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await user.click(screen.getByRole('button', { name: 'Publish register' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish register' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish now' }));
    expect(await within(dialog).findByText('Publishing is blocked')).toBeTruthy();
    const items = within(dialog)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toContain('Field pending review: P-106 rated_flow');
    expect(items).toContain('Open conflict: P-106 rated_head');
  });

  it('closes with Escape even when focus has left the dialog, and on navigation', async () => {
    fakeApi();
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await user.click(screen.getByRole('button', { name: 'Publish register' }));
    await screen.findByRole('dialog', { name: 'Publish register' });
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Publish register' }));
    await screen.findByRole('dialog', { name: 'Publish register' });
    window.location.hash = '#/conflicts';
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('keeps Publish now focusable while the request runs', async () => {
    fakeApi();
    let release: (value: unknown) => void = () => undefined;
    server.use(
      http.post(`${API}/register/publish`, async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return HttpResponse.json(
          { error: { code: 'NOTHING_TO_PUBLISH', message: 'Nothing.' } },
          { status: 409 },
        );
      }),
    );
    const { user } = renderApp();
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await user.click(screen.getByRole('button', { name: 'Publish register' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish register' });
    const button = within(dialog).getByRole('button', { name: 'Publish now' });
    await user.click(button);
    await waitFor(() => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(button);
    release(null);
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
  });

  it('explains when the token cannot publish', async () => {
    fakeApi();
    const { user } = renderApp({ tokens: { engineer: TOKENS.engineer, approver: null } });
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await user.click(screen.getByRole('button', { name: 'Publish register' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish register' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish now' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/approver/i);
  });

  it('has no accessibility violations with blockers shown', async () => {
    fakeApi();
    const { user, container } = renderApp();
    await screen.findByRole('link', { name: 'Review p-106-datasheet.pdf' });
    await user.click(screen.getByRole('button', { name: 'Publish register' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish register' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish now' }));
    await within(dialog).findByText('Publishing is blocked');
    await expectNoAxeViolations(container);
  });
});

describe('audit view', () => {
  it('lists a field history with actor, action and reason as text', async () => {
    const state = fakeApi();
    state.audit.set(`field:${FIELD_IDS.head}`, [
      {
        id: '00000000-0000-4000-8000-0000000000e1',
        actor: 'system:worker',
        action: 'extract',
        before: null,
        after: { value: '<b>260</b>' },
        reason: null,
        createdAt: '2030-01-01T00:00:00.000Z',
      },
    ]);
    renderApp({ hash: `#/audit/field/${FIELD_IDS.head}` });
    const table = await screen.findByRole('table', { name: 'History' });
    expect(table.textContent).toContain('system:worker');
    expect(table.textContent).toContain('extract');
    expect(table.textContent).toContain('<b>260</b>');
    expect(table.querySelector('b')).toBeNull();
  });

  it('shows an empty history', async () => {
    fakeApi();
    renderApp({ hash: `#/audit/conflict/${CONFLICT_ID}` });
    expect(await screen.findByText('No events recorded.')).toBeTruthy();
  });
});

describe('keyboard-only flow', () => {
  it('opens a document, accepts, edits and rejects, resolves the conflict and publishes', async () => {
    const state = fakeApi();
    const { user } = renderApp();
    await tabTo(user, 'link', 'Review p-106-datasheet.pdf');
    await user.keyboard('{Enter}');
    await screen.findByRole('region', { name: 'Source page 1' });

    await user.keyboard('a'); // accept rated_flow, moves to rated_head
    await waitFor(() => {
      expect(announcements().textContent).toBe('rated_flow accepted.');
    });
    await user.keyboard('e');
    const value = await screen.findByLabelText('Value');
    await user.clear(value);
    await user.keyboard('261{Enter}');
    await waitFor(() => {
      expect(announcements().textContent).toBe('rated_head edited.');
    });
    await user.keyboard('r'); // reject rated_power
    await waitFor(() => {
      expect(announcements().textContent).toBe('rated_power rejected.');
    });

    await tabTo(user, 'link', 'Conflicts');
    await user.keyboard('{Enter}');
    await screen.findByRole('region', { name: 'P-106 rated_head' });
    await tabTo(user, 'radio', /260 ft/);
    await user.keyboard(' ');
    await tabTo(user, 'textbox', 'Reason');
    await user.keyboard('vendor confirmed');
    await tabTo(user, 'button', 'Resolve conflict');
    await user.keyboard('{Enter}');
    await screen.findByText('No open conflicts.');

    await tabTo(user, 'button', 'Publish register');
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Publish register' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await tabTo(user, 'button', 'Publish now');
    await user.keyboard('{Enter}');
    expect(
      await within(dialog).findByText('Published register version 1 with 1 item.'),
    ).toBeTruthy();
    expect(state.published).toBe(1);
    expect(state.fields.map((f) => f.reviewStatus)).toEqual(['accepted', 'edited', 'rejected']);
    expect(window.location.hash).toBe(`#/conflicts`);
    expect(DOC_ID).toBeTruthy();
  });
});
