// Every expected ingestion failure, defined once. Codes are stable: the API maps them to responses
// and clients may branch on them. Messages are fixed text chosen here, never built from parser
// output, exceptions or file contents, so an error can be logged or returned as it is.
export const INGEST_ERROR_CODES = [
  'EMPTY',
  'NOT_A_PDF',
  'TOO_LARGE',
  'INVALID_METADATA',
  'TOO_MANY_PAGES',
  'ENCRYPTED',
  'CORRUPT',
  'PARSE_TIMEOUT',
  'RESOURCE_LIMIT',
  'NO_TEXT_LAYER',
] as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

// Numbers only: limits and measured sizes help a user fix the upload and reveal nothing about it.
export interface IngestErrorDetails {
  readonly limit?: number;
  readonly actual?: number;
  // Metadata keys that failed validation (INVALID_METADATA), never their values.
  readonly fields?: readonly string[];
}

export interface IngestError {
  readonly code: IngestErrorCode;
  readonly message: string;
  readonly details?: IngestErrorDetails;
}

const MESSAGES: Record<IngestErrorCode, string> = {
  EMPTY: 'The upload is empty.',
  NOT_A_PDF: 'The upload is not a PDF file.',
  TOO_LARGE: 'The file is larger than the size limit.',
  INVALID_METADATA: 'The upload metadata is invalid.',
  TOO_MANY_PAGES: 'The document has more pages than the page limit.',
  ENCRYPTED: 'The document is encrypted or password protected. Upload an unprotected copy.',
  CORRUPT: 'The PDF is damaged or malformed and cannot be read.',
  PARSE_TIMEOUT: 'Reading the PDF took longer than the time limit.',
  RESOURCE_LIMIT: 'Reading the PDF needed more memory than the limit allows.',
  NO_TEXT_LAYER:
    'The document has no extractable text (for example, a scanned image). OCR is not supported.',
};

export function ingestError(code: IngestErrorCode, details?: IngestErrorDetails): IngestError {
  return details === undefined
    ? { code, message: MESSAGES[code] }
    : { code, message: MESSAGES[code], details };
}
