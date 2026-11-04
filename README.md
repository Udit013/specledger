# SpecLedger

Every specification, with its proof.

SpecLedger turns vendor equipment datasheets into a verified equipment register. Each extracted
value must carry a verbatim quote that is checked against the source page before a person reviews
it and an approver publishes an immutable register version.

## Status

Phases 0 to 4 of the plan are in place:

- Foundation and quality gates: the monorepo, strict TypeScript, lint and dependency-boundary
  rules, CI, a local Postgres container, validated configuration, a redacting logger and Git
  hygiene checks.
- Domain model and database: core domain types and Zod schemas for two equipment classes
  (centrifugal pump, electric motor), the Postgres schema with its constraints, database triggers
  that keep the review log append-only and published register versions immutable, typed
  repositories, and integration tests against a real Postgres.

- Fixtures and ground truth: a seeded generator for a synthetic corpus of pump and motor
  datasheets with designed difficult cases, Zod-validated ground truth, a reproducible dev/holdout
  split, and a validator that checks every ground-truth quote against the generated PDFs. See
  [docs/evaluation.md](docs/evaluation.md).
- Ingestion: upload validation (magic bytes, size, page count) and PDF text extraction in a
  terminable worker thread with memory and time limits, typed rejection codes, and storage of the
  document, its bytes and its page text in one transaction with deduplication by sha256. These are
  service functions; there is no HTTP endpoint yet.
- Model layer: an `LlmProvider` interface with Gemini (free tier, synthetic documents only),
  Replay, Recording and Failover implementations, a prompt builder that keeps document text in
  delimited data blocks, and schema-validated output with bounded correction retries. Tests run
  with every network socket blocked.

There is no verification, reconciliation, job queue, API route or user interface yet, and nothing
calls the model layer outside its tests and the manual smoke script.

## Quick start

