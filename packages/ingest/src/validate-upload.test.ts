import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { buildPdf } from '../test/support/pdfs.js';
import { ingestError } from './errors.js';
import { displayFilename, MAX_FILENAME_LENGTH, validateUpload } from './validate-upload.js';
import type { UploadMeta } from './validate-upload.js';

const pdf = buildPdf();
const LIMITS = { maxBytes: 4096 };
const META: UploadMeta = { filename: 'P-101.pdf', documentType: 'datasheet', revision: 'Rev A' };

describe('validateUpload', () => {
  it.each<[string, Uint8Array, ReturnType<typeof ingestError>]>([
    ['empty input', new Uint8Array(0), ingestError('EMPTY')],
    ['plain text', Buffer.from('Rated flow: 500 gpm'), ingestError('NOT_A_PDF')],
    ['a truncated magic number', Buffer.from('%PDF'), ingestError('NOT_A_PDF')],
    ['the magic number in lower case', Buffer.from('%pdf-1.7\n'), ingestError('NOT_A_PDF')],
    ['a ZIP archive', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), ingestError('NOT_A_PDF')],
    [
      'one byte over the limit',
      Buffer.alloc(4097, 0x25),
      ingestError('TOO_LARGE', { limit: 4096, actual: 4097 }),
    ],
  ])('rejects %s', (_case, bytes, expected) => {
    expect(validateUpload(bytes, META, LIMITS)).toEqual({ ok: false, error: expected });
  });

  it('accepts a file exactly at the size limit', () => {
    const atLimit = Buffer.concat([pdf, Buffer.alloc(LIMITS.maxBytes - pdf.length, 0x20)]);
    expect(validateUpload(atLimit, META, LIMITS).ok).toBe(true);
  });

  it('decides by the bytes, never by the declared content type or file name', () => {
    const text = Buffer.from('not a pdf');
    expect(
      validateUpload(
        text,
        { ...META, filename: 'datasheet.pdf', contentType: 'application/pdf' },
        LIMITS,
      ),
    ).toEqual({ ok: false, error: ingestError('NOT_A_PDF') });
    expect(
      validateUpload(pdf, { ...META, filename: 'notes.txt', contentType: 'text/plain' }, LIMITS).ok,
    ).toBe(true);
  });

  it('reports invalid metadata by field name only', () => {
    const result = validateUpload(
      pdf,
      { ...META, documentType: 'invoice' as UploadMeta['documentType'], revision: 'R'.repeat(33) },
      LIMITS,
    );
    expect(result).toEqual({
      ok: false,
      error: ingestError('INVALID_METADATA', { fields: ['documentType', 'revision'] }),
    });
    expect(JSON.stringify(result)).not.toContain('invoice');
  });

  it('returns the bytes untouched and a display name', () => {
    const result = validateUpload(pdf, { ...META, filename: '../../etc/passwd' }, LIMITS);
    expect(result).toEqual({
      ok: true,
      value: {
        bytes: pdf,
        displayFilename: '../../etc/passwd',
        documentType: 'datasheet',
        revision: 'Rev A',
      },
    });
  });
});

describe('displayFilename', () => {
  it.each([
    ['a path traversal attempt, kept as text', '../../etc/passwd', '../../etc/passwd'],
    [
      'a Windows path, kept as text',
      'C:\\Windows\\system32\\drivers',
      'C:\\Windows\\system32\\drivers',
    ],
    ['control characters', 'data\u0000sheet\r\n.pdf', 'datasheet.pdf'],
    ['a right-to-left override', 'invoice\u202Efdp.exe', 'invoicefdp.exe'],
    ['zero-width characters', 'P\u200B-101.pdf', 'P-101.pdf'],
    ['surrounding whitespace', '  P-101.pdf  ', 'P-101.pdf'],
    ['nothing left after cleaning', '\u0000\u202E  ', 'untitled.pdf'],
    [
      'decomposed accents, composed',
      'fiche-technique-pompe\u0301.pdf',
      'fiche-technique-pompé.pdf',
    ],
  ])('handles %s', (_case, raw, expected) => {
    expect(displayFilename(raw)).toBe(expected);
  });

  it('cuts long names to the column limit in code points, never splitting a character', () => {
    const name = displayFilename('🔧'.repeat(300));
    expect(Array.from(name)).toHaveLength(MAX_FILENAME_LENGTH);
    expect(name).toBe('🔧'.repeat(MAX_FILENAME_LENGTH));
  });
});
