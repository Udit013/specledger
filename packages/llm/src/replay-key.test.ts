import { describe, expect, it } from 'vitest';

import { pumpRequest } from '../test/support/fakes.js';
import { canonicalJson, replayKey } from './replay-key.js';
import type { ExtractionRequest } from './types.js';

// Rebuilds every object with its keys in reverse insertion order.
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, item]) => [key, reversedKeys(item)]),
    ) as T;
  }
  return value;
}

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: 'x' })).toBe(
      '{"a":"x","b":[3,{"a":2,"z":1}]}',
    );
  });

  it('drops undefined properties and refuses values JSON cannot represent', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

describe('replayKey', () => {
  const request = pumpRequest();
  const key = replayKey(request, 'gemini-x');

  it('is the same for the same request, however its objects were built', () => {
    expect(replayKey(pumpRequest(), 'gemini-x')).toBe(key);
    expect(replayKey(reversedKeys(request), 'gemini-x')).toBe(key);
    expect(replayKey(JSON.parse(JSON.stringify(request)) as ExtractionRequest, 'gemini-x')).toBe(
      key,
    );
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, () => string]>([
    [
      'the prompt version',
      () => replayKey({ ...request, promptVersion: 'extract-v2' }, 'gemini-x'),
    ],
    ['the model id', () => replayKey(request, 'gemini-y')],
    [
      'one character of page text',
      () =>
        replayKey(
          {
            ...request,
            pages: [{ pageNumber: 1, text: 'Rated flow: 501 gpm' }, ...request.pages.slice(1)],
          },
          'gemini-x',
        ),
    ],
    [
      'the order of the pages',
      () => replayKey({ ...request, pages: [...request.pages].reverse() }, 'gemini-x'),
    ],
    [
      'the field list',
      () => replayKey({ ...request, fields: request.fields.slice(1) }, 'gemini-x'),
    ],
    [
      'the equipment class',
      () => replayKey({ ...request, equipmentClass: 'electric_motor' }, 'gemini-x'),
    ],
    ['the synthetic flag', () => replayKey({ ...request, synthetic: false }, 'gemini-x')],
  ])('changes with %s', (_case, changed) => {
    expect(changed()).not.toBe(key);
  });
});
