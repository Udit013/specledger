import { describe, expect, it } from 'vitest';

import { assetPayloadFor, assetPayloadSchema, idempotencyKeyFor } from './contract.js';

const VERSION = {
  number: 4,
  approvedBy: 'role:approver',
  publishedAt: new Date('2030-01-02T03:04:05.000Z'),
  items: [],
};
const ITEM = {
  tag: 'P-106',
  values: {
    rated_head: { value: '260', unit: 'ft' },
    rated_flow: { value: '1997', unit: 'gpm' },
  },
};

describe('assetPayloadFor', () => {
  it('maps a register item to the ACC-style asset payload, attributes sorted by name', () => {
    const payload = assetPayloadFor(VERSION, ITEM);
    expect(payload).toEqual({
      externalId: 'specledger:P-106',
      name: 'P-106',
      attributes: [
        { name: 'rated_flow', value: '1997', unit: 'gpm' },
        { name: 'rated_head', value: '260', unit: 'ft' },
      ],
      source: {
        system: 'specledger',
        registerVersion: 4,
        publishedAt: '2030-01-02T03:04:05.000Z',
      },
    });
    expect(assetPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe('idempotencyKeyFor', () => {
  it('is the same for the same item of the same version, and differs otherwise', () => {
    expect(idempotencyKeyFor(VERSION, ITEM)).toBe('specledger:register:v4:P-106');
    expect(idempotencyKeyFor({ ...VERSION, number: 5 }, ITEM)).not.toBe(
      idempotencyKeyFor(VERSION, ITEM),
    );
  });
});
