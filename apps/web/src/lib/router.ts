import { z } from 'zod';

// Hash routes: the screen and the ids it shows, nothing else. Credentials never go in the URL.
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'documents' }
  | { readonly name: 'review'; readonly documentId: string }
  | { readonly name: 'conflicts' }
  | { readonly name: 'upload' }
  | { readonly name: 'register' }
  | { readonly name: 'register_version'; readonly number: number }
  | { readonly name: 'sign_in' }
  | { readonly name: 'users' }
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
  if (first === '' && second === undefined) return { name: 'home' };
  if (first === 'documents' && second === undefined) return { name: 'documents' };
  if (first === 'documents' && third === undefined && uuid.safeParse(second).success) {
    return { name: 'review', documentId: second ?? '' };
  }
  if (first === 'conflicts' && second === undefined) return { name: 'conflicts' };
  if (first === 'upload' && second === undefined) return { name: 'upload' };
  if (first === 'register' && second === undefined) return { name: 'register' };
  if (first === 'register' && third === undefined && /^[1-9][0-9]{0,8}$/.test(second ?? '')) {
    return { name: 'register_version', number: Number(second) };
  }
  if (first === 'sign-in' && second === undefined) return { name: 'sign_in' };
  if (first === 'users' && second === undefined) return { name: 'users' };
  const kind = auditKind.safeParse(second);
  if (first === 'audit' && kind.success && uuid.safeParse(third).success) {
    return { name: 'audit', kind: kind.data, id: third ?? '' };
  }
  return { name: 'not_found' };
}

export function hrefFor(route: Exclude<Route, { name: 'not_found' }>): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'documents':
      return '#/documents';
    case 'review':
      return `#/documents/${route.documentId}`;
    case 'conflicts':
      return '#/conflicts';
    case 'upload':
      return '#/upload';
    case 'register':
      return '#/register';
    case 'register_version':
      return `#/register/${String(route.number)}`;
    case 'sign_in':
      return '#/sign-in';
    case 'users':
      return '#/users';
    case 'audit':
      return `#/audit/${route.kind}/${route.id}`;
  }
}
