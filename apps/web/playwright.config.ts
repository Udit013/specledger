import { defineConfig, devices } from '@playwright/test';

// One end-to-end test of the whole workflow in a real browser, against the built API on its own
// database schema (e2e/server.mjs) and the Vite dev server, which proxies /api to it as Vercel does
// in production. Run with `pnpm --filter @specledger/web e2e` after `pnpm build`.
const API_PORT = 3300;
const WEB_PORT = 5300;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/server.mjs',
      url: `http://127.0.0.1:${String(API_PORT)}/ready`,
      env: { E2E_API_PORT: String(API_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `vite --host 127.0.0.1 --port ${String(WEB_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(WEB_PORT)}`,
      env: { API_URL: `http://127.0.0.1:${String(API_PORT)}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
