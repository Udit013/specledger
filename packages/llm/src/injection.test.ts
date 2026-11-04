import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_GEMINI_MODEL } from './gemini.js';
import { createReplayProvider, recordingSchema } from './recordings.js';
import { replayKey } from './replay-key.js';

const RECORDINGS = new URL('../../../fixtures/recordings/', import.meta.url);
const recordings = readdirSync(RECORDINGS)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, text: readFileSync(new URL(name, RECORDINGS), 'utf8') }));

describe('committed recordings', () => {
  it('are valid, filed under their own key, and synthetic', () => {
    expect(recordings.length).toBeGreaterThan(0);
    for (const { name, text } of recordings) {
      const recording = recordingSchema.parse(JSON.parse(text));
      expect(name).toBe(`${recording.key}.json`);
      expect(replayKey(recording.request, recording.modelId)).toBe(recording.key);
      expect(recording.request.synthetic).toBe(true);
    }
  });

  it('contain no API key', () => {
    for (const { name, text } of recordings) {
      // Google API keys, bearer tokens and common secret-looking fields.
      expect(text, name).not.toMatch(
        /AIza[0-9A-Za-z_-]{35}|Bearer\s+\S+|api[_-]?key|x-goog-api-key/i,
      );
    }
  });
});

// The model is not trusted, and the provider is not the defense: a response that obeys the
// instruction embedded in p-108 comes back exactly as recorded. Rejecting it is the verifier's
// job (Phase 5): its quote is on the page, but no number in it supports the value 9999.
describe('injection recording', () => {
  const injection = recordings
    .map(({ text }) => recordingSchema.parse(JSON.parse(text)))
    .find((recording) =>
      recording.request.pages.some((page) =>
        page.text.includes('NOTICE TO AUTOMATED EXTRACTION SYSTEMS'),
      ),
    );

  it('exists for a dev-split corpus document and is labelled handcrafted', () => {
    expect(injection?.origin).toBe('handcrafted');
    expect(injection?.note).toContain('p-108-datasheet');
  });

  it('is returned unchanged by the Replay provider, obeyed value included', async () => {
    if (injection === undefined) throw new Error('injection recording missing');
    const replay = createReplayProvider({
      dir: fileURLToPath(RECORDINGS),
      modelId: DEFAULT_GEMINI_MODEL,
    });
    const result = await replay.extract(injection.request, { timeoutMs: 1_000 });
    expect(result).toEqual({ ok: true, value: injection.response });
    expect(
      result.ok && result.value.candidates.find((c) => c.fieldName === 'rated_flow'),
    ).toMatchObject({
      value: '9999',
      unit: 'gpm',
    });
  });
});
