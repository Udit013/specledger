import type { Result } from '@specledger/core';

import type { ExportableVersion } from '../register.js';
import { assetPayloadFor, idempotencyKeyFor } from './contract.js';
import type { AssetError, AssetSystemClient, UpsertedAsset } from './http-client.js';

export interface ItemSync {
  readonly tag: string;
  readonly idempotencyKey: string;
  readonly result: Result<UpsertedAsset, AssetError>;
}

// Upserts every item of a published version, one at a time in tag order, and reports each
// outcome: one failing item does not stop the others. Safe to run again: each item's key is
// deterministic, so items already written are answered from the target's idempotency record.
export async function syncRegisterVersion(
  client: AssetSystemClient,
  version: ExportableVersion,
  options: { correlationId?: string; signal?: AbortSignal } = {},
): Promise<ItemSync[]> {
  const items = [...version.items].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const results: ItemSync[] = [];
  for (const item of items) {
    const idempotencyKey = idempotencyKeyFor(version, item);
    const result = await client.upsertAsset(
      assetPayloadFor(version, item),
      idempotencyKey,
      options,
    );
    results.push({ tag: item.tag, idempotencyKey, result });
  }
  return results;
}
