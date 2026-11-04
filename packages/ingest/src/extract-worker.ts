// Runs inside a worker thread started by extractor.ts, with a memory limit, an empty environment
// and a hard time limit enforced by the parent. Everything here treats the bytes as hostile.
//
// Tests run this file from source through Node's type stripping, which cannot follow relative
// imports to other .ts files. So this module imports only packages, and relative imports are
// type-only (erased).
import { Buffer } from 'node:buffer';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { assemblePageText } from '@specledger/core';
import type { PositionedText } from '@specledger/core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { WorkerReply, WorkerRequest } from './worker-protocol.js';

const KIND: WorkerRequest['kind'] = 'specledger-extract';
// startxref and %%EOF must be inside this many bytes from the end of the file.
const TAIL_BYTES = 1024;
// Incremental updates chain cross-reference sections through /Prev; more than this is refused.
const MAX_SECTIONS = 32;

const latin1 = (buffer: Buffer, start: number, end?: number) =>
  buffer.toString('latin1', start, end);

function objectAt(buffer: Buffer, offset: number, number: number, generation: number): boolean {
  return new RegExp(`^${String(number)}\\s+${String(generation)}\\s+obj\\b`).test(
    latin1(buffer, offset, offset + 32),
  );
}

// A classic table: subsections of "first count" followed by 20-byte entries, then the trailer.
// Every in-use entry must point at the header of the object it names.
function readTable(buffer: Buffer, start: number): { prev: number | null } | null {
  const text = latin1(buffer, start);
  const subsection = /\s*(\d+)\s+(\d+)[^\S\r\n]*\r?\n/y;
  const entry = /(\d{10}) (\d{5}) ([fn])(?: ?\r\n| ?\n| ?\r)/y;
  let position = 0;
  for (;;) {
    subsection.lastIndex = position;
    const head = subsection.exec(text);
    if (head === null) break;
    position = subsection.lastIndex;
    const first = Number(head[1]);
    const count = Number(head[2]);
    for (let index = 0; index < count; index += 1) {
      entry.lastIndex = position;
      const found = entry.exec(text);
      if (found === null) return null;
      position = entry.lastIndex;
      if (
        found[3] === 'n' &&
        !objectAt(buffer, Number(found[1]), first + index, Number(found[2]))
      ) {
        return null;
      }
    }
  }
  const trailer = /\s*trailer\b/y;
  trailer.lastIndex = position;
  if (!trailer.test(text)) return null;
  return { prev: prevOffset(text.slice(trailer.lastIndex, trailer.lastIndex + 4096)) };
}

function prevOffset(dictionary: string): number | null {
  const end = dictionary.search(/startxref|stream/);
  const prev = /\/Prev\s+(\d+)/.exec(end === -1 ? dictionary : dictionary.slice(0, end));
  return prev?.[1] === undefined ? null : Number(prev[1]);
}

// pdfjs silently rebuilds a damaged cross-reference table by scanning the whole file, so a file
// with one would otherwise be accepted. This check follows startxref and every /Prev section, and
// requires each to be a cross-reference table whose entries point at real object headers, or a
// cross-reference stream object. (The entries inside a compressed stream are not checked.)
export function hasValidCrossReference(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tail = latin1(buffer, Math.max(0, buffer.length - TAIL_BYTES));
  const match = /startxref\s+(\d+)\s+%%EOF[\s\0]*$/.exec(tail);
  if (match?.[1] === undefined) return false;
  const seen = new Set<number>();
  let offset: number | null = Number(match[1]);
  while (offset !== null) {
    if (seen.has(offset) || seen.size >= MAX_SECTIONS || offset >= buffer.length) return false;
    seen.add(offset);
    const head = latin1(buffer, offset, offset + 64);
    if (head.startsWith('xref')) {
      const section = readTable(buffer, offset + 4);
      if (section === null) return false;
      offset = section.prev;
    } else if (/^\d+\s+\d+\s+obj\b/.test(head)) {
      offset = prevOffset(latin1(buffer, offset, offset + 4096));
    } else {
      return false;
    }
  }
  return true;
}

function isPasswordError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'PasswordException'
  );
}

export async function extractInWorker(bytes: Uint8Array, maxPages: number): Promise<WorkerReply> {
  if (!hasValidCrossReference(bytes)) return { ok: false, code: 'CORRUPT' };
  const task = getDocument({
    data: new Uint8Array(bytes),
    enableXfa: false,
    stopAtErrors: true,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    let pdf;
    try {
      pdf = await task.promise;
    } catch (error: unknown) {
      return { ok: false, code: isPasswordError(error) ? 'ENCRYPTED' : 'CORRUPT' };
    }
    // Checked before any page is read, so a document with thousands of pages costs nothing more.
    if (pdf.numPages > maxPages) {
      return { ok: false, code: 'TOO_MANY_PAGES', pageCount: pdf.numPages };
    }
    // Permissions exist only on encrypted files, including those that open without a password.
    if ((await pdf.getPermissions()) !== null) return { ok: false, code: 'ENCRYPTED' };
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const content = await (await pdf.getPage(number)).getTextContent();
      const items: PositionedText[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const [, , , , x, y] = item.transform as number[];
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        items.push({ text: item.str, x, y, width: item.width });
      }
      pages.push(assemblePageText(items));
    }
    return { ok: true, pages };
  } catch {
    return { ok: false, code: 'CORRUPT' };
  } finally {
    await task.destroy();
  }
}

function isRequest(value: unknown): value is WorkerRequest {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === KIND;
}

// Only when started as an extraction worker; importing this module elsewhere (tests) does nothing.
const request: unknown = workerData;
const port = parentPort;
if (!isMainThread && port !== null && isRequest(request)) {
  void extractInWorker(request.bytes, request.maxPages).then((reply) => {
    port.postMessage(reply);
  });
}
