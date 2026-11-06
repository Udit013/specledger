import { describe, expect, it } from 'vitest';

import { hrefFor, parseRoute } from './router.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('parseRoute', () => {
  it.each([
    ['', { name: 'home' }],
    ['#/', { name: 'home' }],
    ['#/documents', { name: 'documents' }],
    [`#/documents/${ID}`, { name: 'review', documentId: ID }],
    ['#/conflicts', { name: 'conflicts' }],
    ['#/upload', { name: 'upload' }],
    ['#/sign-in', { name: 'sign_in' }],
    ['#/register', { name: 'register' }],
    ['#/register/12', { name: 'register_version', number: 12 }],
    ['#/users', { name: 'users' }],
    [`#/audit/field/${ID}`, { name: 'audit', kind: 'field', id: ID }],
    [`#/audit/conflict/${ID}`, { name: 'audit', kind: 'conflict', id: ID }],
  ])('reads %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each([
    '#/register/0',
    '#/register/x',
    '#/register/1/2',
    '#/documents/not-an-id',
    '#/audit/user/1',
    '#/nowhere',
    '#/documents/%3Cscript%3E',
  ])('treats %j as not found', (hash) => {
    expect(parseRoute(hash)).toEqual({ name: 'not_found' });
  });
});

describe('hrefFor', () => {
  it('round-trips every route', () => {
    for (const route of [
      { name: 'home' },
      { name: 'documents' },
      { name: 'review', documentId: ID },
      { name: 'conflicts' },
      { name: 'upload' },
      { name: 'sign_in' },
      { name: 'users' },
      { name: 'register' },
      { name: 'register_version', number: 3 },
      { name: 'audit', kind: 'conflict', id: ID },
    ] as const) {
      expect(parseRoute(hrefFor(route))).toEqual(route);
    }
  });
});
