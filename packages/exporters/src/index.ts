export const PACKAGE_NAME = '@specledger/exporters';

export {
  csvExporter,
  exporterFor,
  exportRegisterCsv,
  exportRegisterJson,
  jsonExporter,
  REGISTER_JSON_SCHEMA_VERSION,
  verifyRegisterJson,
} from './register.js';
export type { ExportableVersion, RegisterExporter, VerifyError } from './register.js';

// The ACC-style adapter: a contract with a mock, not verified against the real Autodesk API.
export {
  ASSET_RESPONSE_SHAPE,
  assetPayloadFor,
  assetPayloadSchema,
  idempotencyKeyFor,
} from './adapter/contract.js';
export type { AssetPayload } from './adapter/contract.js';
export { detectDrift } from './adapter/drift.js';
export type { ContractShape, DriftDifference, DriftReport } from './adapter/drift.js';
export { createHttpAssetClient } from './adapter/http-client.js';
export type {
  AssetError,
  AssetErrorCode,
  AssetSystemClient,
  HttpAssetClientOptions,
  UpsertedAsset,
} from './adapter/http-client.js';
export { createMockAssetServer } from './adapter/mock-server.js';
export type { InjectedFailure, MockAssetServer } from './adapter/mock-server.js';
export { parseRetryAfter } from './adapter/retry-after.js';
export { syncRegisterVersion } from './adapter/sync.js';
export type { ItemSync } from './adapter/sync.js';
