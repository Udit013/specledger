import { Worker } from 'node:worker_threads';

import { err, ok } from '@specledger/core';
import type { Result } from '@specledger/core';

import { ingestError } from './errors.js';
import type { IngestError } from './errors.js';
import { DEFAULT_INGEST_LIMITS } from './limits.js';
import type { IngestLimits } from './limits.js';
import { WORKER_KIND, workerReplySchema } from './worker-protocol.js';
import type { WorkerRequest } from './worker-protocol.js';

export interface ExtractedPage {
  readonly pageNumber: number;
  readonly text: string;
  // Unicode code points, the unit Postgres char_length counts.
  readonly charCount: number;
}

export interface ExtractedDocument {
  readonly pages: readonly ExtractedPage[];
}

// The seam ingestDocument depends on. The production implementation parses in a worker thread;
// tests can supply their own.
export interface PageExtractor {
  extract(bytes: Uint8Array, limits: IngestLimits): Promise<Result<ExtractedDocument, IngestError>>;
}

export interface WorkerExtractorOptions {
  // The worker module to run. Defaults to extract-worker; tests pass a worker that never returns.
  readonly workerUrl?: URL;
}

// From source (tests) the worker runs as .ts through Node's type stripping; from dist it is .js.
const DEFAULT_WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './extract-worker.ts' : './extract-worker.js',
  import.meta.url,
);

type Outcome =
  | { readonly kind: 'reply'; readonly reply: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'out_of_memory' }
  | { readonly kind: 'crashed' };

function isOutOfMemory(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_WORKER_OUT_OF_MEMORY'
  );
}

// Starts one worker per document and always ends it: on a reply, an error, an early exit or the
// time limit. The promise settles only after the thread has stopped, so a parser stuck in a loop
// is gone by the time the caller sees PARSE_TIMEOUT.
function runWorker(workerUrl: URL, bytes: Uint8Array, limits: IngestLimits): Promise<Outcome> {
  return new Promise((resolve) => {
    const request: WorkerRequest = { kind: WORKER_KIND, bytes, maxPages: limits.maxPages };
    const worker = new Worker(workerUrl, {
      workerData: request,
      resourceLimits: {
        maxOldGenerationSizeMb: limits.parseMemoryMb,
        maxYoungGenerationSizeMb: Math.min(32, limits.parseMemoryMb),
        stackSizeMb: 4,
      },
      // The parser sees no environment variables (no DATABASE_URL) and inherits no Node flags.
      env: {},
      execArgv: [],
      // Captured and discarded: parser warnings could quote document content.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();

    let settled = false;
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().finally(() => {
        resolve(outcome);
      });
    };
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' });
    }, limits.parseTimeoutMs);
    worker.once('message', (reply: unknown) => {
      finish({ kind: 'reply', reply });
    });
    worker.once('error', (error: unknown) => {
      finish(isOutOfMemory(error) ? { kind: 'out_of_memory' } : { kind: 'crashed' });
    });
    worker.once('exit', () => {
      finish({ kind: 'crashed' });
    });
  });
}

const nonWhitespaceLength = (text: string) => text.replace(/\s/gu, '').length;

function toDocument(
  outcome: Outcome,
  limits: IngestLimits,
): Result<ExtractedDocument, IngestError> {
  switch (outcome.kind) {
    case 'timeout':
      return err(ingestError('PARSE_TIMEOUT', { limit: limits.parseTimeoutMs }));
    case 'out_of_memory':
      return err(ingestError('RESOURCE_LIMIT', { limit: limits.parseMemoryMb }));
    case 'crashed':
      return err(ingestError('CORRUPT'));
    case 'reply':
      break;
  }
  const parsed = workerReplySchema.safeParse(outcome.reply);
  if (!parsed.success) return err(ingestError('CORRUPT'));
  const reply = parsed.data;
  if (!reply.ok) {
    return reply.code === 'TOO_MANY_PAGES'
      ? err(ingestError('TOO_MANY_PAGES', { limit: limits.maxPages, actual: reply.pageCount }))
      : err(ingestError(reply.code));
  }
  if (reply.pages.length === 0 || reply.pages.length > limits.maxPages) {
    return err(ingestError('CORRUPT'));
  }
  const textChars = reply.pages.reduce((sum, text) => sum + nonWhitespaceLength(text), 0);
  if (textChars < limits.minTextChars) {
    return err(ingestError('NO_TEXT_LAYER', { limit: limits.minTextChars, actual: textChars }));
  }
  return ok({
    pages: reply.pages.map((text, index) => ({
      pageNumber: index + 1,
      text,
      charCount: Array.from(text).length,
    })),
  });
}

export function createWorkerExtractor(options: WorkerExtractorOptions = {}): PageExtractor {
  const workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;
  return {
    async extract(bytes, limits) {
      return toDocument(await runWorker(workerUrl, bytes, limits), limits);
    },
  };
}

export interface ExtractPagesOptions extends WorkerExtractorOptions {
  readonly limits?: IngestLimits;
}

// Per-page text and character counts, or the reason the document cannot be read.
export function extractPages(
  bytes: Uint8Array,
  options: ExtractPagesOptions = {},
): Promise<Result<ExtractedDocument, IngestError>> {
  return createWorkerExtractor(options).extract(bytes, options.limits ?? DEFAULT_INGEST_LIMITS);
}
