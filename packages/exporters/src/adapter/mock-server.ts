import { notImplemented } from '../not-implemented.js';
export type InjectedFailure =
  | { readonly kind: 'rate_limited'; readonly retryAfter?: string }
  | { readonly kind: 'unavailable'; readonly retryAfter?: string }
  | { readonly kind: 'validation' }
  | { readonly kind: 'slow'; readonly delayMs: number }
  | { readonly kind: 'drift'; readonly mode: 'extra' | 'missing' | 'retyped' };
export interface MockAssetServer {
  listen(): Promise<string>;
  close(): Promise<void>;
  reset(): void;
  inject(failure: InjectedFailure, times?: number): void;
  requests(): readonly {
    readonly idempotencyKey: string | null;
    readonly correlationId: string | null;
  }[];
  assets(): readonly {
    readonly assetId: string;
    readonly externalId: string;
    readonly revision: number;
  }[];
  writes(): number;
}
export function createMockAssetServer(options: { readonly token?: string } = {}): MockAssetServer {
  return notImplemented('createMockAssetServer', options);
}
