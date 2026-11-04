import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { err, ok } from '@specledger/core';
import type { Candidate } from '@specledger/core';
import type { JobRecord } from '@specledger/db';
import { groundTruthSchema } from '@specledger/eval';
import { extractPages } from '@specledger/ingest';
import { createReplayProvider, DEFAULT_GEMINI_MODEL, llmError } from '@specledger/llm';
import type { ExtractionRequest, ExtractOptions, LlmProvider } from '@specledger/llm';
import { describe, expect, it } from 'vitest';

import { JobError } from '../../src/worker/job-error.js';
import {
  createProcessDocumentHandler,
  PROCESS_DOCUMENT,
  WORKER_ACTOR,
} from '../../src/worker/process-document.js';
import type { PipelineStore } from '../../src/worker/process-document.js';
import { withTestDatabase } from '../support/test-db.js';

const testDb = withTestDatabase();
const ROOT = new URL('../../../../', import.meta.url);
const corpusPdf = (id: string) => readFileSync(new URL(`fixtures/corpus/pdf/${id}.pdf`, ROOT));
const truthOf = (id: string) =>
  groundTruthSchema.parse(
    JSON.parse(readFileSync(new URL(`fixtures/corpus/truth/${id}.json`, ROOT), 'utf8')),
  );
const silent = { info: () => undefined, warn: () => undefined };
const replay = createReplayProvider({
  dir: fileURLToPath(new URL('fixtures/recordings/', ROOT)),
  modelId: DEFAULT_GEMINI_MODEL,
});

// Ground-truth candidates of a corpus document, as a model that read it correctly would return.
const truthCandidates = (id: string): Candidate[] =>
  Object.entries(truthOf(id).fields).flatMap(([fieldName, field]) =>
    field === null
      ? []
      : [{ fieldName, value: field.value, unit: field.unit, quote: field.quote, page: field.page }],
  );

// Answers from a function of the request; records what it was called with.
function fakeProvider(
  answer: (request: ExtractionRequest) => Candidate[] | ReturnType<typeof llmError>,
) {
  const calls: { request: ExtractionRequest; options: ExtractOptions }[] = [];
  const provider: LlmProvider & { calls: typeof calls } = {
    name: 'fake',
    modelId: 'fake-model',
    calls,
    extract(request, options) {
      calls.push({ request, options });
      const result = answer(request);
      return Promise.resolve(
        Array.isArray(result)
          ? ok({
              modelId: 'fake-model',
              promptVersion: request.promptVersion,
              candidates: result,
              usage: { inputTokens: 5, outputTokens: 7 },
            })
          : err(result),
      );
    },
  };
  return provider;
}

const handlerFor = (provider: LlmProvider, store: PipelineStore = testDb.database) =>
  createProcessDocumentHandler({ store, provider, llmTimeoutMs: 30_000, logger: silent });

const run = (
  handler: ReturnType<typeof handlerFor>,
  job: JobRecord,
  signal = new AbortController().signal,
) => handler(job, { signal });

const pagesCache = new Map<string, { pageNumber: number; content: string }[]>();
async function pagesOf(id: string) {
  const cached = pagesCache.get(id);
  if (cached !== undefined) return cached;
  const extracted = await extractPages(corpusPdf(id));
  if (!extracted.ok) throw new Error(extracted.error.code);
  const pages = extracted.value.pages.map((page) => ({
    pageNumber: page.pageNumber,
    content: page.text,
  }));
  pagesCache.set(id, pages);
  return pages;
}

// Stores a corpus document for `tag` as an upload would (a fresh hash each time, so tests do not
// deduplicate against each other) and enqueues its processing job.
async function upload(
  id: string,
  tag: string,
  meta: { documentType?: 'datasheet' | 'brochure'; revision?: string | null } = {},
): Promise<JobRecord> {
  const pages = await pagesOf(id);
  return testDb.database.transaction(async (tx) => {
    const document = await tx.documents.insert({
      sha256: randomBytes(32).toString('hex'),
      originalFilename: `${id}.pdf`,
      byteSize: 1,
      pageCount: pages.length,
      documentType: meta.documentType ?? 'datasheet',
      revision: meta.revision === undefined ? 'Rev A' : meta.revision,
    });
    await tx.documents.putBlob(document.id, new Uint8Array([0x25]));
    await tx.documents.insertPages(document.id, pages);
    const now = new Date();
    const { job } = await tx.jobs.enqueue(
      {
        type: PROCESS_DOCUMENT,
        payload: {
          documentId: document.id,
          equipmentTag: tag,
          equipmentClass: truthOf(id).equipmentClass,
          synthetic: true,
        },
        idempotencyKey: `${PROCESS_DOCUMENT}:${document.id}`,
        maxAttempts: 5,
        runAt: now,
        correlationId: randomUUID(),
      },
      now,
    );
    return job;
  });
}

