import { defineConfig } from 'drizzle-kit';

// MIGRATIONS_OUT exists only for the drift check, which regenerates into a scratch copy.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: process.env.MIGRATIONS_OUT ?? './migrations',
});
