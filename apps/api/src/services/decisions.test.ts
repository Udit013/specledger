import { FIELD_DEFINITIONS } from '@specledger/core';
import type { ConflictRecord } from '@specledger/core';
import { describe, expect, it } from 'vitest';

import { decisionsFrom, lineageOf } from './decisions.js';

const definitions = new Map(FIELD_DEFINITIONS.centrifugal_pump.map((f) => [f.name, f]));
const ID = '00000000-0000-4000-8000-000000000001';
const FIELD = '00000000-0000-4000-8000-000000000002';

const resolved = (overrides: Partial<ConflictRecord> = {}): ConflictRecord => ({
  id: ID,
  equipmentId: ID,
  fieldName: 'rated_head',
  status: 'resolved',
  resolution: 'datasheet value',
  createdAt: new Date(0),
  resolvedAt: new Date(1),
  resolvedBy: 'role:engineer',
  chosenFieldId: FIELD,
  decidedValue: '260',
  decidedUnit: 'ft',
  basedOn: [{ candidateId: FIELD, lineage: 'P-106:datasheet', revision: 'Rev A' }],
  ...overrides,
});

describe('decisionsFrom', () => {
  it('turns a resolved conflict into a decision with its normalized value and evidence', () => {
    expect(decisionsFrom([resolved()], definitions)).toEqual([
      {
        fieldName: 'rated_head',
        value: { kind: 'scalar', value: 260 * 0.3048, unit: 'm' },
        candidateId: FIELD,
        basedOn: [{ candidateId: FIELD, lineage: 'P-106:datasheet', revision: 'Rev A' }],
      },
    ]);
  });

  it('skips open conflicts, unknown fields and values that no longer normalize', () => {
    expect(
      decisionsFrom(
        [
          resolved({ status: 'open', resolution: null, resolvedAt: null }),
          resolved({ fieldName: 'impeller_diameter' }),
          resolved({ decidedUnit: 'kW' }),
        ],
        definitions,
      ),
    ).toEqual([]);
  });

  it('names lineages by tag and document type', () => {
    expect(lineageOf('P-106', 'datasheet')).toBe('P-106:datasheet');
  });
});