Requirements: Node 22.18 or later in the 22 line (see `.nvmrc`; unit tests run the PDF worker
thread from TypeScript source, which relies on Node's built-in type stripping), pnpm (the exact version is pinned in `package.json` under
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

Integration tests need the local database (`pnpm db:up`) and `DATABASE_URL`. Each test file
creates its own schema, migrates it and drops it afterwards, so files run in parallel:

```sh
DATABASE_URL=postgres://specledger:specledger_local_only@127.0.0.1:5432/specledger pnpm test:integration
```

Database migrations are forward-only. After changing `packages/db/src/schema.ts`, generate a
migration, review the SQL and commit it; CI fails if the schema and the committed migrations drift
apart:

```sh
pnpm --filter @specledger/db db:generate <snake_case_name>
pnpm db:check-drift
```

The synthetic evaluation corpus is generated and checked with:

```sh
pnpm fixtures:generate
pnpm fixtures:validate
```

One real model call, on one synthetic document, for a manual check (not run by tests or CI; needs a
Gemini API key in `.env`; with `RECORD=1` it also saves the answer under `fixtures/recordings/`):

```sh
pnpm llm:smoke
```

Other scripts: `pnpm test`, `pnpm format`, `pnpm format:check`, `pnpm boundaries`.

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

To be written in full. So far:

- **Ingestion** (`packages/ingest`). `ingestDocument` validates the bytes (`validateUpload`), then
  parses them in a `node:worker_threads` worker (`extractPages`) that has a heap limit, an empty
  environment and a hard time limit after which it is terminated. Decoded PDF streams are
  ArrayBuffers outside the V8 heap, which the heap limit does not cap, so the parent also samples
  the worker's heap plus external memory every 25 ms and terminates it over budget
  (`RESOURCE_LIMIT`); this stops decompression bombs. The worker first checks the
  cross-reference structure, because pdfjs silently repairs a damaged table, then extracts page
  text with the shared page-text convention (`assemblePageText` in core). Expected failures are
  returned as one typed error (`IngestError`) with a stable code and a fixed message. Storage is a
  port (`IngestStore`) that `@specledger/db` implements; the document row, the bytes and the pages
  are written in one transaction, and a duplicate upload is detected by the unique sha256
  constraint (insert on conflict do nothing, then select). `apps/api/src/ingestion.ts` wires the
  two together with limits from configuration.
- **Model layer** (`packages/llm`). The model is untrusted: providers return schema-valid
  candidates or a typed `LlmError`, and nothing more is trusted (the verifier is Phase 5).
  `extractWithClient` validates the request, builds chunked prompts (`buildPrompts`), calls a raw
  model client once per chunk, validates each answer against a schema limited to the requested
  fields, and retries an invalid answer with a message listing the schema problems and nothing
  from the document. The Gemini provider uses the Vercel AI SDK's structured output with SDK
  retries disabled, maps HTTP failures to error codes, and refuses requests not flagged synthetic.
  Replay answers from `fixtures/recordings/<key>.json`, where the key is the sha256 of the
  canonical JSON of the model id and the request (which includes `PROMPT_VERSION`). Failover moves
  to the next provider only on `RATE_LIMITED`, `TIMEOUT`, `UNAVAILABLE` and `MODEL_RETIRED`, and
  rests a failed provider for a cooldown. `withLogging` logs ids, model, latency, outcome and
  token counts, never text.

## Limitations

Known gaps at this stage:

- Immutability triggers and constraints protect against application bugs and ordinary SQL, not
  against a database superuser, who can disable triggers.
- The migration drift check compares the schema with drizzle-kit's snapshots. It does not detect
  a hand edit to an already-committed migration file.
- The evaluation corpus is synthetic. It is suitable for regression testing, not as evidence of
  accuracy on real vendor datasheets.
- `pdf-lib`, used only to generate the synthetic corpus, has had no release since 2021.
- Ingestion is strict about PDF structure: a file whose cross-reference table has wrong offsets is
  rejected as `CORRUPT` even though many readers would repair it, and so is anything after the
  final `%%EOF` other than whitespace. Entries inside compressed cross-reference streams are not
  checked individually. Re-saving such a file ("print to PDF") usually fixes it.
- Encrypted PDFs are rejected even when they open without a password (owner-only restrictions).
- Text extraction is pdfjs without OCR, CMaps or embedded-font loading, so scanned pages and some
  CJK or unusually encoded text produce no text. Lines are grouped by baseline rounded to half a
  unit, so text whose baseline straddles a rounding boundary can split into two lines; a quote
  across that split will not be found, which fails safe (the value stays unverified).
- The memory watchdog samples every 25 ms. A decoded buffer that doubles between two samples can
  overshoot the budget, so peak memory per parse is a few times `INGEST_PARSE_MEMORY_MB`, not
  exactly it.
- Each upload starts its own worker thread and parses before the duplicate check, so a repeated
  upload costs a full parse. There is no cap on concurrent parses yet, so total memory grows with
  the number of simultaneous uploads; a concurrency cap and the per-IP rate limit belong with the
  upload endpoint (Phase 8), the first point at which uploads can arrive concurrently.
- Development dependencies carry two moderate advisories, both in tooling only: `minimatch`
  (through ESLint) and `esbuild` (through drizzle-kit's TypeScript loader; the advisory concerns
  esbuild's development server, which is never started). Neither can be overridden without
  breaking the parent package's version range. The CI audit fails on high and above.
- Log redaction matches field names. A secret or document text placed inside a free-text log
  message is not caught, so the rule is to log ids and statuses only.
- On the first push of a branch, the CI commit-hygiene job cannot check the root commit; the local
  pre-push hook covers it.
- Git hooks are local to a clone and can be bypassed with `--no-verify`; the CI check is the
  safety net.

## Model layer limitations

- The only committed recording is handcrafted (the p-108 injection response). Real responses for
  the corpus have not been recorded yet; that is a deliberate later step within the free-tier rate
  limits. Until then Replay answers only that one request.
- The default model id (`gemini-3.5-flash-lite`) was checked against Google's model list in
  November 2026, but no real call has been made from this repository. Models are retired; a
  retired id returns `MODEL_RETIRED`.
- The synthetic-only rule is enforced by a flag on the request, set by the caller. Nothing can
  tell from page text whether a document is synthetic; the flag must only be set for corpus
  documents.
- Failover cooldowns live in memory per process and are not shared between processes.
- Prompt-injection defense here is limited to delimiting the data and instructing the model; a
  model may still obey embedded text. The defense is the verifier (Phase 5), which requires each
  value to be supported by a quote on the page.

## License

MIT. See [LICENSE](LICENSE).
