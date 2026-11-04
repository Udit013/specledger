import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Worker modules that misbehave on purpose, written to a temporary directory so each can embed the
// path of a file it reports through (the extraction worker gets an empty environment).
export interface FakeWorkers {
  readonly dir: string;
  write(name: string, source: string): URL;
  remove(): void;
}

export function fakeWorkers(): FakeWorkers {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-workers-'));
  return {
    dir,
    write(name, source) {
      const path = join(dir, `${name}.mjs`);
      writeFileSync(path, source);
      return pathToFileURL(path);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Never replies and never yields: a parser stuck in a loop. It records a growing counter so a test
// can see whether the thread is still running after the extractor gave up on it.
export const spinningWorker = (heartbeatPath: string) => `
import { writeFileSync } from 'node:fs';
let beats = 0;
let last = 0;
for (;;) {
  const now = Date.now();
  if (now - last >= 5) {
    last = now;
    beats += 1;
    writeFileSync(${JSON.stringify(heartbeatPath)}, String(beats));
  }
}
`;

export const exhaustingWorker = `
const hoard = [];
for (;;) hoard.push(new Array(1_000_000).fill(Math.random()));
`;

export const throwingWorker = `throw new Error('parser exploded while reading secret page text');`;

export const malformedReplyWorker = `
import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ ok: true, pages: 'not a list' });
`;

export const environmentReportingWorker = (reportPath: string) => `
import { writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(Object.keys(process.env)));
parentPort.postMessage({ ok: true, pages: ['Rated flow: 500 gpm, rated head: 45 m'] });
`;
