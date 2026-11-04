export const PACKAGE_NAME = '@specledger/llm';

export { canFailOver, LLM_ERROR_CODES, llmError } from './errors.js';
export type { LlmError, LlmErrorCode, LlmErrorDetails } from './errors.js';
export { createFailoverProvider } from './failover.js';
export type { FailoverOptions } from './failover.js';
export { createGeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini.js';
export type { GeminiOptions } from './gemini.js';
export { withLogging } from './logging.js';
export type { LlmLogger } from './logging.js';
export { DEFAULT_MAX_SCHEMA_RETRIES, extractWithClient } from './model-client.js';
export type {
  ClientSettings,
  ModelCall,
  ModelClient,
  ModelMessage,
  ModelReply,
} from './model-client.js';
export { buildPrompts, DEFAULT_MAX_CHUNK_CHARS, PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.js';
export type { PromptChunk } from './prompt.js';
export {
  createRecordingProvider,
  createReplayProvider,
  HOW_TO_RECORD,
  recordingPath,
  recordingSchema,
  serializeRecording,
} from './recordings.js';
export type { Recording, RecordingOptions, ReplayOptions } from './recordings.js';
export { canonicalJson, replayKey } from './replay-key.js';
export {
  extractionRequestSchema,
  extractionResponseSchema,
  modelOutputSchema,
  pageTextSchema,
  tokenUsageSchema,
} from './types.js';
export type {
  ExtractionRequest,
  ExtractionResponse,
  ExtractOptions,
  LlmProvider,
  PageText,
  TokenUsage,
} from './types.js';
