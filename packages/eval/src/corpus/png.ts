import { crc32, deflateSync } from 'node:zlib';

// Minimal 8-bit grayscale PNG encoder, enough to give the scanned-style document a raster page.
export function encodeGrayscalePng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (pixels.length !== width * height) throw new Error('pixel buffer does not match dimensions');
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // Filter type 0 (none) at the start of every row.
    raw[y * (width + 1)] = 0;
    Buffer.from(pixels.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
