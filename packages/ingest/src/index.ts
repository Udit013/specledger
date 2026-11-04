export const PACKAGE_NAME = '@specledger/ingest';

export { INGEST_ERROR_CODES, ingestError } from './errors.js';
export type { IngestError, IngestErrorCode, IngestErrorDetails } from './errors.js';
export { createWorkerExtractor, extractPages } from './extractor.js';
export type {
  ExtractedDocument,
  ExtractedPage,
  ExtractPagesOptions,
  PageExtractor,
  WorkerExtractorOptions,
} from './extractor.js';
export { ingestDocument, sha256Hex } from './ingest.js';
export type {
  IngestDeps,
  IngestedDocument,
  IngestInput,
  IngestStore,
  IngestTransaction,
  NewStoredDocument,
} from './ingest.js';
export { DEFAULT_INGEST_LIMITS, INGEST_LIMIT_BOUNDS } from './limits.js';
export type { IngestLimits } from './limits.js';
export { displayFilename, uploadMetaSchema, validateUpload } from './validate-upload.js';
export type { UploadMeta, ValidatedUpload } from './validate-upload.js';
