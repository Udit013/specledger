# SpecLedger

Every specification, with its proof.

SpecLedger turns vendor equipment datasheets into a verified equipment register. Each extracted
value must carry a verbatim quote that is checked against the source page before a person reviews
it and an approver publishes an immutable register version.

## Status

Phases 0 to 11 of the plan are in place:

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
  document, its bytes and its page text in one transaction with deduplication by sha256.
- Model layer: an `LlmProvider` interface with Gemini (free tier, synthetic documents only),
  Replay, Recording and Failover implementations, a prompt builder that keeps document text in
  delimited data blocks, and schema-validated output with bounded correction retries. Tests run
  with every network socket blocked.

- Verifier (Phase 5): text normalization with an offset map back to the page, number parsing
  that refuses ambiguous formats, a units registry with conversion to canonical units, and
  `verifyCandidate`, which accepts a value only when its quote is on the page, the value is in
  the quote, the unit is known and of the right kind, dual-unit statements agree and the value is
  plausible. Written test-first; property tests run with a fixed seed.
- Reconciliation (Phase 6): `reconcile` chooses each field's value for one piece of equipment
  from its verified candidates across documents and revisions (later revision within a lineage,
  then source rank, then merge or conflict at equal rank), respects human decisions, and explains
  every outcome in a decision log.

- Queue and worker (Phase 7): a Postgres job queue with leases, heartbeats, fencing, retries with
  jittered backoff and a dead letter; a worker process; and the `process_document` job, which
  extracts, verifies, reconciles and persists a document's fields, conflicts and audit events in
  one transaction. An upload enqueues its job in the same transaction as the document.

