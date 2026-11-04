import { describe, expect, it } from 'vitest';

import { evaluate } from './cli.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;

describe('evaluation on the committed corpus and extraction set', () => {
  it('produces byte-identical reports when run twice', async () => {
    const first = await evaluate(ROOT, { split: 'dev', allowHoldout: false });
    const second = await evaluate(ROOT, { split: 'dev', allowHoldout: false });
    if (!first.ok || !second.ok) throw new Error('evaluation failed');
    expect(second.value.json).toBe(first.value.json);
    expect(second.value.markdown).toBe(first.value.markdown);
  }, 120_000);

  it('refuses the holdout split without the flag', async () => {
    expect(await evaluate(ROOT, { split: 'holdout', allowHoldout: false })).toEqual({
      ok: false,
      error: 'HOLDOUT_REQUIRES_FLAG',
    });
  });
});
