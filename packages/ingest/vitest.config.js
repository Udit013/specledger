import { defineConfig } from 'vitest/config';

// Most tests here start real worker threads that load pdfjs. On a shared CI runner, with other
// packages' suites running at the same time, a test that starts several workers in turn can take
// longer than Vitest's 5 s default. Behaviour, not speed, is asserted; the tests that check speed
// (the parse timeout) measure it themselves.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
