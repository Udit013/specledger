import { describe, expect, it } from 'vitest';

import {
  CANONICAL_UNITS,
  candidateSchema,
  conflictRecordSchema,
  DIMENSIONS,
  EQUIPMENT_CLASSES,
  equipmentClassSchema,
  FIELD_DEFINITIONS,
  fieldDefinitionSchema,
  fieldRecordSchema,
  registerVersionRecordSchema,
  REVIEW_STATUSES,
  reviewStatusSchema,
  VERIFICATION_REASONS,
  verificationReasonSchema,
  verificationStatusSchema,
} from './index.js';

const VALID_CANDIDATE = {
  fieldName: 'rated_flow',
  value: '500',
  unit: 'gpm',
  quote: 'Rated flow: 500 gpm (113.6 m3/h)',
  page: 1,
};

describe('candidateSchema', () => {
  it('accepts a well-formed candidate and keeps the value as stated text', () => {
    expect(candidateSchema.parse({ ...VALID_CANDIDATE, value: '1,234.5' })).toEqual({
      ...VALID_CANDIDATE,
      value: '1,234.5',
    });
  });

  it('accepts a range value as text', () => {
    expect(candidateSchema.parse({ ...VALID_CANDIDATE, value: '2900-3600' }).value).toBe(
      '2900-3600',
    );
  });

  it.each([
    ['empty quote', { quote: '' }],
    ['page zero', { page: 0 }],
    ['fractional page', { page: 1.5 }],
    ['blank value', { value: '   ' }],
    ['numeric value', { value: 500 }],
    ['missing unit', { unit: undefined }],
    ['non snake_case field name', { fieldName: 'Rated Flow' }],
    ['overlong quote', { quote: 'x'.repeat(1001) }],
  ])('rejects %s', (_label, override) => {
    expect(candidateSchema.safeParse({ ...VALID_CANDIDATE, ...override }).success).toBe(false);
  });

  it('rejects unknown keys, so extra model output cannot slip through', () => {
    const result = candidateSchema.safeParse({ ...VALID_CANDIDATE, verified: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('status enums', () => {
  it.each(VERIFICATION_REASONS)('accepts verification reason %s', (reason) => {
    expect(verificationReasonSchema.parse(reason)).toBe(reason);
  });

  it('lists exactly the eight reason codes from the plan', () => {
    expect([...VERIFICATION_REASONS].sort()).toEqual(
      [
        'AMBIGUOUS_NUMBER_FORMAT',
        'INTERNAL',
        'OUT_OF_RANGE',
        'QUOTE_NOT_FOUND',
        'QUOTE_TOO_SHORT',
        'UNIT_MISMATCH',
        'UNIT_UNKNOWN',
        'VALUE_NOT_IN_QUOTE',
      ].sort(),
    );
  });

  it.each(['quote_not_found', 'NOT_A_REASON', '', 'VERIFIED'])(
    'rejects unknown verification reason %j',
    (reason) => {
      expect(verificationReasonSchema.safeParse(reason).success).toBe(false);
    },
  );

  it('keeps verification status and review status as separate vocabularies', () => {
    expect(verificationStatusSchema.options).toEqual(['verified', 'unverified']);
    expect(REVIEW_STATUSES).toEqual(['pending', 'accepted', 'edited', 'rejected']);
    expect(reviewStatusSchema.safeParse('verified').success).toBe(false);
    expect(verificationStatusSchema.safeParse('accepted').success).toBe(false);
  });

  it('accepts only the two equipment classes', () => {
    expect(EQUIPMENT_CLASSES).toEqual(['centrifugal_pump', 'electric_motor']);
    expect(equipmentClassSchema.safeParse('control_valve').success).toBe(false);
  });
});

describe('field definitions', () => {
  it.each(EQUIPMENT_CLASSES)('every %s field definition passes its schema', (equipmentClass) => {
    for (const definition of FIELD_DEFINITIONS[equipmentClass]) {
      expect(fieldDefinitionSchema.safeParse(definition).success).toBe(true);
    }
  });

  it.each(EQUIPMENT_CLASSES)('%s field names are unique', (equipmentClass) => {
    const names = FIELD_DEFINITIONS[equipmentClass].map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every dimension a canonical unit', () => {
    expect(DIMENSIONS.every((dimension) => CANONICAL_UNITS[dimension].length > 0)).toBe(true);
  });

  it('rejects a definition whose range is inverted', () => {
    const result = fieldDefinitionSchema.safeParse({
      name: 'rated_head',
      dimension: 'length',
      canonicalUnit: 'm',
      kind: 'scalar',
      plausibleRange: { min: 100, max: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a definition whose canonical unit does not match its dimension', () => {
    const result = fieldDefinitionSchema.safeParse({
      name: 'rated_head',
      dimension: 'length',
      canonicalUnit: 'ft',
      kind: 'scalar',
      plausibleRange: { min: 0.5, max: 3000 },
    });
    expect(result.success).toBe(false);
  });
});

describe('record invariants', () => {
  const ids = {
    id: '00000000-0000-4000-8000-000000000001',
    extractionRunId: '00000000-0000-4000-8000-000000000002',
    equipmentId: '00000000-0000-4000-8000-000000000003',
  };
  const field = {
    ...ids,
    name: 'rated_flow',
    value: '500',
    unit: 'gpm',
    quote: 'Rated flow: 500 gpm',
    page: 1,
    reviewStatus: 'pending',
    version: 1,
    createdAt: new Date(0),
  };

  it('accepts verified with no reasons and unverified with reasons', () => {
    expect(
      fieldRecordSchema.safeParse({
        ...field,
        verificationStatus: 'verified',
        verificationReasons: [],
      }).success,
    ).toBe(true);
    expect(
      fieldRecordSchema.safeParse({
        ...field,
        verificationStatus: 'unverified',
        verificationReasons: ['QUOTE_NOT_FOUND'],
      }).success,
    ).toBe(true);
  });

  it('rejects verified with reasons and unverified without any', () => {
    expect(
      fieldRecordSchema.safeParse({
        ...field,
        verificationStatus: 'verified',
        verificationReasons: ['OUT_OF_RANGE'],
      }).success,
    ).toBe(false);
    expect(
      fieldRecordSchema.safeParse({
        ...field,
        verificationStatus: 'unverified',
        verificationReasons: [],
      }).success,
    ).toBe(false);
  });

  it('requires a resolved conflict to carry its resolution', () => {
    const conflict = {
      id: ids.id,
      equipmentId: ids.equipmentId,
      fieldName: 'rated_head',
      createdAt: new Date(0),
      resolvedBy: null,
      chosenFieldId: null,
      decidedValue: null,
      decidedUnit: null,
      basedOn: null,
    };
    expect(
      conflictRecordSchema.safeParse({
        ...conflict,
        status: 'resolved',
        resolution: null,
        resolvedAt: null,
      }).success,
    ).toBe(false);
    expect(
      conflictRecordSchema.safeParse({
        ...conflict,
        status: 'open',
        resolution: null,
        resolvedAt: null,
      }).success,
    ).toBe(true);
  });

  it('requires a resolved conflict to record its decision, and an open one to have none', () => {
    const resolved = {
      id: ids.id,
      equipmentId: ids.equipmentId,
      fieldName: 'rated_head',
      status: 'resolved',
      resolution: 'datasheet over brochure',
      createdAt: new Date(0),
      resolvedAt: new Date(1),
      resolvedBy: 'role:engineer',
      chosenFieldId: null,
      decidedValue: '45',
      decidedUnit: 'm',
      basedOn: [{ candidateId: ids.id, lineage: 'P-1:datasheet', revision: 'Rev A' }],
    };
    expect(conflictRecordSchema.safeParse(resolved).success).toBe(true);
    expect(conflictRecordSchema.safeParse({ ...resolved, decidedValue: null }).success).toBe(false);
    expect(
      conflictRecordSchema.safeParse({
        ...resolved,
        status: 'open',
        resolution: null,
        resolvedAt: null,
      }).success,
    ).toBe(false);
  });

  it('requires a published register version to name its approver', () => {
    const version = { id: ids.id, number: 1, createdAt: new Date(0) };
    expect(
      registerVersionRecordSchema.safeParse({
        ...version,
        approvedBy: null,
        publishedAt: new Date(0),
      }).success,
    ).toBe(false);
  });
});
