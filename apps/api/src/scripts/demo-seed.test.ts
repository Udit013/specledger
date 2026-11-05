import { describe, expect, it } from 'vitest';

import { DEMO_DOCUMENTS, seedDemo } from './demo-seed.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;

describe('seedDemo', () => {
  it('uploads each demo document with the metadata its ground truth states', async () => {
    const sent: {
      url: string;
      auth: string | null;
      fields: Record<string, string>;
      file: string;
    }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const form = init?.body as FormData;
      const fields: Record<string, string> = {};
      let file = '';
      for (const [name, value] of form.entries()) {
        if (typeof value === 'string') fields[name] = value;
        else file = value.name;
      }
      sent.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        auth: new Headers(init?.headers).get('authorization'),
        fields,
        file,
      });
      return Promise.resolve(new Response(JSON.stringify({ duplicate: false }), { status: 202 }));
    };
    const waits: number[] = [];
    const results = await seedDemo({
      root: ROOT,
      apiUrl: 'https://api.example.test/',
      engineerToken: 'tok',
      fetch: fakeFetch,
      pauseMs: 7_000,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(results.map((r) => [r.id, r.status])).toEqual(DEMO_DOCUMENTS.map((id) => [id, 202]));
    expect(sent[0]).toEqual({
      url: 'https://api.example.test/documents',
      auth: 'Bearer tok',
      fields: {
        documentType: 'datasheet',
        revision: 'Rev A',
        equipmentTag: 'P-106',
        equipmentClass: 'centrifugal_pump',
        synthetic: 'true',
      },
      file: 'p-106-datasheet.pdf',
    });
    expect(sent.find((s) => s.file === 'p-106-brochure.pdf')?.fields).toMatchObject({
      documentType: 'brochure',
      equipmentTag: 'P-106',
    });
    expect(sent.find((s) => s.file === 'p-106-brochure.pdf')?.fields.revision).toBeUndefined();
    expect(waits).toHaveLength(DEMO_DOCUMENTS.length - 1);
  });

  it('demonstrates the designed cases and uses only dev documents', () => {
    expect(DEMO_DOCUMENTS).toEqual([
      'p-106-datasheet',
      'p-106-brochure',
      'm-201-datasheet-rev-a',
      'm-201-datasheet-rev-b',
      'p-108-datasheet',
      'm-203-datasheet',
      'p-110-datasheet',
    ]);
  });
});
