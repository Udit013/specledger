import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { err, ok } from '@specledger/core';
import type { Result } from '@specledger/core';
import { z } from 'zod';

import { splitSchema } from '../corpus/truth.js';
import type { Split } from '../corpus/truth.js';
import { loadEvalCorpus } from './corpus-loader.js';
import { extractionSetSchema } from './extraction-set.js';
import { baselineFrom, checkGate } from './gate.js';
import type { Baseline } from './gate.js';
import { renderMarkdown, renderReadmeSection, replaceReadmeSection, reportJson } from './report.js';
import type { EvaluationReport } from './runner.js';
import { runEvaluation } from './runner.js';
import { simulateExtractions } from './simulate.js';

// usage (from packages/eval, after a build; the root scripts wrap these):
//   cli.js run [--split dev|holdout] [--allow-holdout] [--extractions <file>]
//   cli.js simulate [--check]        write or check evaluation/extractions/simulated-v1.json
//   cli.js baseline                  record evaluation/baseline.json from the dev report
//   cli.js gate                      compare the dev report with the baseline
//   cli.js readme [--check]          write or check the README results section
//   cli.js ci                        everything CI checks, writing nothing

const paths = (root: string) => ({
  corpus: join(root, 'fixtures/corpus'),
  simulated: join(root, 'evaluation/extractions/simulated-v1.json'),
  out: (split: Split) => join(root, split === 'dev' ? 'evaluation' : 'evaluation/holdout'),
  baseline: join(root, 'evaluation/baseline.json'),
  readme: join(root, 'README.md'),
});

// The seed and date of the committed simulated set. Changing either is a new set: regenerate it,
// then the report, then the baseline, deliberately.
export const SIMULATION = {
  seed: 'specledger-simulated-extraction-v1',
  date: '2026-11-04',
} as const;

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface Evaluated {
  readonly report: EvaluationReport;
  readonly json: string;
  readonly markdown: string;
}

export async function evaluate(
  root: string,
  options: { split: Split; allowHoldout: boolean; extractions?: string },
): Promise<Result<Evaluated, 'HOLDOUT_REQUIRES_FLAG' | 'INVALID_EXTRACTION_SET'>> {
  const p = paths(root);
  const corpus = await loadEvalCorpus(p.corpus, options);
  if (!corpus.ok) return corpus;
  const raw = await readFile(options.extractions ?? p.simulated, 'utf8');
  const set = extractionSetSchema.safeParse(JSON.parse(raw));
  if (!set.success || set.data.corpusSha256 !== corpus.value.corpusSha256) {
    return err('INVALID_EXTRACTION_SET');
  }
  const report = runEvaluation({
    documents: corpus.value.documents,
    set: set.data,
    split: options.split,
    corpusSha256: corpus.value.corpusSha256,
    setSha256: sha256(raw),
  });
  return ok({ report, json: reportJson(report), markdown: renderMarkdown(report) });
}

async function simulated(root: string): Promise<string> {
  const p = paths(root);
  // The generator reads every document's ground truth, holdout included, as the corpus generator
  // does: it writes fixtures, it does not evaluate or tune anything.
  const all = await Promise.all(
    (['dev', 'holdout'] as const).map((split) =>
      loadEvalCorpus(p.corpus, { split, allowHoldout: true }),
    ),
  );
  const documents = all.flatMap((loaded) => (loaded.ok ? loaded.value.documents : []));
  const corpusSha256 = all[0]?.ok === true ? all[0].value.corpusSha256 : '';
  const set = simulateExtractions(documents, { ...SIMULATION, corpusSha256 });
  return `${JSON.stringify(set, null, 2)}\n`;
}

const baselineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  corpusSha256: z.string(),
  setSha256: z.string(),
  split: splitSchema,
  precision: z.number().nullable(),
  unsupportedRate: z.number().nullable(),
});

const readBaseline = async (root: string): Promise<Baseline> =>
  baselineSchema.parse(JSON.parse(await readFile(paths(root).baseline, 'utf8')));

const say = (text: string) => process.stdout.write(`${text}\n`);
const complain = (text: string) => process.stderr.write(`${text}\n`);

const ERRORS = {
  HOLDOUT_REQUIRES_FLAG:
    'The holdout split is evaluated once, after all tuning. Pass --allow-holdout to run it.',
  INVALID_EXTRACTION_SET:
    'The extraction set is invalid or was made for another corpus (corpusSha256 differs).',
} as const;

async function dev(root: string): Promise<Evaluated | null> {
  const result = await evaluate(root, { split: 'dev', allowHoldout: false });
  if (!result.ok) {
    complain(ERRORS[result.error]);
    return null;
  }
  return result.value;
}

