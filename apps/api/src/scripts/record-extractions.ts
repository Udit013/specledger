// Records a real model's extractions of the synthetic corpus as an evaluation extraction set.
// It makes real model calls, so it is never run by tests or CI, and needs explicit intent:
//
//   GEMINI_API_KEY=... pnpm eval:record                       # dev split, recorded set only
//   RECORD=1 GEMINI_API_KEY=... pnpm eval:record              # also writes Replay recordings
//
// Only synthetic corpus documents are sent (content sent to the Gemini free tier may be used by
// Google). Calls are sequential with a pause between them, and a rate-limited call waits and is
// tried again, to stay inside the free tier's per-minute limit. See docs/evaluation.md.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { FIELD_DEFINITIONS } from '@specledger/core';
import type { Candidate } from '@specledger/core';
import { loadEvalCorpus } from '@specledger/eval';
import type { EvalDocument, ExtractionSet, Split } from '@specledger/eval';
import {
  createGeminiProvider,
  createRecordingProvider,
  DEFAULT_GEMINI_MODEL,
  PROMPT_VERSION,
} from '@specledger/llm';
import type { LlmProvider } from '@specledger/llm';

export interface RecordOptions {
  readonly provider: LlmProvider;
  readonly documents: readonly EvalDocument[];
  readonly modelId: string;
  readonly promptVersion: string;
  // The day the recording was made (YYYY-MM-DD), passed in: the set must not read the clock.
  readonly date: string;
  readonly corpusSha256: string;
  readonly pauseMs: number;
  readonly rateLimitWaitMs: number;
  readonly maxRateLimitRetries: number;
  readonly timeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export async function recordExtractions(options: RecordOptions): Promise<ExtractionSet> {
  const documents: Record<string, { candidates: Candidate[] } | { error: string }> = {};
  const ordered = [...options.documents].sort((a, b) => (a.id < b.id ? -1 : 1));
  let first = true;
  for (const document of ordered) {
    if (document.pages === null) continue;
    if (!first) await options.sleep(options.pauseMs);
    first = false;
    const request = {
      equipmentClass: document.truth.equipmentClass,
      fields: [...FIELD_DEFINITIONS[document.truth.equipmentClass]],
      pages: document.pages.map((text, i) => ({ pageNumber: i + 1, text })),
      promptVersion: options.promptVersion,
      synthetic: true,
    };
    for (let retry = 0; ; retry += 1) {
      const result = await options.provider.extract(request, {
        timeoutMs: options.timeoutMs,
        requestId: `eval-${document.id}`,
      });
      if (result.ok) {
        documents[document.id] = { candidates: [...result.value.candidates] };
        break;
      }
      if (result.error.code === 'RATE_LIMITED' && retry < options.maxRateLimitRetries) {
        await options.sleep(options.rateLimitWaitMs);
        continue;
      }
      // A failure is recorded as such; the evaluation reports the document as skipped.
      documents[document.id] = { error: result.error.code };
      break;
    }
  }
  return {
    schemaVersion: 1,
    origin: 'recorded',
    label: `RECORDED: answers from ${options.modelId} (prompt ${options.promptVersion}) on the synthetic corpus, recorded ${options.date}. Synthetic documents only; not a measure of accuracy on real vendor documents.`,
    modelId: options.modelId,
    promptVersion: options.promptVersion,
    date: options.date,
    corpusSha256: options.corpusSha256,
    generator: null,
    documents,
  };
}

async function main(): Promise<number> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (apiKey === '') {
    process.stderr.write('GEMINI_API_KEY is not set. This script makes real Gemini calls.\n');
    return 2;
  }
  const split: Split = process.argv.includes('--allow-holdout') ? 'holdout' : 'dev';
  const root = new URL('../../../../', import.meta.url);
  const corpus = await loadEvalCorpus(fileURLToPath(new URL('fixtures/corpus/', root)), {
    split,
    allowHoldout: split === 'holdout',
  });
  if (!corpus.ok) return 1;
  const modelId = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const gemini = createGeminiProvider({ apiKey, modelId });
  const provider =
    process.env.RECORD === '1'
      ? createRecordingProvider({
          inner: gemini,
          dir: fileURLToPath(new URL('fixtures/recordings/', root)),
          env: process.env,
        })
      : gemini;
  const set = await recordExtractions({
    provider,
    documents: corpus.value.documents,
    modelId,
    promptVersion: PROMPT_VERSION,
    date: new Date().toISOString().slice(0, 10),
    corpusSha256: corpus.value.corpusSha256,
    pauseMs: 4_500,
    rateLimitWaitMs: 60_000,
    maxRateLimitRetries: 3,
    timeoutMs: 60_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const out = new URL(
    `evaluation/extractions/recorded-${modelId}-${PROMPT_VERSION}-${split}.json`,
    root,
  );
  await mkdir(new URL('evaluation/extractions/', root), { recursive: true });
  await writeFile(out, `${JSON.stringify(set, null, 2)}\n`);
  const failed = Object.values(set.documents).filter((d) => 'error' in d).length;
  process.stdout.write(`wrote ${fileURLToPath(out)} (${String(failed)} documents failed)\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