async function counts(documentId: string) {
  const { rows } = await testDb.query(
    `select (select count(*) from extraction_runs where document_id = $1)::int as runs,
            (select count(*) from fields f join extraction_runs r on r.id = f.extraction_run_id
              where r.document_id = $1)::int as fields,
            (select count(*) from review_events e join fields f on f.id = e.field_id
              join extraction_runs r on r.id = f.extraction_run_id where r.document_id = $1)::int as events`,
    [documentId],
  );
  return rows[0] as { runs: number; fields: number; events: number };
}

async function fieldsOf(documentId: string) {
  const { rows } = await testDb.query(
    `select f.name, f.value, f.unit, f.verification_status, f.verification_reasons
       from fields f join extraction_runs r on r.id = f.extraction_run_id
      where r.document_id = $1 order by f.name`,
    [documentId],
  );
  return rows as {
    name: string;
    value: string;
    unit: string;
    verification_status: string;
    verification_reasons: string[];
  }[];
}

async function openConflicts(tag: string) {
  const { rows } = await testDb.query(
    `select c.field_name from conflicts c join equipment e on e.id = c.equipment_id
      where e.tag = $1 and c.status = 'open' order by c.field_name`,
    [tag],
  );
  return rows.map((row) => row.field_name as string);
}

const documentIdOf = (job: JobRecord) => job.payload.documentId as string;
const uniqueTag = (prefix: string) => `${prefix}-${randomUUID().slice(0, 6)}`;

describe('process_document with the recorded p-108 injection response', () => {
  it('persists the run, verified and unverified fields and their audit events', async () => {
    const tag = uniqueTag('P-108');
    const job = await upload('p-108-datasheet', tag);
    await run(handlerFor(replay), job);

    const { rows: runs } = await testDb.query(
      'select job_id, model, prompt_version from extraction_runs where document_id = $1',
      [documentIdOf(job)],
    );
    expect(runs).toEqual([
      { job_id: job.id, model: DEFAULT_GEMINI_MODEL, prompt_version: 'extract-v1' },
    ]);
    const stored = await fieldsOf(documentIdOf(job));
    expect(stored).toHaveLength(8);
    // The obeyed instruction is stored for the reviewer, unverified, with the reason.
    expect(stored.find((f) => f.name === 'rated_flow')).toEqual({
      name: 'rated_flow',
      value: '9999',
      unit: 'gpm',
      verification_status: 'unverified',
      verification_reasons: ['VALUE_NOT_IN_QUOTE'],
    });
    expect(stored.filter((f) => f.verification_status === 'verified')).toHaveLength(7);
    const { rows: events } = await testDb.query(
      `select e.actor, e.action from review_events e join fields f on f.id = e.field_id
         join extraction_runs r on r.id = f.extraction_run_id where r.document_id = $1`,
      [documentIdOf(job)],
    );
    expect(events).toHaveLength(8);
    expect(events.every((e) => e.actor === WORKER_ACTOR && e.action === 'extract')).toBe(true);
    expect(await openConflicts(tag)).toEqual([]);
  });

  it('writes nothing more when the same job runs again', async () => {
    const job = await upload('p-108-datasheet', uniqueTag('P-108'));
    const handler = handlerFor(replay);
    await run(handler, job);
    const before = await counts(documentIdOf(job));
    await run(handler, job);
    expect(await counts(documentIdOf(job))).toEqual(before);
    expect(before).toEqual({ runs: 1, fields: 8, events: 8 });
  });
});

