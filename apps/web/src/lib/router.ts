import { z } from 'zod';

// Hash routes: the screen and the ids it shows, nothing else. Tokens never go in the URL.
export type Route =
  | { readonly name: 'documents' }
  | { readonly name: 'review'; readonly documentId: string }
  | { readonly name: 'conflicts' }
  | { readonly name: 'upload' }
  | {
      readonly name: 'audit';
      readonly kind: 'field' | 'conflict' | 'register_version';
      readonly id: string;
    }
  | { readonly name: 'not_found' };

const uuid = z.uuid();
const auditKind = z.enum(['field', 'conflict', 'register_version']);

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const [first = '', second, third, ...rest] = parts;
  if (rest.length > 0) return { name: 'not_found' };
  if ((first === '' || first === 'documents') && second === undefined) return { name: 'documents' };
  if (first === 'documents' && third === undefined && uuid.safeParse(second).success) {
    return { name: 'review', documentId: second ?? '' };
  }
  if (first === 'conflicts' && second === undefined) return { name: 'conflicts' };
  if (first === 'upload' && second === undefined) return { name: 'upload' };
  const kind = auditKind.safeParse(second);
  if (first === 'audit' && kind.success && uuid.safeParse(third).success) {
    return { name: 'audit', kind: kind.data, id: third ?? '' };
  }
  return { name: 'not_found' };
}

export function hrefFor(route: Exclude<Route, { name: 'not_found' }>): string {
  switch (route.name) {
    case 'documents':
      return '#/documents';
    case 'review':
      return `#/documents/${route.documentId}`;
    case 'conflicts':
      return '#/conflicts';
    case 'upload':
      return '#/upload';
    case 'audit':
      return `#/audit/${route.kind}/${route.id}`;
  }
}
