import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;

// The commands CI runs, against the committed corpus, extraction set, report and baseline. None
// of these writes a file.
describe('eval CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const quiet = () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    return { out, errors, text: () => [...out.mock.calls, ...errors.mock.calls].join('') };
  };

  it('passes every CI check on the committed files', async () => {
    const io = quiet();
    expect(await main(['ci'], ROOT)).toBe(0);
    expect(io.text()).toContain('evaluation checks passed');
  }, 120_000);

  it('finds the simulated set regenerates identically and the gate passes', async () => {
    const io = quiet();
    expect(await main(['simulate', '--check'], ROOT)).toBe(0);
    expect(await main(['gate'], ROOT)).toBe(0);
    expect(await main(['readme', '--check'], ROOT)).toBe(0);
    expect(io.text()).toContain('gate passed');
  }, 120_000);

  it('refuses the holdout without the flag, and writes no holdout report', async () => {
    const before = existsSync(`${ROOT}evaluation/holdout/report.json`);
    const io = quiet();
    expect(await main(['run', '--split', 'holdout'], ROOT)).toBe(1);
    expect(io.text()).toMatch(/--allow-holdout/);
    expect(existsSync(`${ROOT}evaluation/holdout/report.json`)).toBe(before);
  });

  it('rejects an unknown split, an unknown command and a set made for another corpus', async () => {
    const io = quiet();
    expect(await main(['run', '--split', 'train'], ROOT)).toBe(2);
    expect(await main(['nonsense'], ROOT)).toBe(2);
    expect(
      await main(['run', '--extractions', 'packages/eval/test/other-corpus-set.json'], ROOT),
    ).toBe(1);
    expect(io.text()).toMatch(/another corpus/);
  }, 120_000);
});
