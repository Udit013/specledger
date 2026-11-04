import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeWithMap } from './normalize.js';
import { PROPERTY_SEED } from '../test/property-seed.js';

const normalized = (text: string) => normalizeWithMap(text).normalized;

describe('normalizeWithMap: normalized text', () => {
  it.each([
    [
      'collapses whitespace runs, tabs, line breaks and no-break spaces',
      'Rated  flow:\t500\u00A0gpm\n\n(113.6 m3/h)',
      'Rated flow: 500 gpm (113.6 m3/h)',
    ],
    ['trims leading and trailing whitespace', '  Rated head: 45 m \n', 'Rated head: 45 m'],
    ['applies NFKC to superscripts', 'Rated flow 248,6 m³/h', 'Rated flow 248,6 m3/h'],
    [
      'applies NFKC to the degree Celsius sign',
      'Design temperature 60 ℃',
      'Design temperature 60 °C',
    ],
    ['applies NFKC to fullwidth characters', 'Ｐ－１０１ ５００', 'P-101 500'],
    ['applies NFKC to ligatures', 'ﬁlter ﬂow', 'filter flow'],
    ['strips zero-width characters', 'Ra\u200Bted\u200C \u200Dflow\u2060\uFEFF', 'Rated flow'],
    ['strips soft hyphens', 'pres\u00ADsure', 'pressure'],
    ['unifies quote variants', '‘single’ ‚low‛ “double” „low‟', `'single' 'low' "double" "low"`],
    [
      'unifies dash and minus variants',
      'a‐b c‑d e‒f g–h i—j k―l m−n',
      'a-b c-d e-f g-h i-j k-l m-n',
    ],
    ['joins a word broken by a hyphen at a line end', 'centri-\nfugal pump', 'centrifugal pump'],
    ['joins across spaces, CRLF and indentation', 'centri-  \r\n   fugal', 'centrifugal'],
    ['joins a word broken by a dash variant', 'centri‐\nfugal', 'centrifugal'],
    [
      'keeps the hyphen between digits at a line end',
      'Rated speed 1450-\n1780 rpm',
      'Rated speed 1450- 1780 rpm',
    ],
    ['keeps a hyphen that is not at a line end', 'self-priming pump', 'self-priming pump'],
    ['keeps a hyphen before a digit on the next line', 'Model X-\n200', 'Model X- 200'],
    ['returns empty text for empty input', '', ''],
    ['returns empty text for whitespace only', ' \n\t\u00A0 ', ''],
  ])('%s', (_case, input, expected) => {
    expect(normalized(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normalized('  Rated\u00A0flow:  287.0 m³/h\n(1264 gpm) centri-\nfugal ﬁt \u200B');
    expect(normalized(once)).toBe(once);
  });
});

describe('normalizeWithMap: offset map', () => {
  it.each<[string, string, number[]]>([
    ['a space replacing a run maps to the run start', 'a  b', [0, 1, 3]],
    ['removed leading whitespace is skipped', '  ab', [2, 3]],
    ['an NFKC expansion shares its original offset', 'ﬁx', [0, 0, 1]],
    [
      'a joined word maps across the removed hyphen and break',
      'centri-\nfugal',
      [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12],
    ],
    ['a removed zero-width character is skipped', 'Ra\u200Bted', [0, 1, 3, 4, 5]],
    ['offsets count UTF-16 code units of the original', '\u{1D7D3}0', [0, 2]],
  ])('%s', (_case, input, map) => {
    expect(normalizeWithMap(input).map).toEqual(map);
  });

  it('has one entry per normalized character, never decreasing, inside the original', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...ALPHABET), maxLength: 60 }), (text) => {
        const { normalized: out, map } = normalizeWithMap(text);
        expect(map).toHaveLength(out.length);
        map.forEach((offset, index) => {
          expect(offset).toBeGreaterThanOrEqual(0);
          expect(offset).toBeLessThan(text.length);
          if (index > 0) expect(offset).toBeGreaterThanOrEqual(map[index - 1] ?? 0);
        });
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });

  // Slicing the original between two mapped offsets and normalizing the slice gives the same text
  // as slicing the normalized string, for ranges that start and end on whole characters (not
  // inside an NFKC expansion) and not on a collapsed space. This is what quote highlighting needs.
  it('maps every whole-character range back to an original slice that normalizes to it', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...ALPHABET), minLength: 1, maxLength: 60 }),
        fc.nat(),
        fc.nat(),
        (text, a, b) => {
          const { normalized: out, map } = normalizeWithMap(text);
          if (out.length === 0) return;
          const i = a % out.length;
          const j = i + 1 + (b % (out.length - i));
          const startsWhole = i === 0 || map[i] !== map[i - 1];
          const endsWhole = j === out.length || map[j] !== map[j - 1];
          if (!startsWhole || !endsWhole || out[i] === ' ' || out[j - 1] === ' ') return;
          const end = j === out.length ? text.length : (map[j] ?? text.length);
          expect(normalized(text.slice(map[i], end))).toBe(out.slice(i, j));
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 500 },
    );
  });
});

// Characters the property tests draw from: plain text and every kind of change the normalizer
// makes except dashes. Dashes become "-", and "-" before a line break joins the words around it,
// so a slice could cut the context the join depends on; word joining and dash unification are
// covered by the examples above.
const ALPHABET = [
  'a',
  'b',
  'R',
  'z',
  '0',
  '5',
  '9',
  '.',
  ',',
  ':',
  '(',
  ')',
  '%',
  '/',
  ' ',
  ' ',
  '\t',
  '\n',
  '\u00A0',
  '\u200B',
  '\uFEFF',
  '\u00AD',
  'ﬁ',
  'ﬃ',
  '³',
  '５',
  '℃',
  '“',
  '”',
  '’',
];
