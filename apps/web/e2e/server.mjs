// The API for the end-to-end test: the real built API, queue, worker, verifier and
// reconciliation (apps/api/dist), on a fresh schema, with one stand-in. The model is replaced by
// a deterministic reader of the corpus ground truth, because only one real model response is
// recorded and the test must never call a paid model. Test-only: nothing deployed uses this.
//
//   E2E_DATABASE_URL=postgres://... node apps/web/e2e/server.mjs   (after pnpm build)
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const dist = (path) => new URL(path, root).href;

const { buildApp } = await import(dist('apps/api/dist/http/app.js'));
const { createProcessDocumentHandler, PROCESS_DOCUMENT } = await import(
  dist('apps/api/dist/worker/process-document.js')
);
const { createWorker } = await import(dist('apps/api/dist/worker/worker.js'));
const { WORKER } = await import(dist('apps/api/dist/worker/document-worker.js'));
const { hashPassword } = await import(dist('apps/api/dist/auth/passwords.js'));
const { openDatabase } = await import(dist('packages/db/dist/index.js'));
const { DEFAULT_INGEST_LIMITS, extractPages } = await import(dist('packages/ingest/dist/index.js'));
const { PROMPT_VERSION } = await import(dist('packages/llm/dist/index.js'));

export const E2E_USER = { email: 'e2e@example.com', password: 'end-to-end-password-0123' };
const DOCUMENTS = ['p-106-datasheet', 'p-106-brochure'];
const PORT = Number(process.env.E2E_API_PORT ?? 3300);
const connectionString = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set E2E_DATABASE_URL');

// A model that reads the documents correctly: the ground-truth candidates of whichever corpus
// document the request's first page belongs to.
const byFirstPage = new Map();
for (const id of DOCUMENTS) {
  const pages = await extractPages(readFileSync(new URL(`fixtures/corpus/pdf/${id}.pdf`, root)));
  if (!pages.ok) throw new Error(pages.error.code);
  const truth = JSON.parse(readFileSync(new URL(`fixtures/corpus/truth/${id}.json`, root), 'utf8'));
  byFirstPage.set(
    pages.value.pages[0]?.text ?? '',
    Object.entries(truth.fields).flatMap(([fieldName, field]) =>
      field === null
        ? []
        : [
            {
              fieldName,
              value: field.value,
              unit: field.unit,
              quote: field.quote,
              page: field.page,
            },
          ],
    ),
  );
}
const provider = {
  name: 'truth',
  modelId: 'truth-model',
  extract: async (request) => ({
    ok: true,
    value: {
      modelId: 'truth-model',
      promptVersion: PROMPT_VERSION,
      candidates: byFirstPage.get(request.pages[0]?.text ?? '') ?? [],
      usage: { inputTokens: null, outputTokens: null },
    },
  }),
};

// A fresh schema for every run.
const database = openDatabase({ connectionString, schema: 'e2e', wipeable: true });
await database.wipe();
await database.users.create({
  email: E2E_USER.email,
  displayName: 'End-to-end tester',
  passwordHash: await hashPassword(E2E_USER.password),
  roles: ['engineer', 'reviewer', 'approver', 'admin'],
});

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const app = await buildApp({
  database,
  auth: { sessionTtlMs: 3_600_000, secureCookies: false, loginRateLimitPerMinute: 100 },
  limits: DEFAULT_INGEST_LIMITS,
  http: {
    corsOrigins: [],
    trustProxy: false,
    rateLimitPerMinute: 10_000,
    uploadRateLimitPerMinute: 100,
    requestTimeoutMs: 30_000,
    bodyLimitBytes: 1_048_576,
    readyTimeoutMs: 2_000,
  },
});
const worker = createWorker({
  queue: database.jobs,
  handlers: {
    [PROCESS_DOCUMENT]: createProcessDocumentHandler({
      store: database,
      provider,
      llmTimeoutMs: 30_000,
      logger: quiet,
    }),
  },
  workerId: `e2e:${randomUUID().slice(0, 8)}`,
  clock: () => new Date(),
  random: Math.random,
  logger: quiet,
  ...WORKER,
  pollIntervalMs: 200,
});

await app.listen({ host: '127.0.0.1', port: PORT });
worker.start();
const stop = async () => {
  await Promise.allSettled([worker.stop(), app.close()]);
  await database.close();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
