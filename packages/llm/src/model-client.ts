import { err, ok } from '@specledger/core';
import type { Candidate, Result } from '@specledger/core';
import type { z } from 'zod';

import { llmError } from './errors.js';
import type { LlmError } from './errors.js';
import { buildPrompts, DEFAULT_MAX_CHUNK_CHARS } from './prompt.js';
import { extractionRequestSchema, modelOutputSchema } from './types.js';
import type { ExtractionRequest, ExtractionResponse, ExtractOptions, TokenUsage } from './types.js';

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ModelCall {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly schema: z.ZodType;
  readonly signal: AbortSignal;
}

// What one call to a model produced: an object to validate, or output the client already found
// invalid (unparseable JSON, or a schema failure reported by the SDK).
export type ModelReply =
  | { readonly kind: 'object'; readonly value: unknown; readonly usage: TokenUsage }
  | { readonly kind: 'invalid'; readonly issues: readonly string[]; readonly usage: TokenUsage };

// One raw model behind a provider. It makes exactly one call per generate(): no retries of its
// own, so every retry is visible in extractWithClient.
export interface ModelClient {
  readonly modelId: string;
  generate(call: ModelCall): Promise<Result<ModelReply, LlmError>>;
}

export interface ClientSettings {
  // Extra attempts after a schema-invalid answer. 2 means up to 3 calls per chunk.
  readonly maxSchemaRetries?: number;
  readonly maxChunkChars?: number;
}

export const DEFAULT_MAX_SCHEMA_RETRIES = 2;

// Schema problems as "path: code", never with the offending value, because values in model output
// can be document text and they go back into a prompt.
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
    return `${path}: ${issue.code}${'expected' in issue ? ` (expected ${String(issue.expected)})` : ''}`;
  });
}

// Contains the validation problems and nothing from the document.
export function correctiveMessage(issues: readonly string[]): string {
  return [
    'Your previous answer did not match the required JSON schema. Problems:',
    ...issues.map((issue) => `- ${issue}`),
    'Answer again with JSON that matches the schema exactly. Use only the fields listed above and',
    'quote the document verbatim.',
  ].join('\n');
}

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens:
    a.inputTokens === null || b.inputTokens === null ? null : a.inputTokens + b.inputTokens,
  outputTokens:
    a.outputTokens === null || b.outputTokens === null ? null : a.outputTokens + b.outputTokens,
});

// Resolves with the promise, or with an abort marker as soon as the signal fires, so a client that
// ignores its signal still cannot hold the caller past the time limit.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      resolve('aborted');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// Runs a request through a raw client: validate the request, build the chunked prompts, call the
// client once per chunk, validate every answer, and retry an invalid answer with a corrective
// message up to the limit. The time limit covers the whole request.
export async function extractWithClient(
  client: ModelClient,
  request: ExtractionRequest,
  options: ExtractOptions,
  settings: ClientSettings = {},
): Promise<Result<ExtractionResponse, LlmError>> {
  const parsed = extractionRequestSchema.safeParse(request);
  if (!parsed.success) {
    return err(
      llmError('BAD_REQUEST', 'The extraction request is invalid.', {
        issues: describeIssues(parsed.error),
      }),
    );
  }
  const maxRetries = settings.maxSchemaRetries ?? DEFAULT_MAX_SCHEMA_RETRIES;
  const schema = modelOutputSchema(request.fields.map((field) => field.name));
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const stopped = (): LlmError | null => {
    if (options.signal?.aborted === true) return llmError('ABORTED', 'The request was cancelled.');
    if (timeout.aborted) {
      return llmError(
        'TIMEOUT',
        `The model did not answer within ${String(options.timeoutMs)} ms.`,
      );
    }
    return null;
  };

  const candidates: Candidate[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const chunk of buildPrompts(request, settings.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS)) {
    const messages: ModelMessage[] = [{ role: 'user', content: chunk.user }];
    for (let attempt = 1; ; attempt += 1) {
      const before = stopped();
      if (before !== null) return err(before);
      let reply: Result<ModelReply, LlmError> | 'aborted';
      try {
        reply = await untilAborted(
          client.generate({ system: chunk.system, messages, schema, signal }),
          signal,
        );
      } catch {
        reply = err(llmError('UNAVAILABLE', 'The model call failed unexpectedly.'));
      }
      const after = stopped();
      if (reply === 'aborted' || after !== null) {
        return err(after ?? llmError('ABORTED', 'The request was cancelled.'));
      }
      if (!reply.ok) return reply;
      usage = addUsage(usage, reply.value.usage);

      let issues: readonly string[];
      if (reply.value.kind === 'object') {
        const output = schema.safeParse(reply.value.value);
        if (output.success) {
          candidates.push(...output.data.candidates);
          break;
        }
        issues = describeIssues(output.error);
      } else {
        issues = reply.value.issues;
      }
      if (attempt > maxRetries) {
        return err(
          llmError('SCHEMA_INVALID', 'The model answer did not match the schema after retries.', {
            attempts: attempt,
            issues,
          }),
        );
      }
      // The rejected answer is not sent back: it may quote the document. A placeholder keeps the
      // turns alternating, and the correction carries only the schema problems.
      messages.push(
        { role: 'assistant', content: '[previous answer withheld: it did not match the schema]' },
        { role: 'user', content: correctiveMessage(issues) },
      );
    }
  }
  return ok({ modelId: client.modelId, promptVersion: request.promptVersion, candidates, usage });
}
