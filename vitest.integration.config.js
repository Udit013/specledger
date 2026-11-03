import { defineConfig } from 'vitest/config';

// Integration tests live in <package>/test/integration and run against a real Postgres
// (DATABASE_URL). Files run in parallel; Phase 1 gives each file its own schema.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/test/integration/**/*.test.ts'],
    // Phase 0 has no integration tests yet. Remove this once Phase 1 adds the first one, so a
    // broken include pattern can never pass silently.
    passWithNoTests: true,
  },
});
