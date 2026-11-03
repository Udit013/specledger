#!/usr/bin/env node
// usage: node scripts/migrations.mjs generate <name>   create a migration from src/schema.ts
//        node scripts/migrations.mjs check             fail if src/schema.ts has changes with no migration
//
// generate: runs drizzle-kit, then removes the "public". qualifier drizzle-kit writes into foreign
// keys, so migrations apply into whichever schema the connection's search_path names. Review the
// generated SQL before committing it; the committed SQL is the source of truth (forward-only).
//
// check: regenerates into a scratch copy of migrations/. drizzle-kit compares the schema with the
// latest snapshot, so any new file means the schema drifted from the committed migrations.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const MIGRATIONS = 'migrations';

// Returns drizzle-kit's output. drizzle-kit prefixes "./" to the configured out directory, so the
// scratch directory is passed as a path relative to this package.
function drizzleKitGenerate(args, out) {
  const result = spawnSync('drizzle-kit', ['generate', ...args], {
    env: out === undefined ? process.env : { ...process.env, MIGRATIONS_OUT: relative('.', out) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    process.exit(result.status ?? 1);
  }
  return output;
}

const sqlFiles = (dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

function checkDrift(scratch) {
  cpSync(MIGRATIONS, scratch, { recursive: true });
  const output = drizzleKitGenerate(['--name', 'drift_probe'], scratch);
  const extra = sqlFiles(scratch).filter((file) => !sqlFiles(MIGRATIONS).includes(file));
  if (extra.length > 0) {
    console.error('Migration drift: src/schema.ts has changes that no committed migration covers.');
    console.error(
      'Run "pnpm --filter @specledger/db db:generate <name>", review the SQL, commit it.',
    );
    return 1;
  }
  // Fail closed: "no new file" counts as success only when drizzle-kit says so explicitly,
  // never when it failed without producing anything.
  if (!output.includes('No schema changes')) {
    process.stderr.write(output);
    console.error('Drift check could not confirm the result; see drizzle-kit output above.');
    return 1;
  }
  console.log('No migration drift: committed migrations match src/schema.ts.');
  return 0;
}

const [command, name] = process.argv.slice(2);

if (command === 'generate') {
  if (name === undefined || !/^[a-z0-9_]+$/.test(name)) {
    console.error('usage: migrations.mjs generate <snake_case_name>');
    process.exit(2);
  }
  const before = new Set(sqlFiles(MIGRATIONS));
  drizzleKitGenerate(['--name', name]);
  for (const file of sqlFiles(MIGRATIONS).filter((f) => !before.has(f))) {
    const path = join(MIGRATIONS, file);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replaceAll('REFERENCES "public".', 'REFERENCES '),
    );
    console.log(`generated ${path}; review it before committing`);
  }
} else if (command === 'check') {
  const scratch = mkdtempSync(join(tmpdir(), 'migration-drift-'));
  try {
    process.exitCode = checkDrift(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  console.error('usage: migrations.mjs generate <name> | check');
  process.exit(2);
}