- HTTP API (Phase 8): a Fastify service with bearer-token roles (engineer, approver) declared on
  every route, uploads, field review with optimistic concurrency, structured conflict
  resolution that reconciliation (in the worker and at publish) takes as a human decision,
  register publishing with blockers and consecutive version numbers, CSV and JSON export, the
  audit log, job requeue, and health and readiness probes. See [HTTP API](#http-api).

- Review UI (Phase 9): a React app in `apps/web` with the document list, a review screen showing
  each value beside its source page with the quote highlighted, keyboard review, the conflicts
  panel with evidence and the rules' suggestion, the publish dialog and the audit history. See
  [Review UI](#review-ui).
- Exporters and the ACC-style adapter (Phase 10): deterministic CSV and JSON exports of a
  published version (the JSON carries a schema version and a content hash), and an asset-system
  client with retries, idempotency keys and a drift report, tested against a mock.
  **The real Autodesk API was not used**; see [Exporters and adapter](#exporters-and-adapter).
- Evaluation harness and regression gate (Phase 11): precision, recall, unsupported-value,
  verifier catch and false-reject rates with Wilson intervals, a naive baseline without the
  verifier, a reconciliation check, and a CI gate. **The committed numbers come from simulated
  extractions, not from a language model**; see [Evaluation results](#evaluation-results).

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

The API needs `API_ENGINEER_TOKEN` and `API_APPROVER_TOKEN` in `.env` (generate each with
`openssl rand -hex 32`). It applies migrations at start-up, listens on `HOST:PORT`, and stops
gracefully on SIGTERM or SIGINT. Uploaded documents are processed by the worker (below).

Git hooks (once per clone):

```sh
pnpm hooks:install
```

Integration tests need the local database (`pnpm db:up`) and `DATABASE_URL`. Each test file
creates its own schema, migrates it and drops it afterwards, so files run in parallel. One test
checks that nothing is ever created in the `public` schema, so do not run the worker against the
database the tests use (the worker migrates `public`); give the worker its own database. The
tests run with:

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

The worker process claims jobs from the queue and runs them. It applies migrations at start-up,
extracts with recorded responses by default (`LLM_PROVIDER=replay`), and stops gracefully on
SIGTERM or SIGINT:

```sh
pnpm worker
```

The review UI runs on the Vite dev server, which proxies `/api` to the API (`API_URL`, default
`http://127.0.0.1:3000`), so the API needs no CORS entry locally. Open http://127.0.0.1:5173 and
paste the tokens from `.env`:

```sh
pnpm --filter @specledger/web dev
```

Other scripts: `pnpm test`, `pnpm format`, `pnpm format:check`, `pnpm boundaries`.

## Repository layout

| Path                 | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `apps/api`           | HTTP API and worker entry point                      |
| `apps/web`           | Review UI (React, Vite, TanStack Query, Tailwind)    |
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
  upload costs a full parse. The upload endpoint limits uploads per client IP
  (`UPLOAD_RATE_LIMIT_PER_MINUTE`) but does not cap concurrent parses, so total memory still grows
  with the number of simultaneous uploads from different clients.
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

- **Verifier** (`packages/core`). `verifyCandidate` normalizes the quote and the page the same
  way (`normalizeWithMap`: NFKC, invisible characters removed, quotes and dashes unified, words
  broken at a line end joined, whitespace collapsed) and checks, in order: the quote is long
  enough, it is on the page, the value is among the numbers in the quote (ranges as ranges, and
  ambiguous formats such as `1,234` refused unless the document's decimal mark is known), the
  unit is in the registry and of the field's dimension and is the unit the quote states for that
  value (the unit written immediately after the number), two unit systems in the quote agree within
  0.5 percent by the verifier's own conversion, and the canonical value is in the field's
  plausible range. It reports every failing reason, returns `INTERNAL` instead of throwing on
  unexpected input, and maps the quote back to page offsets for highlighting.

- **Reconciliation** (`packages/core`). Per field: unverified candidates are carried but never
  compete; within a lineage (a series of revisions of one document, assigned by the caller) the
  latest revision supersedes the rest (`compareRevisions`: letters before numbers, unknown labels
  lowest and equal to each other); across lineages the highest source rank wins (datasheet,
  manual, brochure); what is left merges when every pair agrees within 0.5 percent in canonical
  units, and is otherwise an open conflict that is never resolved automatically. A human decision
  stands, and is marked `NEEDS_RE_REVIEW`, never overwritten, when a later revision arrives in a
  lineage it was based on. Every step is a decision log entry (rule id, candidate ids, outcome,
  winners). Input is put in canonical order first, so the result is the same for any input order,
  and reconciling a result again returns it unchanged.

- **Queue and worker** (`packages/db/src/queue.ts`, `apps/api/src/worker/`). The queue is the
  `jobs` table. `claim(now, workerId, visibilityMs)` is one `UPDATE` whose row comes from a
  `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` over jobs that are queued and due or whose lease
  expired with attempts left; it increments `attempts` and leases the job until
  `now + visibilityMs`. Every timestamp is a parameter from an injected clock, never `NOW()`.
  `heartbeat`, `complete`, `fail` and `release` change a job only while `status = 'running' AND
locked_by = workerId` (fencing), so a worker whose lease was taken over cannot touch the job.
  A failed attempt is retried at `now + backoffDelayMs(...)` (full jitter, base and cap, injected
  random source) while attempts remain, then the job is `dead`; permanent errors are `failed`;
  `requeue` brings a dead job back. The worker polls, keeps at most `concurrency` jobs in flight,
  renews each lease every `heartbeatMs`, aborts a handler whose lease was lost, and on shutdown
  stops claiming, waits `graceMs`, then aborts and releases what is left. `process_document`
  calls the model outside any transaction, verifies every candidate, then in one transaction
  locks the equipment row, writes the extraction run (unique per job, so a re-run writes
  nothing), one field per name with its audit event, reconciles the latest fields of every
  document of the tag, and opens each conflict once (a partial unique index allows one open
  conflict per field). Job errors carry a fixed code and message; `last_error` never holds an
  exception's own text.

## HTTP API

Every request needs `Authorization: Bearer <token>` except `/health` and `/ready`. Tokens are
compared as SHA-256 digests with a constant-time comparison; there are no user accounts, and the
audit log records the role (`role:engineer`, `role:approver`). Each route declares the roles that
may call it, and the app refuses to start if one does not.

| Method and path                    | Roles    | Purpose                                                         |
| ---------------------------------- | -------- | --------------------------------------------------------------- |
| `GET /health`                      | public   | Liveness; does not touch the database                           |
| `GET /ready`                       | public   | Readiness; 503 `NOT_READY` if the database does not answer      |
| `POST /documents`                  | engineer | Multipart upload; 202 with the queued job, 200 if a duplicate   |
| `GET /documents`                   | both     | Newest first, with processing status (`limit`, `offset`)        |
| `GET /documents/:id`               | both     | One document with its processing status                         |
| `GET /documents/:id/pages/:n`      | both     | The extracted text of one page                                  |
| `GET /documents/:id/fields`        | both     | The fields of the document's latest extraction run              |
| `PATCH /fields/:id`                | engineer | `accept`, `reject` or `edit` with `expectedVersion`             |
| `GET /conflicts`                   | both     | Conflicts with their candidates (`status=open\|resolved`)       |
| `POST /conflicts/:id/resolve`      | engineer | Choose a candidate or enter a value, with a reason              |
| `POST /register/publish`           | approver | Publish the next register version, or 409 with blockers         |
| `GET /register/versions/:n/export` | both     | `format=csv` or `format=json`                                   |
| `GET /audit`                       | both     | `entity=field:<id>`, `conflict:<id>` or `register_version:<id>` |
| `POST /admin/jobs/:id/requeue`     | approver | Move a dead job back to the queue                               |

Request and response shapes are the Zod schemas in `packages/core/src/api.ts`. Every error is
`{"error": {"code", "message", "details"?}}` with a stable code; validation errors list the
failing paths, never the input. An unexpected error is a 500 `INTERNAL` carrying only the
correlation id, which is the request's `X-Request-Id` when it is short and plain, otherwise a new
UUID, and is echoed on every response and carried by the upload's job.

- Review: a stale `expectedVersion` is a 409 `VERSION_CONFLICT` with the current field. Accepting
  a value the verifier could not confirm needs a reason; an edit must read as a number with a unit
  of the field's quantity.
- Conflicts carry each candidate's evidence (quote and page) and a `suggestion`: what the
  reconciliation rules alone would select from the current candidates, and the rules they applied.
  It is a hint for the reviewer and never applied automatically.
- Values a reviewer enters, in an edit or a resolution, must read as the field's quantity and lie
  in its plausible range, the verifier's rules (d) and (f); otherwise the answer is 400
  `INVALID_VALUE`.
- Resolution records the decided value, the chosen field if any, the reviewer's role and reason,
  and the candidates seen with their lineage and revision.
- Publishing is refused while a job is queued or running, a latest field is pending review, a
  conflict is open, or reviewed values of equal rank disagree with no decision. A version holds,
  per equipment, the reconciled accepted and edited values and the decisions, as stored text;
  rejected fields are left out. Numbers come from a counter row locked for the transaction, so
  concurrent publishes get consecutive numbers and a refused one uses none.

## Evaluation results

Generated from [evaluation/report.json](evaluation/report.json) by `pnpm eval:readme`; CI fails if
this section and the report disagree. Do not edit between the markers.

<!-- prettier-ignore-start -->
<!-- evaluation-results:start -->
> SIMULATED EXTRACTION: candidates generated from the ground truth by a seeded error model (packages/eval/src/eval/simulate.ts), not answers from any language model. The rates measure the verifier, the per-field pick and reconciliation against these designed errors; they are not a measurement of model accuracy.

- Extractions: **simulated** (see the note above)
- Model id: `simulated-error-model-v1`; prompt version: `not-applicable`
- Corpus: `e0caf65c0f9c5ab33d92b499d900da22bca8b065f9490f8ca34719846885719b`, split **dev**
- Extraction set: `6e27be66b126915c2ba91a1d582f745f75ee37bbe0091170ec519a837a7cfc55`, dated 2026-11-04
- 26 documents evaluated of 27 in the split; 188 document fields, 170 with a value in the ground truth, 174 candidates

| Rate | Pipeline (95 % Wilson, fields) | Pipeline, document-clustered 95 % | Count | Naive baseline | Count |
| --- | --- | --- | --- | --- | --- |
| Precision | 100.0 % (97.1 to 100.0) | 87.1 to 100.0 (n ≈ 26.0) | 128 / 128 | 81.0 % (74.3 to 86.2) | 136 / 168 |
| Recall | 75.3 % (68.3 to 81.2) | 68.3 to 81.2 (n ≈ 170.0) | 128 / 170 | 80.0 % (73.4 to 85.3) | 136 / 170 |
| Unsupported-value rate | 0.0 % (0.0 to 2.9) | 0.0 to 12.9 (n ≈ 26.0) | 0 / 128 | 3.0 % (1.3 to 6.8) | 5 / 168 |
| Verifier catch rate | 100.0 % (89.3 to 100.0) | 83.9 to 100.0 (n ≈ 20.0) | 32 / 32 | 0.0 % (0.0 to 10.7) | 0 / 32 |
| False-reject rate | 9.9 % (6.0 to 15.9) | 6.0 to 15.9 (n ≈ 142.0) | 14 / 142 | 0.0 % (0.0 to 2.6) | 0 / 142 |

The verifier prevented 32 wrong values (naive baseline 32, pipeline 0). Full report: [evaluation/report.md](evaluation/report.md).
<!-- evaluation-results:end -->
<!-- prettier-ignore-end -->

What these numbers are: the evaluation runs the pipeline (recorded extraction, the verifier, the
per-field pick, reconciliation) on the synthetic corpus's dev split and compares accepted values
with the ground truth. No recorded answers from a real model exist yet, and none were made,
because real Gemini calls were not authorized for this project. The committed extraction set is
therefore **simulated**: a seeded error model writes candidates from the ground truth with designed
mistakes (misread digits, swapped units, reworded or invented quotes, values taken from another
line, hallucinated values for absent fields, an obeyed prompt injection). The rates show what the
verifier and reconciliation do with those mistakes. They are **not** a measurement of any model's
accuracy, and they say nothing about real vendor documents. How the harness works, the formulas,
and how to record and evaluate a real model are in [docs/evaluation.md](docs/evaluation.md).

```sh
pnpm eval --split dev   # writes evaluation/report.json and report.md
pnpm eval:gate          # compares with evaluation/baseline.json
```

## Evaluation limitations

- The extraction set is simulated (above); a real-model report needs a recording run.
- The corpus is small and synthetic: 26 dev documents with a text layer, each designed difficulty
  a few times at most. The field-level Wilson intervals assume independent fields, which fields of
  one document are not; the report also gives a document-clustered interval (effective sample
  size from the between-document variance), which is the one to quote. At a rate of 100 percent
  it treats each document as one observation, and is wide accordingly.
- After the audit changed the verifier, pipeline precision on the simulated dev set is 100 percent
  (128 / 128). That says the verifier rejects every mistake **this error model** makes on **this
  corpus**; the error model and the label rule were written by the same person, so this is the
  most optimistic reading possible, not evidence about a real model. The holdout report predates
  the change and is superseded (`evaluation/holdout/SUPERSEDED.md`).
- The error model was written by the same person as the verifier, so it may favour mistakes the
  verifier was built to catch. The decoy case (a value taken from another field's line with a unit
  of the same quantity) got through until the audit added rule (g); that rule was designed after
  seeing the case, so the simulated numbers now flatter it.
- The gate checks overall precision and the unsupported-value rate only; recall and per-field
  rates can fall without failing CI.

## Exporters and adapter

`GET /register/versions/:n/export?format=csv|json` renders a published version with
`packages/exporters`, the same bytes for the same version every time.

- CSV (RFC 4180, UTF-8, CRLF): a header `tag,field,value,unit`, one row per field sorted by tag
  then field. A cell is quoted when it holds a comma, quote or line break. A cell a spreadsheet
  would run as a formula (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) is
  prefixed with a single quote, except a plain number such as `-12.5`, which is written as it is.
- JSON: `schemaVersion` (1), `contentSha256`, then the version, approver, publication time and
  items sorted by tag with fields by name. The hash is SHA-256 of the compact JSON of everything
  but itself, in that key order; `verifyRegisterJson` checks it and the schema version.

The adapter pushes a published version to an asset system: `syncRegisterVersion` maps each item
to an asset payload and calls an `AssetSystemClient`; the HTTP implementation retries 429 and 503
honouring `Retry-After` up to a cap, retries timeouts and network failures with jittered backoff,
never retries other 4xx, sends the same `Idempotency-Key` on every attempt, propagates
`X-Correlation-Id`, and returns typed errors. A drift detector compares responses with the
contract and reports added, removed and retyped fields instead of failing. A Fastify mock with
failure switches (429, 503, 400, slow response, response drift, duplicate keys) backs the
contract tests. The contract, its error codes and its retry rules are in
[docs/adapter-contract.md](docs/adapter-contract.md).

**The real Autodesk API was not used.** The contract is ACC-style: written for this project and
checked against the mock only, because free access to Autodesk's API could not be confirmed. The
contract tests prove the client keeps the written contract; they say nothing about Autodesk's
actual paths, fields, status codes or idempotency behaviour. Nothing in the API calls the adapter
yet; it is a library with tests.

## Exporters and adapter limitations

- The adapter targets a contract with a mock, not a verified external API (see above).
- Values are exported as stored text with their units, not converted to canonical units, so the
  CSV has no numeric column computed from a number; a plain-number cell is written unaltered.
- The CSV has no byte-order mark; some spreadsheet programs need one to read UTF-8 (for example
  `°C`) correctly and show mojibake otherwise.
- Only 429 and 503 are retried among HTTP statuses, as the contract says; a 500, 502 or 504 from
  a real gateway would be final.
- The sync writes items one at a time and has no persistence of its own: re-running it is safe
  (the keys repeat) but nothing records which items were pushed.

## Review UI

`apps/web` is React with Vite, TanStack Query and Tailwind. It talks to the API through a typed
client built on the shared Zod schemas in `packages/core/src/api.ts`: request bodies are checked
before they are sent, and every response is validated before a screen sees it.

- Page text is untrusted document content. It is rendered as React text children only, never as
  HTML, so markup in a document is shown literally. The highlight comes from core's
  `locateQuote`, the verifier's own normalization and offset map, so a quote that differs from
  the page only in whitespace, dash or quote variants is still found; when it is not on the page
  the screen says "The quote could not be located on this page." rather than showing nothing.
- Keyboard: `j` and `k` move between fields, `a` accepts, `e` edits, `r` rejects, `?` opens help,
  Escape closes a form or dialog. Shortcuts are off while typing and while a dialog is open.
  Focus moves to the next field after each action, and results are announced through a polite
  live region. Statuses are words with a symbol, never color alone, in fixed-width boxes so a
  change does not move the layout.
- A 409 shows the server's current value and status and keeps the reviewer's change, which can be
  reapplied on the current version or discarded; nothing is overwritten.
- Accepting a value the verifier could not confirm asks for a reason first. Values a reviewer
  enters (edits, resolutions) must also be plausible for the field, the verifier's range rule.
- Tokens: the reviewer pastes the engineer and approver tokens; each request sends the token of
  the role it needs. They are kept in memory and sessionStorage, never in localStorage or the URL.
- The document list polls while a document is queued or running, doubling the delay from 1 s to
  30 s while nothing changes, and stops when everything has settled.

Tests (`pnpm --filter @specledger/web test`) run in jsdom against an in-memory API served by MSW,
including a keyboard-only flow from the list to a published version, hostile page text, 409
handling, and axe checks on the list, review and publish screens.

## Review UI limitations

- axe runs in jsdom, which has no layout, so color contrast is not checked automatically; the
  palette was checked by eye in a browser only.
- There is no upload screen; documents are uploaded with `POST /documents` (curl or a script).
- The review screen shows the page of the selected field only, and it is plain text: there is no
  rendering of the PDF itself, its tables or its layout.
- A reviewer holding only one role's token gets a 403 for the other role's actions; the UI does
  not hide those actions.
- There is no browser end-to-end test yet (Playwright is Phase 12); keyboard flows are tested in
  jsdom with Testing Library, and were checked by hand in a browser against the API.

## HTTP API limitations

- Two static tokens stand in for identity, as specified: anyone holding a token acts as its role,
  the audit log cannot tell two engineers apart, and rotating a token means restarting the API.
- Rate limits are per client IP and kept in process memory, so they reset on restart and are not
  shared between API instances. Behind a proxy, `TRUST_PROXY` must be set for the limit to see
  client addresses rather than the proxy's.
- Publishing reads the review state under the counter lock, which serializes publishes but does
  not lock fields: a review committed while a publish is running may or may not be included.
- Conflict lists load the candidates of each conflict with one query per conflict.
- A document's processing status is its latest `process_document` job; there is no endpoint to
  re-run extraction for a document that succeeded.

## Queue and worker limitations

- Fencing is by worker id, as specified. A worker that pauses for longer than its lease (a long
  garbage-collection pause, a suspended machine) can claim its own still-running job again; it
  detects that and keeps the running attempt rather than starting a second, but the extra claim
  still counts as an attempt. A fencing token per attempt would remove that.
- The handler keeps one field per name per extraction (the first verified candidate in the
  model's order, else the first one) and records how many it dropped in the field's audit event;
  the dropped candidates themselves are not stored.
- Equipment tag, class and the synthetic flag come from the uploader in the job payload; nothing
  checks them against the document's content.
- Reconciliation takes the latest resolved conflict of each field as a human decision. A later
  revision in a lineage the decision was based on opens a new conflict for re-review (its audit
  event says `NEEDS_RE_REVIEW`); the decision keeps standing until it is resolved again.
- Opening a conflict is audited with the `extract` action and actor `system:worker`; there is no
  separate action for it.
- `dead` jobs can be requeued, `failed` (permanent) ones cannot, as specified.
- The worker's tuning (concurrency 2, 60 s lease, 15 s heartbeat, 20 s grace, backoff 5 s to
  5 min) is fixed in `apps/api/src/worker/main.ts`, not configuration.
- Polling is a fixed interval, not LISTEN/NOTIFY, so an idle queue is queried once a second.

## Reconciliation limitations

- Lineage is assigned by the caller. Two documents put in one lineage are compared by revision
  even if they are unrelated, and two revisions put in different lineages are compared by source
  rank and may conflict. The pipeline (Phase 7) has to assign it consistently, for example tag and
  document type.
- Letter revisions are ordered before numbered ones (`Rev Z` before `Rev 0`), which is the common
  convention but not universal; labels outside the accepted forms (`Issue 3`, `Rev 2B`) are
  unknown and rank lowest.
- A human decision is re-reviewed only for a later revision in a lineage it was based on. New
  evidence from a lineage it did not consider, even a datasheet when the decision was made between
  brochures, leaves it standing.
- Merging uses pairwise agreement, so three values each within 0.5 percent of their neighbours
  but not of each other conflict rather than merge.

## Verifier limitations

- Rule (g), `LABEL_MISMATCH`, added by the audit, requires the value to be stated under one of its
  field's labels (`packages/core/src/labels.ts`): the label nearest before the value, the longest
  one where labels overlap, must belong to the field. "NPSH required 14 ft" no longer supports a
  rated head, and "Maximum flow: 2596 gpm" no longer supports a rated flow. The label lists are
  hand-written English; a datasheet that names a quantity in words the lists lack (another
  language, a vendor's own abbreviation) is rejected, which costs recall and fails safe into
  review. A quote that puts the label after the value (`260 ft (head)`) is rejected too. Labels
  prove which quantity a line is about, not that the line is the right one: a rated value stated
  twice with different numbers still needs reconciliation and review.
- A unit binds only to the number written immediately before it. Layouts that put the unit
  elsewhere, such as a table header (`Flow (m³/h): 287`), a unit in brackets (`500 (gpm)`), a
  word in between (`500 nominal gpm`) or a shared unit (`400/690 V`), do not verify. That costs
  recall on real datasheets, never accuracy: the claim stays unverified for review. Every corpus
  value is written value-then-unit and verifies.
- Digits written straight after a letter (`P-101`, `m3`, `DN100`) are treated as part of an
  identifier, not as numbers. A value written that way (`Q=287` is fine, `Q287` is not) is not
  found.
- A range is only read as one when its unit follows the second bound (`2900 to 3600 rpm`);
  `2900 rpm to 3600 rpm` is two separate numbers.
- The dual-unit tolerance is 0.5 percent in the canonical unit, as specified, which for
  temperature is the kelvin: at 80 °C it accepts a °F statement within about ±1.8 °C. A relative
  tolerance in °C or °F would be undefined near zero; tests pin both ends of the band.
- Words joined across a line-end hyphen lose the hyphen even in compound words ("self-\npriming"
  becomes "selfpriming"), so such a quote must be written the same way to match; this fails safe.

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
- `timeoutMs` bounds each provider attempt, so a failover call can take up to the number of
  providers times `timeoutMs`; an overall deadline is set with the abort signal.
- Prompt-injection defense here is limited to delimiting the data and instructing the model; a
  model may still obey embedded text. The defense is the verifier (Phase 5), which requires each
  value to be supported by a quote on the page.

## License

MIT. See [LICENSE](LICENSE).
