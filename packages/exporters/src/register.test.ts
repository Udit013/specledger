import { describe, expect, it } from 'vitest';

import { exportRegisterCsv, exportRegisterJson } from './register.js';
import type { ExportableVersion } from './register.js';

const VERSION: ExportableVersion = {
  number: 3,
  approvedBy: 'role:approver',
  publishedAt: new Date('2030-01-02T03:04:05.000Z'),
  items: [
    {
      tag: 'P-102',
      values: {
        rated_head: { value: '45', unit: 'm' },
        rated_flow: { value: '287.0', unit: 'm3/h' },
      },
    },
    { tag: 'M-201', values: { rated_power: { value: '45.0', unit: 'kW' } } },
  ],
};

describe('exportRegisterJson', () => {
  it('writes a deterministic document, sorted by tag and field', () => {
    expect(exportRegisterJson(VERSION)).toBe(
      `${JSON.stringify(
        {
          version: 3,
          approvedBy: 'role:approver',
          publishedAt: '2030-01-02T03:04:05.000Z',
          items: [
            { tag: 'M-201', values: { rated_power: { value: '45.0', unit: 'kW' } } },
            {
              tag: 'P-102',
              values: {
                rated_flow: { value: '287.0', unit: 'm3/h' },
                rated_head: { value: '45', unit: 'm' },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it('gives the same bytes for the same version, whatever the input order', () => {
    const reordered = { ...VERSION, items: [...VERSION.items].reverse() };
    expect(exportRegisterJson(reordered)).toBe(exportRegisterJson(VERSION));
  });
});

describe('exportRegisterCsv', () => {
  it('writes one sorted row per field with CRLF line ends', () => {
    expect(exportRegisterCsv(VERSION)).toBe(
      [
        'tag,field,value,unit',
        'M-201,rated_power,45.0,kW',
        'P-102,rated_flow,287.0,m3/h',
        'P-102,rated_head,45,m',
        '',
      ].join('\r\n'),
    );
  });

  it.each([
    ['=HYPERLINK("http://evil")', `"'=HYPERLINK(""http://evil"")"`],
    ['+cmd|calc', "'+cmd|calc"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['-1+cmd', "'-1+cmd"],
    ['\tTAB', "'\tTAB"],
    ['\rCR', `"'\rCR"`],
  ])('neutralizes a formula-like cell %j', (hostile, cell) => {
    const csv = exportRegisterCsv({
      ...VERSION,
      items: [{ tag: hostile, values: { rated_head: { value: '1', unit: 'm' } } }],
    });
    expect(csv.split('\r\n')[1]).toBe(`${cell},rated_head,1,m`);
  });

  it('leaves plain negative numbers alone', () => {
    const csv = exportRegisterCsv({
      ...VERSION,
      items: [{ tag: 'T-1', values: { design_temperature: { value: '-20', unit: '°C' } } }],
    });
    expect(csv.split('\r\n')[1]).toBe('T-1,design_temperature,-20,°C');
  });

  it('quotes cells with commas, quotes and line breaks', () => {
    const csv = exportRegisterCsv({
      ...VERSION,
      items: [{ tag: 'P "1", A\nB', values: { rated_head: { value: '1,5', unit: 'm' } } }],
    });
    expect(csv.split('\r\n').slice(1).join('\r\n')).toBe('"P ""1"", A\nB",rated_head,"1,5",m\r\n');
  });
});
