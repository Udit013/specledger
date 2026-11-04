import { z } from 'zod';

// Messages between the extractor and its worker thread. The worker parses hostile input, so its
// reply is validated like any other untrusted data before it is used.

export const WORKER_KIND = 'specledger-extract';

export interface WorkerRequest {
  readonly kind: typeof WORKER_KIND;
  readonly bytes: Uint8Array;
  readonly maxPages: number;
}

export const workerReplySchema = z.union([
  z.strictObject({ ok: z.literal(true), pages: z.array(z.string()) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal('TOO_MANY_PAGES'),
    pageCount: z.number().int().nonnegative(),
  }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['ENCRYPTED', 'CORRUPT']) }),
]);
export type WorkerReply = z.infer<typeof workerReplySchema>;
