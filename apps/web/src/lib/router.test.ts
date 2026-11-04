import { describe, expect, it } from 'vitest';

import { hrefFor, parseRoute } from './router.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('parseRoute', () => {
  it.each([
    ['', { name: 'documents' }],
    ['#/', { name: 'documents' }],
    ['#/documents', { name: 'documents' }],
    [`#/documents/${ID}`, { name: 'review', documentId: ID }],
    ['#/conflicts', { name: 'conflicts' }],
    [`#/audit/field/${ID}`, { name: 'audit', kind: 'field', id: ID }],
    [`#/audit/conflict/${ID}`, { name: 'audit', kind: 'conflict', id: ID }],
  ])('reads %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each(['#/documents/not-an-id', '#/audit/user/1', '#/nowhere', '#/documents/%3Cscript%3E'])(
    'treats %j as not found',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ name: 'not_found' });
    },
  );
});

describe('hrefFor', () => {
  it('round-trips every route', () => {
    for (const route of [
      { name: 'documents' },
      { name: 'review', documentId: ID },
      { name: 'conflicts' },
      { name: 'audit', kind: 'conflict', id: ID },
    ] as const) {
      expect(parseRoute(hrefFor(route))).toEqual(route);
    }
  });
});
