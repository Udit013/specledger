import { describe, expect, it } from 'vitest';

import { groundTruthSchema } from './truth.js';

const PUMP_FIELDS = [
  'rated_flow',
  'rated_head',
  'rated_speed',
  'rated_power',
  'efficiency',
  'npsh_required',
  'max_working_pressure',
  'design_temperature',
];

function truth(fields: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    documentId: 'p-101-datasheet-rev-a',
    lineageId: 'p-101',
    equipmentTag: 'P-101',
    equipmentClass: 'centrifugal_pump',
    sourceType: 'datasheet',
    revision: 'Rev A',
    pageCount: 2,
    textLayer: true,
    fields: {
      ...Object.fromEntries(PUMP_FIELDS.map((name) => [name, null])),
      rated_flow: { value: '500', unit: 'gpm', page: 1, quote: 'Rated flow: 500 gpm (113.6 m3/h)' },
      ...fields,
    },
    ...overrides,
  };
}

const issues = (value: unknown) =>
  groundTruthSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

describe('groundTruthSchema', () => {
  it('accepts a document with present and absent fields', () => {
    expect(groundTruthSchema.safeParse(truth()).success).toBe(true);
  });

  it('rejects a non-null value without a quote', () => {
    const result = groundTruthSchema.safeParse(
      truth({ rated_head: { value: '45', unit: 'm', page: 1 } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['fields', 'rated_head', 'quote']);
  });

  it('rejects a null value that still carries a quote', () => {
    const result = groundTruthSchema.safeParse(
      truth({ rated_head: { value: null, unit: 'm', page: 1, quote: 'Rated head: 45 m' } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['fields', 'rated_head', 'value']);
  });

  it('rejects a quote that does not contain the value or the unit as written', () => {
    expect(
      issues(truth({ rated_head: { value: '45', unit: 'm', page: 1, quote: 'Rated head: 46 m' } })),
    ).toContain('quote must contain the value as written');
    expect(
      issues(truth({ rated_head: { value: '45', unit: 'ft', page: 1, quote: 'Head 45 m' } })),
    ).toContain('quote must contain the unit as written');
  });

  it('rejects a field list that is not exactly the class field list', () => {
    expect(issues(truth({ impeller_diameter: null }))).toContain(
      'fields must be exactly the centrifugal_pump field list',
    );
    const missing = truth();
    delete (missing.fields as Record<string, unknown>).design_temperature;
    expect(issues(missing)).toContain('fields must be exactly the centrifugal_pump field list');
  });

  it('rejects values in a document that has no text layer', () => {
    expect(issues(truth({}, { textLayer: false }))).toContain(
      'a document without a text layer has no extractable values',
    );
  });

  it('rejects a page beyond the page count', () => {
    expect(
      issues(truth({ rated_head: { value: '45', unit: 'm', page: 3, quote: 'Head 45 m' } })),
    ).toContain('page is beyond the document page count');
  });

  it('rejects unknown keys', () => {
    expect(groundTruthSchema.safeParse(truth({}, { verified: true })).success).toBe(false);
  });
});
