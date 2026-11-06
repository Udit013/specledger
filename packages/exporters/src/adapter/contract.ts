import { assetPayloadSchema } from '@specledger/core';
import type { AssetPayload } from '@specledger/core';
import { z } from 'zod';

import type { ExportableVersion } from '../register.js';
import type { ContractShape } from './drift.js';

// The ACC-style asset contract (docs/adapter-contract.md). It is a contract written for this
// project and checked against a mock only: it has not been verified against the real Autodesk
// API.

// The payload schema lives in core, so the API and the web app validate the same shape.
export { assetPayloadSchema };
export type { AssetPayload };

// The success response the contract promises, as the drift detector checks it.
export const ASSET_RESPONSE_SHAPE: ContractShape = {
  assetId: 'string',
  externalId: 'string',
  revision: 'number',
  created: 'boolean',
};

export const assetResponseSchema = z.object({
  assetId: z.string().min(1),
  externalId: z.string().min(1),
  revision: z.number().int().min(1),
  created: z.boolean(),
});

// Printable ASCII without spaces, as the header allows and the mock stores.
export const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

type Item = ExportableVersion['items'][number];

// One register item as an asset: the tag is the external id the target system matches on, and the
// attributes are the item's values sorted by field name, as stored text with their units.
export function assetPayloadFor(
  version: Omit<ExportableVersion, 'items'>,
  item: Item,
): AssetPayload {
  return {
    externalId: `specledger:${item.tag}`,
    name: item.tag,
    attributes: Object.keys(item.values)
      .sort()
      .map((name) => ({
        name,
        value: item.values[name]?.value ?? '',
        unit: item.values[name]?.unit ?? '',
      })),
    source: {
      system: 'specledger',
      registerVersion: version.number,
      publishedAt: version.publishedAt.toISOString(),
    },
  };
}

// Deterministic per version and item, so a sync that is retried or run twice repeats the same
// requests instead of writing again.
export function idempotencyKeyFor(
  version: Pick<ExportableVersion, 'number'>,
  item: Pick<Item, 'tag'>,
): string {
  return `specledger:register:v${String(version.number)}:${item.tag}`;
}
