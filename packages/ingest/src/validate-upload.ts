import { documentTypeSchema, err, ok } from '@specledger/core';
import type { DocumentType, Result } from '@specledger/core';
import { z } from 'zod';

import { ingestError } from './errors.js';
import type { IngestError } from './errors.js';
import type { IngestLimits } from './limits.js';

// What the uploader tells us about the file. `filename` and `contentType` are claims by the client:
// neither decides whether the bytes are accepted, and the file name is kept for display only. No
// part of ingestion touches the file system, so a name cannot select a path.
export const uploadMetaSchema = z.strictObject({
  filename: z.string(),
  contentType: z.string().optional(),
  documentType: documentTypeSchema,
  revision: z.string().min(1).max(32).nullable(),
});
export type UploadMeta = z.input<typeof uploadMetaSchema>;

export interface ValidatedUpload {
  readonly bytes: Uint8Array;
  readonly displayFilename: string;
  readonly documentType: DocumentType;
  readonly revision: string | null;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
export const MAX_FILENAME_LENGTH = 255;
export const FALLBACK_FILENAME = 'untitled.pdf';

// Control and invisible formatting characters (including bidirectional overrides, which can make
// "fdp.exe" display as "exe.pdf") are removed; the result is trimmed and cut to the column limit.
// Nothing else changes: "../../etc/passwd" is kept as written, because it is only ever text.
export function displayFilename(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  const clipped = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join('').trimEnd();
  return clipped.length > 0 ? clipped : FALLBACK_FILENAME;
}

export function hasPdfMagic(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

// Cheap checks on the raw bytes, before anything parses them.
export function validateUpload(
  bytes: Uint8Array,
  meta: UploadMeta,
  limits: Pick<IngestLimits, 'maxBytes'>,
): Result<ValidatedUpload, IngestError> {
  if (bytes.byteLength === 0) return err(ingestError('EMPTY'));
  if (bytes.byteLength > limits.maxBytes) {
    return err(ingestError('TOO_LARGE', { limit: limits.maxBytes, actual: bytes.byteLength }));
  }
  if (!hasPdfMagic(bytes)) return err(ingestError('NOT_A_PDF'));

  const parsed = uploadMetaSchema.safeParse(meta);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    return err(ingestError('INVALID_METADATA', { fields }));
  }
  return ok({
    bytes,
    displayFilename: displayFilename(parsed.data.filename),
    documentType: parsed.data.documentType,
    revision: parsed.data.revision,
  });
}
