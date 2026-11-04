import type { z } from 'zod';

export class StoredRowInvalidError extends Error {
  readonly entity: string;
  constructor(entity: string, issuePaths: readonly string[]) {
    // Paths only: row values may be document text and never belong in an error message.
    super(`stored ${entity} row failed validation at: ${issuePaths.join(', ') || '(root)'}`);
    this.name = 'StoredRowInvalidError';
    this.entity = entity;
  }
}

// Every row entering the domain is parsed with the core schema, so a row that breaks a domain
// invariant is reported instead of travelling further.
export function toDomain<T>(entity: string, schemaOf: z.ZodType<T>, value: unknown): T {
  const parsed = schemaOf.safeParse(value);
  if (!parsed.success) {
    throw new StoredRowInvalidError(
      entity,
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  }
  return parsed.data;
}
