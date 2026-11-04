import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { err } from '@specledger/core';
import { z } from 'zod';

import { llmError } from './errors.js';
import type { LlmError } from './errors.js';
import { describeIssues } from './model-client.js';
import { canonicalJson, replayKey } from './replay-key.js';
import { extractionRequestSchema, extractionResponseSchema } from './types.js';
import type { ExtractionRequest, ExtractionResponse, LlmProvider } from './types.js';

// fixtures/recordings/<key>.json. The request is kept with the response so a recording can be
// audited and its key recomputed; recordings only ever hold synthetic documents.
export const recordingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  // "recorded" came from a real model call; "handcrafted" was written by hand for a test.
  origin: z.enum(['recorded', 'handcrafted']),
  note: z.string().optional(),
  modelId: z.string().min(1),
  request: extractionRequestSchema,
  response: extractionResponseSchema,
});
export type Recording = z.infer<typeof recordingSchema>;

export const HOW_TO_RECORD =
  'Run the request through RecordingProvider with RECORD=1 and GEMINI_API_KEY set (synthetic ' +
  'documents only; pnpm llm:smoke records its document this way), or add the file by hand.';

export const recordingPath = (dir: string, key: string) => join(dir, `${key}.json`);

// The key is computed from the request, so it is validated first: a malformed request (a NaN in a
// field range, say) is a BAD_REQUEST result, not an exception out of the key computation.
function invalidRequest(request: ExtractionRequest): LlmError | null {
  const parsed = extractionRequestSchema.safeParse(request);
  return parsed.success
    ? null
    : llmError('BAD_REQUEST', 'The extraction request is invalid.', {
        issues: describeIssues(parsed.error),
      });
}

// Stable formatting, so re-recording the same answer leaves the file byte-identical.
export const serializeRecording = (recording: Recording): string =>
  `${JSON.stringify(JSON.parse(canonicalJson(recording)), null, 2)}\n`;

export interface ReplayOptions {
  readonly dir: string;
  // The model whose recordings to replay; part of the key.
  readonly modelId: string;
}

// Answers from recordings only. It reads files and never opens a connection.
export function createReplayProvider(options: ReplayOptions): LlmProvider {
  return {
    name: 'replay',
    modelId: options.modelId,
    async extract(request) {
      const invalid = invalidRequest(request);
      if (invalid !== null) return err(invalid);
      const key = replayKey(request, options.modelId);
      let text: string;
      try {
        text = await readFile(recordingPath(options.dir, key), 'utf8');
      } catch {
        return err(
          llmError('REPLAY_MISS', `No recording for this request (key ${key}).`, {
            key,
            howToRecord: HOW_TO_RECORD,
          }),
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const parsed = recordingSchema.safeParse(json);
      if (!parsed.success || parsed.data.key !== key || parsed.data.modelId !== options.modelId) {
        return err(
          llmError('SCHEMA_INVALID', `The recording for key ${key} is malformed or mismatched.`, {
            key,
          }),
        );
      }
      return { ok: true, value: parsed.data.response };
    },
  };
}

export interface RecordingOptions {
  readonly inner: LlmProvider;
  readonly dir: string;
  // Read for RECORD; injected so tests control it.
  readonly env: Readonly<Record<string, string | undefined>>;
}

async function writeRecording(
  dir: string,
  request: ExtractionRequest,
  modelId: string,
  response: ExtractionResponse,
) {
  const key = replayKey(request, modelId);
  const recording: Recording = {
    schemaVersion: 1,
    key,
    origin: 'recorded',
    modelId,
    request,
    response,
  };
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, `.${key}.${randomUUID()}.tmp`);
  await writeFile(temporary, serializeRecording(recording));
  await rename(temporary, recordingPath(dir, key));
}

// Makes real calls through `inner` and saves each answer as a recording. It refuses, before
// calling `inner`, unless RECORD=1 is set and the request is flagged synthetic.
export function createRecordingProvider(options: RecordingOptions): LlmProvider {
  return {
    name: `recording(${options.inner.name})`,
    modelId: options.inner.modelId,
    async extract(request, extractOptions) {
      if (options.env.RECORD !== '1') {
        return err(llmError('BAD_REQUEST', 'Recording is disabled; set RECORD=1 to record.'));
      }
      const invalid = invalidRequest(request);
      if (invalid !== null) return err(invalid);
      if (!request.synthetic) {
        return err(llmError('BAD_REQUEST', 'Only synthetic documents may be recorded.'));
      }
      const result = await options.inner.extract(request, extractOptions);
      if (result.ok)
        await writeRecording(options.dir, request, options.inner.modelId, result.value);
      return result;
    },
  };
}