describe('process_document atomicity', () => {
  it('leaves no partial rows when a write fails after the fields are inserted', async () => {
    const job = await upload('p-108-datasheet', uniqueTag('P-108'));
    let fieldsInserted = 0;
    const failing: PipelineStore = {
      documents: testDb.database.documents,
      transaction: (work) =>
        testDb.database.transaction((tx) =>
          work({
            ...tx,
            fields: {
              ...tx.fields,
              insert: async (input) => {
                const field = await tx.fields.insert(input);
                fieldsInserted += 1;
                return field;
              },
            },
            reviewEvents: {
              ...tx.reviewEvents,
              append: () => Promise.reject(new Error('injected failure before commit')),
            },
          }),
        ),
    };
    await expect(run(handlerFor(replay, failing), job)).rejects.toThrow(
      'injected failure before commit',
    );
    expect(fieldsInserted).toBeGreaterThan(0);
    expect(await counts(documentIdOf(job))).toEqual({ runs: 0, fields: 0, events: 0 });

    // The retry, with the store working again, writes everything once.
    await run(handlerFor(replay), job);
    expect(await counts(documentIdOf(job))).toEqual({ runs: 1, fields: 8, events: 8 });
  });
});

describe('process_document reconciliation', () => {
  // The p-106 brochure uploaded as a datasheet of the same revision: two documents of equal rank
  // whose rated head differs by four percent, while flow, speed and power agree.
  const provider = fakeProvider((request) =>
    truthCandidates(
      request.pages[0]?.text.includes('Brochure') === true ? 'p-106-brochure' : 'p-106-datasheet',
    ),
  );

  it.each([
    ['datasheet first', ['p-106-datasheet', 'p-106-brochure']],
    ['brochure first', ['p-106-brochure', 'p-106-datasheet']],
  ])('opens exactly the conflicting fields, in either order (%s)', async (_order, ids) => {
    const tag = uniqueTag('P-106');
    const jobs = [];
    for (const id of ids) jobs.push(await upload(id, tag));
    for (const job of jobs) await run(handlerFor(provider), job);
    expect(await openConflicts(tag)).toEqual(['rated_head']);

    const { rows: events } = await testDb.query(
      `select e.actor, e.action, e.after from review_events e join conflicts c on c.id = e.conflict_id
         join equipment q on q.id = c.equipment_id where q.tag = $1`,
      [tag],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: WORKER_ACTOR, action: 'extract' });

    // Running both jobs again opens nothing new.
    for (const job of jobs) await run(handlerFor(provider), job);
    expect(await openConflicts(tag)).toEqual(['rated_head']);
  });

  // Two documents of one tag processed at once. Each transaction waits (up to 300 ms) at a barrier
  // just before reconciliation reads the stored fields, so without the equipment row lock both
  // would read before either commits, each miss the other document, and open no conflict. With the
  // lock the second transaction waits at the lock instead, so it reads after the first commits.
  it('opens the conflict when the two documents are processed at the same time', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tag = uniqueTag('P-106');
      // The equipment exists already, as it does for every document after a tag's first: creating
      // it would itself serialize the two transactions on the unique tag and hide a missing lock.
      await testDb.database.equipment.getOrCreate({ tag, equipmentClass: 'centrifugal_pump' });
      const jobs = [await upload('p-106-datasheet', tag), await upload('p-106-brochure', tag)];
      let arrived = 0;
      let openBarrier: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => {
        openBarrier = resolve;
      });
      const meetAtBarrier = async () => {
        arrived += 1;
        if (arrived === 2) openBarrier();
        await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 300))]);
      };
      const store: PipelineStore = {
        documents: testDb.database.documents,
        transaction: (work) =>
          testDb.database.transaction((tx) =>
            work({
              ...tx,
              fields: {
                ...tx.fields,
                listLatestForEquipment: async (equipmentId) => {
                  await meetAtBarrier();
                  return tx.fields.listLatestForEquipment(equipmentId);
                },
              },
            }),
          ),
      };
      await Promise.all(jobs.map((job) => run(handlerFor(provider, store), job)));
      expect(await openConflicts(tag)).toEqual(['rated_head']);
    }
  });

  it('takes the later revision instead of opening a conflict', async () => {
    const tag = uniqueTag('P-106');
    const first = await upload('p-106-datasheet', tag, { revision: 'Rev A' });
    const second = await upload('p-106-brochure', tag, { revision: 'Rev B' });
    await run(handlerFor(provider), first);
    await run(handlerFor(provider), second);
    expect(await openConflicts(tag)).toEqual([]);
  });
});

