import { describe, expect, it } from 'vitest';

import { createLogger, REDACTED } from './logger.js';

const SECRET = 'PLANTED-SECRET-7f3a';

function captureLog(fields: Record<string, unknown>): {
  raw: string;
  entry: Record<string, unknown>;
} {
  const lines: string[] = [];
  const logger = createLogger(
    { name: 'test', level: 'info' },
    { write: (line) => lines.push(line) },
  );
  logger.info(fields, 'event');
  expect(lines).toHaveLength(1);
  const raw = lines[0] ?? '';
  return { raw, entry: JSON.parse(raw) as Record<string, unknown> };
}

describe('createLogger redaction', () => {
  it.each([
    [
      'authorization header on a request',
      { req: { headers: { authorization: `Bearer ${SECRET}` } } },
    ],
    ['authorization header object', { headers: { authorization: `Bearer ${SECRET}` } }],
    ['top-level authorization', { authorization: `Bearer ${SECRET}` }],
    ['cookie header on a request', { req: { headers: { cookie: `session=${SECRET}` } } }],
    [
      'multipart parser options',
      { busboyOptions: { headers: { authorization: `Bearer ${SECRET}` }, limits: { files: 1 } } },
    ],
    ['bearer token field', { token: SECRET }],
    ['nested access token', { auth: { accessToken: SECRET } }],
    ['camelCase API key', { apiKey: SECRET }],
    ['snake_case API key', { api_key: SECRET }],
    ['nested provider API key', { provider: { apiKey: SECRET } }],
    ['password', { db: { password: SECRET } }],
    ['database URL with credentials', { config: { databaseUrl: `postgres://u:${SECRET}@h/db` } }],
  ])('replaces the %s', (_label, fields) => {
    const { raw } = captureLog(fields);
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain(REDACTED);
  });

  it.each([
    ['page text', { documentId: 'doc-1', pageText: `Rated flow ${SECRET}` }],
    ['quote', { fieldId: 'f-1', candidate: { quote: `Head: ${SECRET}` } }],
    ['raw text', { text: SECRET }],
    ['pages array', { pages: [`page one ${SECRET}`] }],
  ])('replaces document content: %s', (_label, fields) => {
    const { raw } = captureLog(fields);
    expect(raw).not.toContain(SECRET);
  });

  it('keeps the exact redaction marker at the redacted path', () => {
    const { entry } = captureLog({ req: { headers: { authorization: `Bearer ${SECRET}` } } });
    expect(entry).toMatchObject({ req: { headers: { authorization: REDACTED } } });
  });

  it('leaves ids, statuses and counts untouched', () => {
    const { entry } = captureLog({ documentId: 'doc-42', status: 'verified', pageCount: 3 });
    expect(entry).toMatchObject({
      documentId: 'doc-42',
      status: 'verified',
      pageCount: 3,
      msg: 'event',
    });
  });
});
