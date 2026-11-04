import { notImplemented } from './not-implemented.js';
export type Route =
  | { readonly name: 'documents' }
  | { readonly name: 'review'; readonly documentId: string }
  | { readonly name: 'conflicts' }
  | {
      readonly name: 'audit';
      readonly kind: 'field' | 'conflict' | 'register_version';
      readonly id: string;
    }
  | { readonly name: 'not_found' };
export function parseRoute(hash: string): Route {
  return notImplemented(`parseRoute(${hash})`);
}
export function hrefFor(route: Exclude<Route, { name: 'not_found' }>): string {
  return notImplemented(`hrefFor(${route.name})`);
}