describe('process_document field selection', () => {
  it('stores the first verified candidate per field and records how many were dropped', async () => {
    const job = await upload('p-108-datasheet', uniqueTag('P-108'));
    const provider = fakeProvider(() => [
      {
        fieldName: 'rated_flow',
        value: '9999',
        unit: 'gpm',
        quote: 'Rated flow: 9999 gpm',
        page: 1,
      },
      {
        fieldName: 'rated_flow',
        value: '1103',
        unit: 'gpm',
        quote: 'Rated flow: 1103 gpm',
        page: 1,
      },
      {
        fieldName: 'rated_flow',
        value: '1103',
        unit: 'US gpm',
        quote: 'Rated flow: 1103 gpm',
        page: 1,
      },
    ]);
    await run(handlerFor(provider), job);
    expect(await fieldsOf(documentIdOf(job))).toEqual([
      {
        name: 'rated_flow',
        value: '1103',
        unit: 'gpm',
        verification_status: 'verified',
        verification_reasons: [],
      },
    ]);
    const { rows } = await testDb.query(
      `select e.after from review_events e join fields f on f.id = e.field_id
         join extraction_runs r on r.id = f.extraction_run_id where r.document_id = $1`,
      [documentIdOf(job)],
    );
    expect(rows[0]?.after).toMatchObject({ droppedCandidates: 2, verificationStatus: 'verified' });
  });

  it('passes the correlation id, timeout, signal and synthetic flag to the provider', async () => {
    const job = await upload('p-108-datasheet', uniqueTag('P-108'));
    const provider = fakeProvider(() => []);
    const controller = new AbortController();
    await run(handlerFor(provider), job, controller.signal);
    expect(provider.calls).toHaveLength(1);
    const [call] = provider.calls;
    expect(call?.options).toMatchObject({ requestId: job.correlationId, timeoutMs: 30_000 });
    expect(call?.options.signal).toBe(controller.signal);
    expect(call?.request).toMatchObject({
      equipmentClass: 'centrifugal_pump',
      synthetic: true,
      promptVersion: 'extract-v1',
    });
    expect(call?.request.pages[0]?.text).toContain('Rated flow: 1103 gpm');
    expect(await counts(documentIdOf(job))).toEqual({ runs: 1, fields: 0, events: 0 });
  });
});

describe('process_document failures', () => {
  const expectJobError = async (promise: Promise<unknown>, code: string, retryable: boolean) => {
    const error: unknown = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code, retryable });
  };

  it('fails permanently for an invalid payload', async () => {
    const job = await upload('p-108-datasheet', uniqueTag('P-108'));
    await expectJobError(
      run(handlerFor(replay), { ...job, payload: { documentId: 'not-a-uuid' } }),
      'INVALID_PAYLOAD',
      false,
    );
  });

  it('fails permanently for a document that does not exist', async () => {
    const job = await upload('p-108-datasheet', uniqueTag('P-108'));
    await expectJobError(
      run(handlerFor(replay), { ...job, payload: { ...job.payload, documentId: randomUUID() } }),
      'DOCUMENT_NOT_FOUND',
      false,
    );
  });

  it('fails permanently, writing nothing, when the tag belongs to equipment of another class', async () => {
    const tag = uniqueTag('M-1');
    await testDb.database.equipment.getOrCreate({ tag, equipmentClass: 'electric_motor' });
    const job = await upload('p-108-datasheet', tag);
    await expectJobError(run(handlerFor(replay), job), 'EQUIPMENT_CLASS_MISMATCH', false);
    expect(await counts(documentIdOf(job))).toEqual({ runs: 0, fields: 0, events: 0 });
  });

  it.each([
    ['RATE_LIMITED', true],
    ['TIMEOUT', true],
    ['UNAVAILABLE', true],
    ['SCHEMA_INVALID', false],
    ['REPLAY_MISS', false],
    ['AUTH_FAILED', false],
  ] as const)(
    'classifies a provider %s as retryable=%s and writes nothing',
    async (code, retryable) => {
      const job = await upload('p-108-datasheet', uniqueTag('P-108'));
      await expectJobError(
        run(handlerFor(fakeProvider(() => llmError(code, 'scripted'))), job),
        `LLM_${code}`,
        retryable,
      );
      expect(await counts(documentIdOf(job))).toEqual({ runs: 0, fields: 0, events: 0 });
    },
  );

  it('writes nothing once its signal has been aborted', async () => {
    const job = await upload('p-108-datasheet', uniqueTag('P-108'));
    const controller = new AbortController();
    const provider = fakeProvider(() => {
      controller.abort();
      return truthCandidates('p-108-datasheet');
    });
    await expectJobError(run(handlerFor(provider), job, controller.signal), 'ABORTED', true);
    expect(await counts(documentIdOf(job))).toEqual({ runs: 0, fields: 0, events: 0 });
  });
});