export async function main(argv: readonly string[], root: string): Promise<number> {
  const [command = 'run', ...args] = argv;
  const flag = (name: string) => args.includes(name);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const p = paths(root);

  if (command === 'run') {
    const split = splitSchema.safeParse(option('--split') ?? 'dev');
    if (!split.success) {
      complain('--split must be dev or holdout');
      return 2;
    }
    const allowHoldout = flag('--allow-holdout');
    if (split.data === 'holdout' && allowHoldout) {
      complain(
        'WARNING: evaluating the HOLDOUT split. Do this once, after all tuning is finished; the report records that the holdout was used.',
      );
    }
    // Relative to the repository root, where the commands are documented from.
    const given = option('--extractions');
    const extractions = given === undefined || isAbsolute(given) ? given : join(root, given);
    const result = await evaluate(root, {
      split: split.data,
      allowHoldout,
      ...(extractions === undefined ? {} : { extractions }),
    });
    if (!result.ok) {
      complain(ERRORS[result.error]);
      return 1;
    }
    const out = p.out(split.data);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'report.json'), result.value.json);
    await writeFile(join(out, 'report.md'), result.value.markdown);
    const overall = result.value.report.pipeline.overall;
    say(
      `wrote ${join(out, 'report.json')} and report.md (${result.value.report.extraction.origin})`,
    );
    say(
      `precision ${String(overall.precision.rate)}, recall ${String(overall.recall.rate)}, unsupported ${String(overall.unsupportedRate.rate)}`,
    );
    say(`report sha256 ${sha256(result.value.json)}`);
    return 0;
  }

  if (command === 'simulate') {
    const generated = await simulated(root);
    if (flag('--check')) {
      const committed = await readFile(p.simulated, 'utf8');
      if (committed !== generated) {
        complain('evaluation/extractions/simulated-v1.json does not regenerate identically');
        return 1;
      }
      say('the simulated extraction set regenerates identically');
      return 0;
    }
    await mkdir(join(root, 'evaluation/extractions'), { recursive: true });
    await writeFile(p.simulated, generated);
    say(`wrote ${p.simulated}`);
    return 0;
  }

  const evaluated = await dev(root);
  if (evaluated === null) return 1;

  if (command === 'baseline') {
    await writeFile(p.baseline, `${JSON.stringify(baselineFrom(evaluated.report), null, 2)}\n`);
    say(`wrote ${p.baseline}`);
    return 0;
  }
  if (command === 'gate') {
    const result = checkGate(evaluated.report, await readBaseline(root));
    for (const violation of result.violations) complain(`regression: ${violation}`);
    say(result.pass ? 'gate passed: no regression against the baseline' : 'gate FAILED');
    return result.pass ? 0 : 1;
  }
  if (command === 'readme') {
    const readme = await readFile(p.readme, 'utf8');
    const updated = replaceReadmeSection(readme, renderReadmeSection(evaluated.report));
    if (flag('--check')) {
      if (updated !== readme) {
        complain('the README results section is out of date: run pnpm eval:readme');
        return 1;
      }
      say('the README results section matches report.json');
      return 0;
    }
    await writeFile(p.readme, updated);
    say('updated the README results section from the report');
    return 0;
  }
  if (command === 'ci') {
    const problems: string[] = [];
    if ((await simulated(root)) !== (await readFile(p.simulated, 'utf8'))) {
      problems.push('the simulated extraction set does not regenerate identically');
    }
    if (evaluated.json !== (await readFile(join(p.out('dev'), 'report.json'), 'utf8'))) {
      problems.push('evaluation/report.json is not what the evaluation produces: run pnpm eval');
    }
    if (evaluated.markdown !== (await readFile(join(p.out('dev'), 'report.md'), 'utf8'))) {
      problems.push('evaluation/report.md is not what the evaluation produces: run pnpm eval');
    }
    const readme = await readFile(p.readme, 'utf8');
    if (replaceReadmeSection(readme, renderReadmeSection(evaluated.report)) !== readme) {
      problems.push('the README results section is out of date: run pnpm eval:readme');
    }
    const gate = checkGate(evaluated.report, await readBaseline(root));
    problems.push(...gate.violations.map((v) => `regression: ${v}`));
    for (const problem of problems) complain(problem);
    say(problems.length === 0 ? 'evaluation checks passed' : 'evaluation checks FAILED');
    return problems.length === 0 ? 0 : 1;
  }
  complain(`unknown command ${command}`);
  return 2;
}

// Run only as a script, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  process.exitCode = await main(process.argv.slice(2), root);
}
