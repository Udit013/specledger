import { defineConfig } from 'vitest/config';

// Integration tests live in <package>/test/integration and run against a real Postgres
// (DATABASE_URL). Files run in parallel; each one gets its own schema from withTestDb().
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/test/integration/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
