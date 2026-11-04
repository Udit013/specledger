import { candidateSchema, FIELD_DEFINITIONS } from '@specledger/core';
import { describe, expect, it } from 'vitest';

import { DOCS } from './fixtures.js';
import { extractionSetSchema } from './extraction-set.js';
import { SIMULATED_LABEL, simulateExtractions } from './simulate.js';

const OPTIONS = { seed: 'test-seed', date: '2030-01-01', corpusSha256: 'c'.repeat(64) };

describe('simulateExtractions', () => {
  const set = simulateExtractions(DOCS, OPTIONS);

  it('is labelled simulated, everywhere a reader looks', () => {
    expect(set.origin).toBe('simulated');
    expect(set.label).toBe(SIMULATED_LABEL);
    expect(SIMULATED_LABEL).toMatch(/simulated/i);
    expect(SIMULATED_LABEL).toMatch(/not .*language model/i);
    expect(set.modelId).toMatch(/^simulated-/);
    expect(set.generator).toMatchObject({ name: 'simulated-error-model', seed: 'test-seed' });
    expect(extractionSetSchema.safeParse(set).success).toBe(true);
  });

  it('is deterministic for a seed and changes with it', () => {
    expect(simulateExtractions(DOCS, OPTIONS)).toEqual(set);
    expect(simulateExtractions(DOCS, { ...OPTIONS, seed: 'other' })).not.toEqual(set);
  });

  it('gives no extraction for a document without a text layer', () => {
    expect(set.documents['p-901-scan']).toBeUndefined();
  });

  it('proposes only well-formed candidates for fields of the class', () => {
    const names = new Set(FIELD_DEFINITIONS.centrifugal_pump.map((f) => f.name));
    for (const extraction of Object.values(set.documents)) {
      if (!('candidates' in extraction)) continue;
      for (const candidate of extraction.candidates) {
        expect(candidateSchema.safeParse(candidate).success).toBe(true);
        expect(names.has(candidate.fieldName)).toBe(true);
      }
    }
  });
});

describe('the error model', () => {
  it('misreads a value far beyond the 0.5 percent tolerance', async () => {
    const { misreadForTest } = await import('./simulate.js');
    for (const [value, misread] of [
      ['2929', '3929'],
      ['1450-1780', '2450-1780'],
      ['0,85', '0,95'],
      ['9', '1'],
    ] as const) {
      expect(misreadForTest(value)).toBe(misread);
    }
  });
});
