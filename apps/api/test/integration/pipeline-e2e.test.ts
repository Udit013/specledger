import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INGEST_LIMITS } from '@specledger/ingest';
import { createReplayProvider, DEFAULT_GEMINI_MODEL } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

import { createIngestion } from '../../src/ingestion.js';
import { createProcessDocumentHandler } from '../../src/worker/process-document.js';
import { createWorker } from '../../src/worker/worker.js';
import { withTestDatabase } from '../support/test-db.js';

const testDb = withTestDatabase();
const ROOT = new URL('../../../../', import.meta.url);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

// Every phase in order: an upload (ingestion, Phase 3) enqueues a job in the same transaction; the
// worker claims it and runs process_document, which extracts (Replay of the recorded p-108
// response, Phase 4), verifies (Phase 5), reconciles (Phase 6) and persists in one transaction.
describe('upload to stored fields, end to end', () => {
  it('processes an uploaded document through the worker loop', async () => {
    const uploaded = await createIngestion(
      testDb.database,
      DEFAULT_INGEST_LIMITS,
    )({
      bytes: readFileSync(new URL('fixtures/corpus/pdf/p-108-datasheet.pdf', ROOT)),
      meta: { filename: 'p-108.pdf', documentType: 'datasheet', revision: 'Rev A' },
      equipment: { tag: 'P-108', equipmentClass: 'centrifugal_pump' },
      synthetic: true,
    });
    if (!uploaded.ok || uploaded.value.job === null) throw new Error('upload failed');
    const { job, document } = uploaded.value;

    const worker = createWorker({
      queue: testDb.database.jobs,
      handlers: {
        process_document: createProcessDocumentHandler({
          store: testDb.database,
          provider: createReplayProvider({
            dir: fileURLToPath(new URL('fixtures/recordings/', ROOT)),
            modelId: DEFAULT_GEMINI_MODEL,
          }),
          llmTimeoutMs: 30_000,
          logger: silent,
        }),
      },
      workerId: 'e2e-worker',
      clock: () => new Date(),
      random: Math.random,
      logger: silent,
      pollIntervalMs: 20,
      concurrency: 1,
      visibilityMs: 30_000,
      heartbeatMs: 1_000,
      graceMs: 1_000,
      backoff: { baseMs: 1_000, capMs: 60_000 },
    });
    worker.start();
    try {
      for (let i = 0; i < 250; i += 1) {
        if ((await testDb.database.jobs.getById(job.id))?.status === 'succeeded') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await worker.stop();
    }

    expect(await testDb.database.jobs.getById(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    const { rows } = await testDb.query(
      `select f.name, f.verification_status from fields f
         join extraction_runs r on r.id = f.extraction_run_id
        where r.document_id = $1 and r.job_id = $2 order by f.name`,
      [document.id, job.id],
    );
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.verification_status === 'verified')).toHaveLength(7);
    expect(rows.find((row) => row.name === 'rated_flow')).toEqual({
      name: 'rated_flow',
      verification_status: 'unverified',
    });
  });
});
