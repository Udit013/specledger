import { createHash } from 'node:crypto';

import type { ExtractionRequest } from './types.js';

// JSON with object keys sorted at every level, so two equal requests serialize identically no
// matter how their objects were built. Array order is kept: it is meaningful (pages, fields).
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

// The recording a request replays from. It covers the model id and the whole request, which
// includes the prompt version, so a new prompt or model never replays an old answer.
export function replayKey(request: ExtractionRequest, modelId: string): string {
  return createHash('sha256').update(canonicalJson({ modelId, request })).digest('hex');
}
