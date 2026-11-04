// Expected failures are returned as values, not thrown, so callers must handle them and the type
// says which ones can occur. Thrown errors are left for bugs and broken infrastructure.
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });

export const err = <E>(error: E): { readonly ok: false; readonly error: E } => ({
  ok: false,
  error,
});
