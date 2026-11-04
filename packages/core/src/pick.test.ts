import { describe, expect, it } from 'vitest';

import type { Candidate } from './candidate.js';
import { pickFields } from './pick.js';
import type { VerifiedCandidate } from './pick.js';
import type { VerificationResult } from './verifier.js';

const verdict = (verified: boolean): VerificationResult => ({
  status: verified ? 'verified' : 'unverified',
  reasons: verified ? [] : ['QUOTE_NOT_FOUND'],
  normalizedValue: null,
  quoteSpan: null,
});

const entry = (fieldName: string, value: string, verified: boolean): VerifiedCandidate => {
  const candidate: Candidate = {
    fieldName,
    value,
    unit: 'm',
    quote: `${fieldName} ${value} m`,
    page: 1,
  };
  return { candidate, verdict: verdict(verified) };
};

describe('pickFields', () => {
  it('keeps one candidate per field, sorted by field name', () => {
    const picked = pickFields([entry('rated_head', '45', true), entry('npsh_required', '3', true)]);
    expect(picked.map((p) => [p.candidate.fieldName, p.dropped])).toEqual([
      ['npsh_required', 0],
      ['rated_head', 0],
    ]);
  });

  it('prefers the first verified candidate over an earlier unverified one', () => {
    const picked = pickFields([
      entry('rated_head', '99', false),
      entry('rated_head', '45', true),
      entry('rated_head', '46', true),
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ candidate: { value: '45' }, dropped: 2 });
  });

  it('keeps the first candidate when none is verified', () => {
    const picked = pickFields([entry('rated_head', '99', false), entry('rated_head', '98', false)]);
    expect(picked[0]).toMatchObject({
      candidate: { value: '99' },
      verdict: { status: 'unverified' },
      dropped: 1,
    });
  });

  it('returns nothing for no candidates', () => {
    expect(pickFields([])).toEqual([]);
  });
});
