import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { API, DOC_ID, FIELD_IDS, fakeApi, server } from '../../test/fake-api.js';
import { ApiClientError, createApiClient } from './client.js';

const client = () => createApiClient({ baseUrl: API });

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

  it('relies on the session cookie: no Authorization header, the anti-forgery header always', async () => {
    const seen: [string | null, string | null][] = [];
    fakeApi({
      onRequest: (request) =>
        seen.push([request.headers.get('authorization'), request.headers.get('x-requested-with')]),
    });
    await client().reviewField(FIELD_IDS.head, { action: 'accept', expectedVersion: 1 });
    await client().listDocuments();
    expect(seen).toEqual([
      [null, 'specledger'],
      [null, 'specledger'],
    ]);
  });

  it('sends the demo bearer token in a sandbox', async () => {
    const seen: (string | null)[] = [];
    fakeApi({ onRequest: (request) => seen.push(request.headers.get('authorization')) });
    await createApiClient({
      baseUrl: `${API}/demo`,
      bearer: () => Promise.resolve('demo.token'),
    })
      .listDocuments()
      .catch(() => undefined);
    expect(seen).toEqual(['Bearer demo.token']);
  });

  it.each([
    [null, 401, 'unauthenticated', /sign in/i],
    [['engineer'] as const, 403, 'forbidden', /role/i],
  ])('explains a refusal for %j', async (user, status, kind, message) => {
    fakeApi({ user });
    let ended = false;
    const error = await failure(
      createApiClient({
        baseUrl: API,
        onUnauthenticated: () => {
          ended = true;
        },
      }).publish(),
    );
    expect([error.status, error.kind]).toEqual([status, kind]);
    expect(error.message).toMatch(message);
    expect(ended).toBe(status === 401);
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

  it('never puts a credential in the URL', async () => {
    const urls: string[] = [];
    fakeApi({ onRequest: (request) => urls.push(request.url) });
    const demo = createApiClient({
      baseUrl: `${API}/demo`,
      bearer: () => Promise.resolve('demo.secret-token'),
    });
    await demo.listDocuments().catch(() => undefined);
    await client().getPage(DOC_ID, 1);
    expect(urls.join(' ')).not.toContain('secret-token');
  });
});
