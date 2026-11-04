import { describe, expect, it } from 'vitest';

import { parseRetryAfter } from './retry-after.js';

const NOW = Date.parse('2030-06-01T12:00:00.000Z');

describe('parseRetryAfter', () => {
  it.each([
    ['0', 0],
    ['1', 1_000],
    ['120', 120_000],
    [' 5 ', 5_000],
  ])('reads delay-seconds %j as %i ms', (header, ms) => {
    expect(parseRetryAfter(header, NOW)).toBe(ms);
  });

  it('reads an HTTP date as the time from now until then', () => {
    expect(parseRetryAfter('Sat, 01 Jun 2030 12:00:30 GMT', NOW)).toBe(30_000);
  });

  it('reads an HTTP date in the past as no wait', () => {
    expect(parseRetryAfter('Sat, 01 Jun 2030 11:59:00 GMT', NOW)).toBe(0);
  });

  it.each([
    null,
    undefined,
    '',
    '-1',
    '1.5',
    '1e3',
    'soon',
    'Mon, 99 Foo 2030 25:61:61 GMT',
    '12abc',
  ])('refuses %j', (header) => {
    expect(parseRetryAfter(header, NOW)).toBeNull();
  });
});
