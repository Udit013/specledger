import { File as NodeFile } from 'node:buffer';

import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './fake-api.js';

// Tests never touch the network: any request without a handler fails the test.
beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  // jsdom provides FormData and File, but the fetch under test is Node's, which cannot serialize
  // jsdom's FormData. Browsers have one implementation of each, so this is a test-only bridge:
  // forms are rebuilt as Node's FormData before MSW (installed above) sees the request.
  const probe = new Request('http://form.test', {
    method: 'POST',
    body: new URLSearchParams('probe=1'),
  });
  const NodeFormData: new () => FormData = (await probe.formData())
    .constructor as new () => FormData;
  const intercepted = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body: unknown = init?.body;
    if (body instanceof FormData && body.constructor !== NodeFormData) {
      const form = new NodeFormData();
      for (const [name, value] of body.entries()) {
        if (typeof value === 'string') {
          form.append(name, value);
        } else {
          const bytes = await value.arrayBuffer();
          form.append(
            name,
            new NodeFile([new Uint8Array(bytes)], value.name, { type: value.type }) as File,
          );
        }
      }
      return intercepted(input, { ...init, body: form });
    }
    return intercepted(input, init);
  };
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '';
});
afterAll(() => {
  server.close();
});
