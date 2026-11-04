// Manual smoke test: one real Gemini call on one synthetic corpus document.
//
//   GEMINI_API_KEY=... pnpm llm:smoke            # one call, prints a summary
//   RECORD=1 GEMINI_API_KEY=... pnpm llm:smoke   # also writes fixtures/recordings/<key>.json
//
// Not part of the test suite or CI. It sends only the synthetic document below, because content
// sent to the Gemini free tier may be used to improve Google's products.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FIELD_DEFINITIONS } from '@specledger/core';
import { extractPages } from '@specledger/ingest';
import {
  createGeminiProvider,
  createRecordingProvider,
  DEFAULT_GEMINI_MODEL,
  PROMPT_VERSION,
  withLogging,
} from '@specledger/llm';

import { createLogger } from '../logger.js';

const ROOT = new URL('../../../../', import.meta.url);
const DOCUMENT = 'p-106-datasheet';

async function main(): Promise<number> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (apiKey === '') {
    process.stderr.write('GEMINI_API_KEY is not set. This script makes one real Gemini call.\n');
    return 2;
  }
  const modelId = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const pages = await extractPages(
    readFileSync(new URL(`fixtures/corpus/pdf/${DOCUMENT}.pdf`, ROOT)),
  );
  if (!pages.ok) {
    process.stderr.write(`could not read ${DOCUMENT}: ${pages.error.code}\n`);
    return 1;
  }

  const gemini = createGeminiProvider({ apiKey, modelId });
  const provider = withLogging(
    process.env.RECORD === '1'
      ? createRecordingProvider({
          inner: gemini,
          dir: fileURLToPath(new URL('fixtures/recordings/', ROOT)),
          env: process.env,
        })
      : gemini,
    createLogger({ name: 'llm-smoke', level: 'info' }),
  );
  const result = await provider.extract(
    {
      equipmentClass: 'centrifugal_pump',
      fields: [...FIELD_DEFINITIONS.centrifugal_pump],
      pages: pages.value.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
      promptVersion: PROMPT_VERSION,
      synthetic: true,
    },
    { timeoutMs: 60_000 },
  );
  if (!result.ok) {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    return 1;
  }
  // Field names and values of a synthetic document only.
  for (const candidate of result.value.candidates) {
    process.stdout.write(
      `${candidate.fieldName}: ${candidate.value} ${candidate.unit} (page ${String(candidate.page)})\n`,
    );
  }
  return 0;
}

process.exitCode = await main();
