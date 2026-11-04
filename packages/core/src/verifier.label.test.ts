import { describe, expect, it } from 'vitest';

import { FIELD_DEFINITIONS } from './equipment.js';
import { labelOwnerBefore } from './labels.js';
import { verifyCandidate } from './verifier.js';

const pump = (name: string) => {
  const field = FIELD_DEFINITIONS.centrifugal_pump.find((f) => f.name === name);
  if (field === undefined) throw new Error(name);
  return field;
};

const verify = (fieldName: string, value: string, unit: string, quote: string, page = quote) =>
  verifyCandidate({ fieldName, value, unit, quote, page: 1 }, page, pump(fieldName));

// (g) The value must be stated under a label of its own field. Before this rule, a value from
// another field's line with a unit of the same quantity verified: "NPSH required 14 ft" supported
// a rated head of 14 ft.
describe('verifyCandidate: (g) LABEL_MISMATCH', () => {
  it('rejects a head taken from the NPSH line', () => {
    expect(verify('rated_head', '14', 'ft', 'NPSH required 14 ft').reasons).toEqual([
      'LABEL_MISMATCH',
    ]);
  });

  it('rejects a rated value taken from a maximum', () => {
    expect(verify('rated_flow', '2400', 'gpm', 'Maximum flow: 2400 gpm').reasons).toEqual([
      'LABEL_MISMATCH',
    ]);
    expect(verify('rated_head', '310', 'ft', 'Max. head 310 ft').reasons).toEqual([
      'LABEL_MISMATCH',
    ]);
  });

  it('rejects a value with no field label at all', () => {
    expect(verify('rated_head', '45', 'm', 'The pump delivers 45 m reliably').reasons).toEqual([
      'LABEL_MISMATCH',
    ]);
  });

  it('prefers the longest label: "suction head" belongs to NPSH, not to head', () => {
    const quote = 'Net positive suction head required 5.2 m';
    expect(verify('npsh_required', '5.2', 'm', quote).status).toBe('verified');
    expect(verify('rated_head', '5.2', 'm', quote).reasons).toEqual(['LABEL_MISMATCH']);
  });

  it('reads each value under the label nearest before it in a multi-value quote', () => {
    const quote = 'Rated head 260 ft, NPSH required 14 ft';
    expect(verify('rated_head', '260', 'ft', quote).status).toBe('verified');
    expect(verify('npsh_required', '14', 'ft', quote).status).toBe('verified');
    expect(verify('rated_head', '14', 'ft', quote).reasons).toEqual(['LABEL_MISMATCH']);
  });

  it('accepts the usual synonyms and spellings', () => {
    for (const [field, value, unit, quote] of [
      ['rated_head', '85', 'm', 'Total dynamic head (TDH): 85 m'],
      ['rated_head', '85', 'm', 'Head at duty point 85 m'],
      ['rated_flow', '120', 'm3/h', 'Capacity 120 m3/h'],
      ['npsh_required', '3.1', 'm', 'Pump NPSHr: 3.1 m'],
      ['max_working_pressure', '16', 'bar', 'Maximum allowable working pressure 16 bar'],
      ['efficiency', '78', '%', 'Pump efficiency: 78 %'],
      ['rated_flow', '287.0', 'm³/h', 'RATED FLOW: 287.0 m³/h'],
    ] as const) {
      expect(verify(field, value, unit, quote).status, `${field} ${quote}`).toBe('verified');
    }
  });

  it('accepts the value when any one occurrence sits under its own label', () => {
    const quote = 'Rated flow 500 gpm; maximum flow 500 gpm at shut-off';
    expect(verify('rated_flow', '500', 'gpm', quote).status).toBe('verified');
  });

  it('is reported with the other reasons, after them', () => {
    expect(verify('rated_head', '14', 'ft', 'NPSH required 14 ft', 'other page').reasons).toEqual([
      'QUOTE_NOT_FOUND',
      'LABEL_MISMATCH',
    ]);
  });
});

describe('labelOwnerBefore', () => {
  const owner = (quote: string, at: number) => labelOwnerBefore(quote.toLowerCase(), at);

  it('names the field of the nearest label, "other" for another quantity, null for none', () => {
    expect(owner('rated head 260 ft', 11)).toBe('rated_head');
    expect(owner('maximum flow 2400 gpm', 13)).toBe('other');
    expect(owner('the pump delivers 45 m', 18)).toBeNull();
  });

  it('matches whole words only', () => {
    expect(owner('overhead 12 m', 9)).toBeNull();
    expect(owner('flowmeter 12 gpm', 10)).toBeNull();
  });
});
