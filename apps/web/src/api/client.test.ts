import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { API, DOC_ID, FIELD_IDS, fakeApi, server, TOKENS } from '../../test/fake-api.js';
import { ApiClientError, createApiClient } from './client.js';

const client = (tokens: { engineer: string | null; approver: string | null } = TOKENS) =>
  createApiClient({ baseUrl: API, tokens: () => tokens });

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiClientError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
};

describe('createApiClient', () => {
  it('returns responses validated by the shared schemas', async () => {
    fakeApi();
    const documents = await client().listDocuments();
    expect(documents.map((d) => d.id)).toEqual([DOC_ID]);
    const fields = await client().listFields(DOC_ID);
    expect(fields.map((f) => f.name)).toContain('rated_head');
  });

  it('refuses a response that does not match its schema', async () => {
    server.use(
      http.get(`${API}/documents`, () => HttpResponse.json({ documents: [{ id: 'not-a-uuid' }] })),
    );
    const error = await failure(client().listDocuments());
    expect(error.kind).toBe('invalid_response');
  });

  it('sends the engineer token for reviews and the approver token for publishing', async () => {
    const seen: (string | null)[] = [];
    fakeApi({ onRequest: (request) => seen.push(request.headers.get('authorization')) });
    await client().reviewField(FIELD_IDS.head, { action: 'accept', expectedVersion: 1 });
    await failure(client().publish());
    expect(seen).toEqual([`Bearer ${TOKENS.engineer}`, `Bearer ${TOKENS.approver}`]);
  });

  it('falls back to the other token when the preferred role has none', async () => {
    const seen: (string | null)[] = [];
    fakeApi({ onRequest: (request) => seen.push(request.headers.get('authorization')) });
    await failure(client({ engineer: TOKENS.engineer, approver: null }).publish());
    expect(seen).toEqual([`Bearer ${TOKENS.engineer}`]);
  });

  it('sends no Authorization header without any token', async () => {
    const seen: (string | null)[] = [];
    fakeApi({ onRequest: (request) => seen.push(request.headers.get('authorization')) });
    await failure(client({ engineer: null, approver: null }).listDocuments());
    expect(seen).toEqual([null]);
  });

  it.each([
    [{ engineer: null, approver: null }, 401, 'unauthenticated', /token/i],
    [{ engineer: TOKENS.engineer, approver: null }, 403, 'forbidden', /role/i],
  ])('explains a %s refusal', async (tokens, status, kind, message) => {
    fakeApi();
    const error = await failure(client(tokens).publish());
    expect([error.status, error.kind]).toEqual([status, kind]);
    expect(error.message).toMatch(message);
  });

  it('carries the server state of a 409 version conflict', async () => {
    fakeApi();
    await client().reviewField(FIELD_IDS.head, { action: 'accept', expectedVersion: 1 });
    const error = await failure(
      client().reviewField(FIELD_IDS.head, { action: 'reject', expectedVersion: 1 }),
    );
    expect(error.kind).toBe('conflict');
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.currentField).toMatchObject({ reviewStatus: 'accepted', version: 2 });
  });

  it('reports a network failure as such', async () => {
    server.use(http.get(`${API}/documents`, () => HttpResponse.error()));
    expect((await failure(client().listDocuments())).kind).toBe('network');
  });

  it('never puts a token in the URL', async () => {
    const urls: string[] = [];
    fakeApi({ onRequest: (request) => urls.push(request.url) });
    await client().listDocuments();
    await client().getPage(DOC_ID, 1);
    expect(urls.join(' ')).not.toContain(TOKENS.engineer);
    expect(urls.join(' ')).not.toContain(TOKENS.approver);
  });
});
