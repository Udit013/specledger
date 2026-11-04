import type { Result } from '@specledger/core';
import { notImplemented } from '../not-implemented.js';
import type { ExportableVersion } from '../register.js';
import type { AssetError, AssetSystemClient, UpsertedAsset } from './http-client.js';
export interface ItemSync {
  readonly tag: string;
  readonly idempotencyKey: string;
  readonly result: Result<UpsertedAsset, AssetError>;
}
export function syncRegisterVersion(
  client: AssetSystemClient,
  version: ExportableVersion,
  options: { correlationId?: string } = {},
): Promise<ItemSync[]> {
  return Promise.resolve(notImplemented('syncRegisterVersion', client, version, options));
}
