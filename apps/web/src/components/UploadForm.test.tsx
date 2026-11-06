import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fakeApi } from '../../test/fake-api.js';
import { announcements, expectNoAxeViolations, renderApp } from '../../test/render.js';

const pdf = (name: string) => new File(['%PDF-1.7 synthetic'], name, { type: 'application/pdf' });

async function fill(user: ReturnType<typeof renderApp>['user'], name = 'p-110-datasheet.pdf') {
  await user.upload(await screen.findByLabelText('PDF file'), pdf(name));
  await user.type(screen.getByLabelText('Equipment tag'), 'P-110');
  await user.selectOptions(screen.getByLabelText('Equipment class'), 'centrifugal_pump');
  await user.selectOptions(screen.getByLabelText('Document type'), 'datasheet');
  await user.type(screen.getByLabelText('Revision (optional)'), 'Rev A');
}

describe('upload screen', () => {
  it('uploads a document with its metadata, announces it and shows the list', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: '#/upload' });
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      expect(announcements().textContent).toBe(
        'Uploaded p-110-datasheet.pdf. It is queued for extraction.',
      );
    });
    expect(state.uploads).toEqual([
      {
        filename: 'p-110-datasheet.pdf',
        fields: {
          documentType: 'datasheet',
          revision: 'Rev A',
          equipmentTag: 'P-110',
          equipmentClass: 'centrifugal_pump',
          synthetic: 'true',
        },
      },
    ]);
    expect(window.location.hash).toBe('#/documents');
    expect(await screen.findByRole('link', { name: 'Review p-110-datasheet.pdf' })).toBeTruthy();
  });

  it('says when the same file was uploaded before', async () => {
    fakeApi();
    const { user } = renderApp({ hash: '#/upload' });
    await fill(user, 'p-106-datasheet.pdf');
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      expect(announcements().textContent).toBe(
        'p-106-datasheet.pdf was uploaded before; showing the existing document.',
      );
    });
  });

  it('shows the server refusing a document outside the demo corpus', async () => {
    fakeApi();
    const { user } = renderApp({ hash: '#/upload' });
    await fill(user, 'real-vendor.pdf');
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/only the synthetic test documents/);
    expect(window.location.hash).toBe('#/upload');
  });

  it('asks for the file and the tag before sending anything', async () => {
    const state = fakeApi();
    const { user } = renderApp({ hash: '#/upload' });
    await user.click(await screen.findByRole('button', { name: 'Upload' }));
    const problems = await screen.findByRole('alert');
    expect(within(problems).getByText('Choose a PDF file.')).toBeTruthy();
    expect(within(problems).getByText('Enter the equipment tag.')).toBeTruthy();
    expect(state.uploads).toEqual([]);
  });

  it('is only for signed-in engineers', async () => {
    fakeApi({ user: ['approver'] });
    renderApp({ hash: '#/upload' });
    expect(await screen.findByRole('heading', { name: 'Upload a document' })).toBeTruthy();
    expect(screen.queryByLabelText('PDF file')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Upload' })).toBeNull();
  });

  it('has no accessibility violations', async () => {
    fakeApi();
    const { container } = renderApp({ hash: '#/upload' });
    await screen.findByLabelText('PDF file');
    await expectNoAxeViolations(container);
  });
});
