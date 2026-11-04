import { readdirSync, readFileSync } from 'node:fs';

import { FIELD_DEFINITIONS } from '@specledger/core';
import { extractPages } from '@specledger/ingest';
import { PROMPT_VERSION, recordingSchema } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const recordings = readdirSync(new URL('fixtures/recordings/', ROOT))
  .filter((name) => name.endsWith('.json'))
  .map((name) =>
    recordingSchema.parse(
      JSON.parse(readFileSync(new URL(`fixtures/recordings/${name}`, ROOT), 'utf8')),
    ),
  );

// Recordings embed the page text of their request. This keeps them honest: each one must be the
// request that ingestion and the current prompt version produce for a corpus PDF today, or replay
// would answer a request the pipeline never makes.
describe('recordings match what the pipeline sends', () => {
  it.each(recordings.map((recording) => [recording.key.slice(0, 12), recording] as const))(
    'recording %s',
    async (_key, recording) => {
      const id = /corpus document ([a-z0-9-]+)/.exec(recording.note ?? '')?.[1];
      if (id === undefined) throw new Error('recording note does not name its corpus document');
      const pages = await extractPages(
        readFileSync(new URL(`fixtures/corpus/pdf/${id}.pdf`, ROOT)),
      );
      if (!pages.ok) throw new Error(pages.error.code);
      expect(recording.request).toEqual({
        equipmentClass: recording.request.equipmentClass,
        fields: [...FIELD_DEFINITIONS[recording.request.equipmentClass]],
        pages: pages.value.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
        promptVersion: PROMPT_VERSION,
        synthetic: true,
      });
    },
  );
});
