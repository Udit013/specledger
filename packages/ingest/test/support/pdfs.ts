import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

// Handcrafted PDFs for the rejection matrix. They use a classic cross-reference table so tests can
// damage it precisely; the corpus PDFs (pdf-lib) use cross-reference streams instead.

export interface BuildOptions {
  // Text drawn on each page, one string per page.
  readonly pages?: readonly string[];
  readonly editXref?: (table: string) => string;
  readonly trailerExtra?: string;
  readonly header?: string;
}

const escapePdfString = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);

export function buildPdf(options: BuildOptions = {}): Buffer {
  const pages = options.pages ?? ['Rated flow: 500 gpm'];
  const fontId = 3 + pages.length * 2;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${String(3 + i * 2)} 0 R`).join(' ')}] /Count ${String(pages.length)} >>`,
  ];
  pages.forEach((text, index) => {
    const content = `BT /F1 12 Tf 72 720 Td (${escapePdfString(text)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${String(4 + index * 2)} 0 R ` +
        `/Resources << /Font << /F1 ${String(fontId)} 0 R >> >> >>`,
      `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`,
    );
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = `${options.header ?? '%PDF-1.4'}\n`;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  const table =
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out +=
    (options.editXref ?? ((t: string) => t))(table) +
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R ${options.trailerExtra ?? ''}>>\n` +
    `startxref\n${String(xrefAt)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// RC4, for the standard security handler (revision 2) only.
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (state[i] ?? 0) + (key[i % key.length] ?? 0)) & 255;
    [state[i], state[j]] = [state[j] ?? 0, state[i] ?? 0];
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 255;
    j = (j + (state[i] ?? 0)) & 255;
    [state[i], state[j]] = [state[j] ?? 0, state[i] ?? 0];
    out[k] = (data[k] ?? 0) ^ (state[((state[i] ?? 0) + (state[j] ?? 0)) & 255] ?? 0);
  }
  return out;
}

const PASSWORD_PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);
const FILE_ID = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

// Encrypted with an empty user password: it opens without a password, with restricted permissions.
// The page has no content stream, since its strings would also have to be encrypted.
export function ownerPasswordOnlyPdf(): Buffer {
  const owner = Buffer.alloc(32, 0x5a);
  const permissions = -44; // printing and copying not allowed
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const key = createHash('md5')
    .update(Buffer.concat([PASSWORD_PADDING, owner, p, FILE_ID]))
    .digest()
    .subarray(0, 5);
  const user = Buffer.from(rc4(key, PASSWORD_PADDING));
  return buildPdf({
    pages: [''],
    trailerExtra:
      `/Encrypt << /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> ` +
      `/U <${user.toString('hex')}> /P ${String(permissions)} >> ` +
      `/ID [<${FILE_ID.toString('hex')}> <${FILE_ID.toString('hex')}>] `,
  });
}

// Encrypted with a user password, so it cannot be opened without one.
export function userPasswordPdf(): Buffer {
  return buildPdf({
    trailerExtra:
      `/Encrypt << /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> ` +
      `/P -4 >> /ID [<${FILE_ID.toString('hex')}> <${FILE_ID.toString('hex')}>] `,
  });
}
