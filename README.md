# SpecLedger

Every specification, with its proof.

SpecLedger turns vendor equipment datasheets into a verified equipment register. Each extracted
value must carry a verbatim quote that is checked against the source page before a person reviews
it and an approver publishes an immutable register version.

## Status

Phase 0 of the plan (foundation and quality gates) is in place: the monorepo skeleton, strict
TypeScript, lint and dependency-boundary rules, CI, a local Postgres container, validated
configuration, a redacting logger and Git hygiene checks.

No product features exist yet. There is no extraction, verification, database schema, API route or
user interface.

## Quick start

Requirements: Node 22 (see `.nvmrc`), pnpm (the exact version is pinned in `package.json` under
`packageManager`), and Docker for the local database.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs typecheck, lint, unit tests and build in every package, then the dependency
boundary check.

Local database and configuration:

```sh
cp .env.example .env
pnpm db:up
pnpm --filter @specledger/api build
pnpm --filter @specledger/api start
```

The API currently only validates its configuration and logs that it loaded; the HTTP server is not
built yet.

Git hooks (once per clone):

```sh
pnpm hooks:install
```

Other scripts: `pnpm test`, `pnpm test:integration` (needs `DATABASE_URL` and a running Postgres),
`pnpm format`, `pnpm format:check`, `pnpm boundaries`.

## Repository layout

| Path                 | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `apps/api`           | HTTP API and worker entry point                      |
| `apps/web`           | Review UI                                            |
| `packages/core`      | Pure domain logic with no I/O; may import only zod   |
| `packages/db`        | Database schema, migrations, repositories, queue     |
| `packages/llm`       | Model provider interface and implementations         |
| `packages/ingest`    | Upload validation and PDF text extraction            |
| `packages/exporters` | Register exporters                                   |
| `packages/eval`      | Evaluation runner and regression gate                |
| `docs/adr`           | Architecture decision records                        |
| `scripts`            | Commit hygiene check, Git hook sources and installer |

Dependency rule, enforced by `pnpm boundaries`: core imports nothing except zod; db, llm, ingest,
exporters and eval may import core but not each other; apps may import packages; nothing imports
apps; no import cycles.

## Architecture

To be written.

## Limitations

Known gaps at this stage:

- The integration test job runs against a real Postgres service but contains no tests yet; its
  runner is configured to pass with zero tests until the first database tests are added.
- Log redaction matches field names. A secret or document text placed inside a free-text log
  message is not caught, so the rule is to log ids and statuses only.
- On the first push of a branch, the CI commit-hygiene job cannot check the root commit; the local
  pre-push hook covers it.
- Git hooks are local to a clone and can be bypassed with `--no-verify`; the CI check is the
  safety net.
- Development dependencies carry one moderate advisory (`minimatch`, through ESLint) that cannot
  be overridden without breaking ESLint's version range; the CI audit fails on high and above.

## License

MIT. See [LICENSE](LICENSE).
