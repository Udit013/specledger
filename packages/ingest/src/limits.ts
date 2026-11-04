// Limits applied to every upload. The API reads them from configuration (INGEST_* variables,
// documented in .env.example); these defaults are what it uses when a variable is unset.
export interface IngestLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  // Wall-clock limit for one extraction, worker start-up included.
  readonly parseTimeoutMs: number;
  // Memory budget of the extraction worker: its V8 heap limit, and the limit a watchdog applies to
  // heap plus decoded-stream buffers (ArrayBuffers outside the heap).
  readonly parseMemoryMb: number;
  // Below this many non-whitespace characters in the whole document, it has no text layer.
  readonly minTextChars: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 50,
  parseTimeoutMs: 15_000,
  parseMemoryMb: 256,
  minTextChars: 20,
});

// Bounds a configured limit must fall inside, so a typo cannot switch a limit off.
export const INGEST_LIMIT_BOUNDS: Readonly<
  Record<keyof IngestLimits, { readonly min: number; readonly max: number }>
> = Object.freeze({
  maxBytes: { min: 1024, max: 100 * 1024 * 1024 },
  maxPages: { min: 1, max: 1000 },
  parseTimeoutMs: { min: 100, max: 120_000 },
  parseMemoryMb: { min: 32, max: 2048 },
  minTextChars: { min: 1, max: 10_000 },
});
