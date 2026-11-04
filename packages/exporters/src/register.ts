import type { RegisterItemValues } from '@specledger/core';

import { notImplemented } from './not-implemented.js';

export interface ExportableVersion {
  readonly number: number;
  readonly approvedBy: string;
  readonly publishedAt: Date;
  readonly items: readonly { readonly tag: string; readonly values: RegisterItemValues }[];
}

// The register version as JSON: items sorted by tag, fields by name, two-space indentation and a
// trailing newline, so the same version always exports to the same bytes.
export function exportRegisterJson(version: ExportableVersion): string {
  return notImplemented('exportRegisterJson', version);
}

// The register version as CSV (RFC 4180): a header "tag,field,value,unit", one row per field,
// sorted by tag then field, CRLF line ends. A cell that a spreadsheet would run as a formula
// (starting with =, +, @, a tab, a carriage return, or a "-" that does not begin a plain number) is
// prefixed with a single quote; cells with commas, quotes or line breaks are quoted.
export function exportRegisterCsv(version: ExportableVersion): string {
  return notImplemented('exportRegisterCsv', version);
}
