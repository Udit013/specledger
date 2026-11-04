import { z } from 'zod';
import { notImplemented } from '../not-implemented.js';
import type { ExportableVersion } from '../register.js';
export const assetPayloadSchema = z.strictObject({
  externalId: z.string().min(1),
  name: z.string().min(1),
  attributes: z.array(z.strictObject({ name: z.string(), value: z.string(), unit: z.string() })),
  source: z.strictObject({
    system: z.literal('specledger'),
    registerVersion: z.number().int(),
    publishedAt: z.string(),
  }),
});
export type AssetPayload = z.infer<typeof assetPayloadSchema>;
type Item = ExportableVersion['items'][number];
export function assetPayloadFor(
  version: Omit<ExportableVersion, 'items'>,
  item: Item,
): AssetPayload {
  return notImplemented('assetPayloadFor', version, item);
}
export function idempotencyKeyFor(
  version: Pick<ExportableVersion, 'number'>,
  item: Pick<Item, 'tag'>,
): string {
  return notImplemented('idempotencyKeyFor', version, item);
}
