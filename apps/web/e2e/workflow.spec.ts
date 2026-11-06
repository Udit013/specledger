import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The whole workflow in a real browser: sign in, upload two vendor documents for one pump, wait
// for extraction, review every value (the datasheet's rated head is rejected, which opens a
// conflict with the brochure), resolve the conflict, publish, open the version in the register,
// and download it. The API, queue, worker, verifier and reconciliation are the real ones; only
// the model is a deterministic stand-in (see e2e/server.mjs).

const PDF = (id: string) =>
  fileURLToPath(new URL(`../../../fixtures/corpus/pdf/${id}.pdf`, import.meta.url));
const USER = { email: 'e2e@example.com', password: 'end-to-end-password-0123' };

async function upload(
  page: Page,
  id: string,
  fields: { type: 'Datasheet' | 'Brochure'; revision: string },
) {
  await page.goto('/#/upload');
  await page.getByLabel('PDF file').setInputFiles(PDF(id));
  await page.getByLabel('Equipment tag').fill('P-106');
  await page.getByLabel('Equipment class').selectOption({ label: 'Centrifugal pump' });
  await page.getByLabel('Document type').selectOption({ label: fields.type });
  await page.getByLabel('Revision (optional)').fill(fields.revision);
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page).toHaveURL(/#\/documents$/);
}

// Reviews every value of a document, keyboard first: select a field, then press a or r.
async function reviewAll(page: Page, document: string, reject: readonly string[] = []) {
  await page.goto('/#/documents');
  await page.getByRole('link', { name: `Review ${document}` }).click();
  const fields = page.getByRole('list', { name: 'Fields' }).getByRole('button');
  await expect(fields.first()).toBeVisible();
  const count = await fields.count();
  for (let i = 0; i < count; i += 1) {
    const field = fields.nth(i);
    const name = (await field.textContent()) ?? '';
    const rejecting = reject.some((r) => name.startsWith(r));
    await field.click();
    await page.keyboard.press(rejecting ? 'r' : 'a');
    await expect(fields.nth(i)).toContainText(rejecting ? 'Rejected' : 'Accepted');
  }
}

test('upload, extraction, review, conflict, publish, register and download', async ({ page }) => {
  await page.goto('/#/sign-in');
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Password').fill(USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await upload(page, 'p-106-datasheet', { type: 'Datasheet', revision: 'Rev A' });
  await upload(page, 'p-106-brochure', { type: 'Brochure', revision: '' });
  // The list refreshes itself while documents are queued or extracting.
  await expect(page.getByText('Succeeded', { exact: true })).toHaveCount(2, { timeout: 60_000 });

  // The datasheet outranks the brochure; rejecting its rated head (260 ft) must not let the
  // brochure's 250 ft through silently, so a conflict opens.
  await reviewAll(page, 'p-106-datasheet.pdf', ['rated_head']);
  await reviewAll(page, 'p-106-brochure.pdf');

  await page.getByRole('link', { name: 'Conflicts' }).click();
  const conflict = page.getByRole('region', { name: 'P-106 rated_head' });
  await conflict.getByLabel(/^250 ft/).check();
  await conflict.getByLabel('Reason').fill('Vendor confirmed 250 ft at the rated flow');
  await conflict.getByRole('button', { name: 'Resolve conflict' }).click();
  await expect(page.getByText('No open conflicts.')).toBeVisible();

  await page.getByRole('button', { name: 'Publish register' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish register' });
  await dialog.getByRole('button', { name: 'Publish now' }).click();
  await dialog.getByRole('link', { name: 'Open it in the register' }).click();

  await expect(page.getByRole('heading', { name: 'Register version 1' })).toBeVisible();
  const item = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'P-106' }) });
  await expect(item).toContainText('rated_head');
  await expect(item).toContainText('250 ft');
  await expect(item).toContainText('1997 gpm');
  await expect(page.getByText('Nothing is sent:')).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('register-v1.csv');
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv.split('\r\n')[0]).toBe('tag,field,value,unit');
  expect(csv).toContain('P-106,rated_head,250,ft');
});
