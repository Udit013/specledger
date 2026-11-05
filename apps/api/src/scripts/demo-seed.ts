// Uploads a small set of synthetic corpus documents to a deployment, so every screen of the demo
// has something to show: a revision pair, a brochure that disagrees with its datasheet, a range,
// and the prompt-injection document. The metadata comes from each document's ground truth.
//
//   SEED_API_URL=https://specledger-api.onrender.com SEED_ENGINEER_TOKEN=... pnpm demo:seed
//
// The deployment extracts them in the background with its configured model; uploads are spaced to
// stay inside the upload rate limit and the model's free-tier rate.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { groundTruthSchema, manifestSchema } from '@specledger/eval';

// Dev-split documents only; the holdout is never used for anything but its one evaluation.
export const DEMO_DOCUMENTS: readonly string[] = [
  'p-106-datasheet',
  'p-106-brochure',
  'm-201-datasheet-rev-a',
  'm-201-datasheet-rev-b',
  'p-108-datasheet',
  'm-203-datasheet',
  'p-110-datasheet',
];

export interface SeedOptions {
  readonly root: string;
  readonly apiUrl: string;
  readonly engineerToken: string;
  readonly fetch?: typeof fetch;
  readonly pauseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SeedResult {
  readonly id: string;
  readonly status: number;
  readonly detail: string;
}

export async function seedDemo(options: SeedOptions): Promise<SeedResult[]> {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const corpus = join(options.root, 'fixtures/corpus');
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8')),
  );
  const url = `${options.apiUrl.replace(/\/$/, '')}/documents`;
  const results: SeedResult[] = [];
  for (const [index, id] of DEMO_DOCUMENTS.entries()) {
    if (index > 0) await sleep(options.pauseMs ?? 7_000);
    const entry = manifest.documents.find((d) => d.id === id);
    if (entry === undefined) throw new Error(`${id} is not in the corpus manifest`);
    if (entry.split !== 'dev') throw new Error(`${id} is not a dev document`);
    const truth = groundTruthSchema.parse(
      JSON.parse(await readFile(join(corpus, entry.truth), 'utf8')),
    );
    const form = new FormData();
    form.set('documentType', truth.sourceType);
    if (truth.revision !== null) form.set('revision', truth.revision);
    form.set('equipmentTag', truth.equipmentTag);
    form.set('equipmentClass', truth.equipmentClass);
    form.set('synthetic', 'true');
    const bytes = await readFile(join(corpus, entry.pdf));
    form.set('file', new File([bytes], `${id}.pdf`, { type: 'application/pdf' }));
    const response = await send(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.engineerToken}` },
      body: form,
    });
    const text = await response.text();
    results.push({ id, status: response.status, detail: text.slice(0, 200) });
  }
  return results;
}

async function main(): Promise<number> {
  const apiUrl = process.env.SEED_API_URL;
  const engineerToken = process.env.SEED_ENGINEER_TOKEN;
  if (apiUrl === undefined || engineerToken === undefined) {
    process.stderr.write('Set SEED_API_URL and SEED_ENGINEER_TOKEN.\n');
    return 2;
  }
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const results = await seedDemo({ root, apiUrl, engineerToken });
  for (const r of results) {
    const outcome = r.status === 202 ? 'queued' : r.status === 200 ? 'already there' : 'FAILED';
    process.stdout.write(
      `${outcome.padEnd(13)} ${r.id}${r.status >= 300 ? `  ${r.detail}` : ''}\n`,
    );
  }
  return results.every((r) => r.status === 200 || r.status === 202) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
