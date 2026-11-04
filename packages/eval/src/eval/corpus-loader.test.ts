import { describe, expect, it } from 'vitest';

import { loadEvalCorpus } from './corpus-loader.js';

const CORPUS = new URL('../../../../fixtures/corpus/', import.meta.url).pathname;

describe('loadEvalCorpus', () => {
  it('loads the dev split by default, with page text and ground truth', async () => {
    const loaded = await loadEvalCorpus(CORPUS, { split: 'dev', allowHoldout: false });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.value.documents.length).toBe(27);
    expect(loaded.value.documents.every((d) => d.split === 'dev')).toBe(true);
    const flow = loaded.value.documents.find((d) => d.id === 'p-106-datasheet');
    expect(flow?.pages?.[0]).toContain('SYNTHETIC TEST DOCUMENT');
    expect(loaded.value.documents.find((d) => d.id === 'p-104-datasheet-scan')?.pages).toBeNull();
    expect(loaded.value.corpusSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('refuses the holdout split without the explicit flag, reading nothing from it', async () => {
    expect(await loadEvalCorpus(CORPUS, { split: 'holdout', allowHoldout: false })).toEqual({
      ok: false,
      error: 'HOLDOUT_REQUIRES_FLAG',
    });
  });
});
