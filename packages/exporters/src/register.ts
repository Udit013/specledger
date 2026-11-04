import { createHash } from 'node:crypto';

import { registerItemValuesSchema } from '@specledger/core';
import type { RegisterItemValues } from '@specledger/core';
import { z } from 'zod';

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

// The JSON document's layout version. A consumer checks it before reading anything else; any
// change to the fields below is a new version.
export const REGISTER_JSON_SCHEMA_VERSION = 1;

function jsonContent(version: ExportableVersion) {
  return {
    schemaVersion: REGISTER_JSON_SCHEMA_VERSION,
    version: version.number,
    approvedBy: version.approvedBy,
    publishedAt: version.publishedAt.toISOString(),
    items: sortedItems(version).map((item) => ({
      tag: item.tag,
      values: Object.fromEntries(
        item.fields.map((f) => [f.name, { value: f.value, unit: f.unit }]),
      ),
    })),
  };
}

// SHA-256 over the compact JSON of the content in its fixed key order: schemaVersion, version,
// approvedBy, publishedAt, items. The hash itself is not part of what it covers.
const contentHash = (content: ReturnType<typeof jsonContent>) =>
  createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');

// The register version as JSON: a schema version, a content hash, then the version and its items
// sorted by tag with fields by name, two-space indentation and a trailing newline, so the same
// version always exports to the same bytes.
export function exportRegisterJson(version: ExportableVersion): string {
  const { schemaVersion, ...rest } = jsonContent(version);
  const document = { schemaVersion, contentSha256: contentHash(jsonContent(version)), ...rest };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const registerJsonSchema = z.strictObject({
  schemaVersion: z.number().int(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.number().int().min(1),
  approvedBy: z.string().min(1),
  publishedAt: z.iso.datetime({ offset: true }),
  items: z.array(z.strictObject({ tag: z.string().min(1), values: registerItemValuesSchema })),
});

export type VerifyError =
  'INVALID_JSON' | 'INVALID_SHAPE' | 'UNSUPPORTED_SCHEMA_VERSION' | 'HASH_MISMATCH';

// Checks an exported JSON document: its shape, its schema version, and that its content hash
// matches its content, so a consumer can tell an intact export from an edited one.
export function verifyRegisterJson(
  text: string,
): { ok: true; value: { version: number } } | { ok: false; error: VerifyError } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'INVALID_JSON' };
  }
  const schemaVersion = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof schemaVersion === 'number' && schemaVersion !== REGISTER_JSON_SCHEMA_VERSION) {
    return { ok: false, error: 'UNSUPPORTED_SCHEMA_VERSION' };
  }
  const parsed = registerJsonSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'INVALID_SHAPE' };
  const { contentSha256, ...content } = parsed.data;
  const expected = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: content.schemaVersion,
        version: content.version,
        approvedBy: content.approvedBy,
        publishedAt: content.publishedAt,
        items: content.items,
      }),
      'utf8',
    )
    .digest('hex');
  if (expected !== contentSha256) return { ok: false, error: 'HASH_MISMATCH' };
  return { ok: true, value: { version: content.version } };
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

// One export format of a published register version.
export interface RegisterExporter {
  readonly format: 'csv' | 'json';
  readonly contentType: string;
  readonly extension: string;
  render(version: ExportableVersion): string;
}

export const csvExporter: RegisterExporter = Object.freeze({
  format: 'csv',
  contentType: 'text/csv; charset=utf-8',
  extension: 'csv',
  render: exportRegisterCsv,
});

export const jsonExporter: RegisterExporter = Object.freeze({
  format: 'json',
  contentType: 'application/json; charset=utf-8',
  extension: 'json',
  render: exportRegisterJson,
});

export function exporterFor(format: 'csv' | 'json'): RegisterExporter {
  return format === 'csv' ? csvExporter : jsonExporter;
}
