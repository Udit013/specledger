import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  csvExporter,
  exporterFor,
  exportRegisterCsv,
  exportRegisterJson,
  jsonExporter,
  REGISTER_JSON_SCHEMA_VERSION,
  verifyRegisterJson,
} from './register.js';
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
  it('writes a deterministic document with its schema version and content hash', () => {
    const content = {
      schemaVersion: 1,
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
    };
    // The hash covers the compact JSON of everything but itself, in this key order.
    const hash = createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');
    const { schemaVersion, ...rest } = content;
    expect(exportRegisterJson(VERSION)).toBe(
      `${JSON.stringify({ schemaVersion, contentSha256: hash, ...rest }, null, 2)}\n`,
    );
    expect(REGISTER_JSON_SCHEMA_VERSION).toBe(1);
  });

  it('sorts items by tag and fields by name', () => {
    expect(JSON.parse(exportRegisterJson(VERSION))).toMatchObject({
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
    });
  });

  it('verifies its own output and detects any change to the content', () => {
    const json = exportRegisterJson(VERSION);
    expect(verifyRegisterJson(json)).toMatchObject({ ok: true, value: { version: 3 } });
    expect(verifyRegisterJson(json.replace('"45.0"', '"46.0"'))).toEqual({
      ok: false,
      error: 'HASH_MISMATCH',
    });
    expect(verifyRegisterJson(json.replace('"schemaVersion": 1', '"schemaVersion": 2'))).toEqual({
      ok: false,
      error: 'UNSUPPORTED_SCHEMA_VERSION',
    });
    expect(verifyRegisterJson('{not json')).toEqual({ ok: false, error: 'INVALID_JSON' });
    expect(verifyRegisterJson('{"schemaVersion": 1}')).toEqual({
      ok: false,
      error: 'INVALID_SHAPE',
    });
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

describe('register exporters', () => {
  it('name their format, content type and file extension', () => {
    expect([csvExporter, jsonExporter].map((e) => [e.format, e.contentType, e.extension])).toEqual([
      ['csv', 'text/csv; charset=utf-8', 'csv'],
      ['json', 'application/json; charset=utf-8', 'json'],
    ]);
    expect(exporterFor('csv')).toBe(csvExporter);
    expect(exporterFor('json')).toBe(jsonExporter);
    expect(csvExporter.render(VERSION)).toBe(exportRegisterCsv(VERSION));
  });
});

// Golden files: reviewed by hand, never regenerated by the code under test.
const golden = (name: string) =>
  readFileSync(new URL(`../test/golden/${name}`, import.meta.url), 'utf8');

const HOSTILE: ExportableVersion = {
  number: 7,
  approvedBy: 'role:approver',
  publishedAt: new Date('2031-05-06T07:08:09.000Z'),
  items: [
    {
      tag: 'P-1',
      values: {
        rated_head: { value: '=HYPERLINK("http://evil.example","x")', unit: 'm' },
        suction_temp: { value: '-12.5', unit: '°C' },
        note: { value: 'a, "b"\nc', unit: '-' },
      },
    },
    { tag: 'M-9', values: { rated_power: { value: '75', unit: 'kW' } } },
  ],
};

describe('golden files', () => {
  it('matches the reviewed CSV byte for byte', () => {
    expect(exportRegisterCsv(HOSTILE)).toBe(golden('register-v7.csv'));
  });

  it('matches the reviewed JSON byte for byte', () => {
    expect(exportRegisterJson(HOSTILE)).toBe(golden('register-v7.json'));
  });
});

describe('formula injection', () => {
  it.each([
    ['=HYPERLINK("http://evil.example")', true],
    ['=1+1', true],
    ['+1', true],
    ['@SUM(A1:A2)', true],
    ['-cmd', true],
    ['-1+2', true],
    ['\t=1', true],
    ['\r=1', true],
    ['-12.5', false],
    ['-12', false],
    ['-0,5', false],
    ['12.5', false],
    ['1450-1780', false],
    ['m3/h', false],
    ['', false],
  ])('value %j is prefixed: %s', (value, prefixed) => {
    const csv = exportRegisterCsv({
      ...VERSION,
      items: [{ tag: 'P-1', values: { rated_head: { value, unit: 'm' } } }],
    });
    const cellText = (csv.split('\r\n').slice(1).join('\r\n').split(',')[2] ?? '').replace(
      /^"/,
      '',
    );
    expect(cellText.startsWith("'")).toBe(prefixed);
  });
});
