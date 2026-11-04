import type { RegisterItemValues } from '@specledger/core';

export interface ExportableVersion {
  readonly number: number;
  readonly approvedBy: string;
  readonly publishedAt: Date;
  readonly items: readonly { readonly tag: string; readonly values: RegisterItemValues }[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sortedItems(version: ExportableVersion) {
  return [...version.items]
    .sort((a, b) => byText(a.tag, b.tag))
    .map((item) => ({
      tag: item.tag,
      fields: Object.keys(item.values)
        .sort(byText)
        .map((name) => ({ name, ...(item.values[name] ?? { value: '', unit: '' }) })),
    }));
}

// The register version as JSON: items sorted by tag, fields by name, two-space indentation and a
// trailing newline, so the same version always exports to the same bytes.
export function exportRegisterJson(version: ExportableVersion): string {
  const items = sortedItems(version).map((item) => ({
    tag: item.tag,
    values: Object.fromEntries(item.fields.map((f) => [f.name, { value: f.value, unit: f.unit }])),
  }));
  const document = {
    version: version.number,
    approvedBy: version.approvedBy,
    publishedAt: version.publishedAt.toISOString(),
    items,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// A spreadsheet runs a cell as a formula when it starts with one of these; a leading "-" is safe
// only when the whole cell is a plain number.
const FORMULA_START = /^[=+@\t\r]/;
const PLAIN_NUMBER = /^-\d+(?:[.,]\d+)?$/;

function cell(text: string): string {
  const safe =
    FORMULA_START.test(text) || (text.startsWith('-') && !PLAIN_NUMBER.test(text))
      ? `'${text}`
      : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

// The register version as CSV (RFC 4180): a header "tag,field,value,unit", one row per field,
// sorted by tag then field, CRLF line ends. A cell that a spreadsheet would run as a formula
// (starting with =, +, @, a tab, a carriage return, or a "-" that does not begin a plain number) is
// prefixed with a single quote; cells with commas, quotes or line breaks are quoted.
export function exportRegisterCsv(version: ExportableVersion): string {
  const rows = [['tag', 'field', 'value', 'unit']];
  for (const item of sortedItems(version)) {
    for (const field of item.fields) rows.push([item.tag, field.name, field.value, field.unit]);
  }
  return rows.map((row) => `${row.map(cell).join(',')}\r\n`).join('');
}

// ---- Phase 10 stubs --------------------------------------------------------------------------
import { notImplemented } from './not-implemented.js';
export const REGISTER_JSON_SCHEMA_VERSION = 1;
export interface RegisterExporter {
  readonly format: 'csv' | 'json';
  readonly contentType: string;
  readonly extension: string;
  render(version: ExportableVersion): string;
}
export const csvExporter: RegisterExporter = {
  format: 'csv',
  contentType: '',
  extension: '',
  render: (v) => notImplemented('csvExporter', v),
};
export const jsonExporter: RegisterExporter = {
  format: 'json',
  contentType: '',
  extension: '',
  render: (v) => notImplemented('jsonExporter', v),
};
export function exporterFor(format: 'csv' | 'json'): RegisterExporter {
  return notImplemented('exporterFor', format);
}
export type VerifyError =
  'INVALID_JSON' | 'INVALID_SHAPE' | 'UNSUPPORTED_SCHEMA_VERSION' | 'HASH_MISMATCH';
export function verifyRegisterJson(
  text: string,
): { ok: true; value: { version: number } } | { ok: false; error: VerifyError } {
  return notImplemented('verifyRegisterJson', text);
}
