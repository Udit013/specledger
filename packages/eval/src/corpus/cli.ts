import { renderCorpus, writeCorpus } from './generate.js';
import { validateCorpus } from './validate.js';

// usage: node dist/corpus/cli.js generate <dir>
//        node dist/corpus/cli.js validate <dir>
async function main(argv: readonly string[]): Promise<number> {
  const [command, dir] = argv;
  if (dir === undefined || (command !== 'generate' && command !== 'validate')) {
    process.stderr.write('usage: cli.js generate|validate <corpus-dir>\n');
    return 2;
  }
  if (command === 'generate') {
    const manifest = writeCorpus(dir, await renderCorpus());
    const holdout = manifest.documents.filter((d) => d.split === 'holdout').length;
    process.stdout.write(
      `wrote ${String(manifest.documents.length)} documents (${String(holdout)} holdout) to ${dir}\n` +
        `corpus sha256 ${manifest.corpusSha256}\n`,
    );
    return 0;
  }
  const problems = await validateCorpus(dir, { checkReproducible: true });
  for (const problem of problems) process.stderr.write(`invalid: ${problem}\n`);
  if (problems.length > 0) return 1;
  process.stdout.write(`corpus at ${dir} is valid and reproducible\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
