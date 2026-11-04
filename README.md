# SpecLedger

Every specification, with its proof.

SpecLedger turns vendor equipment datasheets into a verified equipment register. Each extracted
value must carry a verbatim quote that is checked against the source page before a person reviews
it and an approver publishes an immutable register version.

## Status

Phases 0 to 8 of the plan are in place:

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

There is no user interface yet (Phase 9).

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
- Resolution records the decided value, the chosen field if any, the reviewer's role and reason,
  and the candidates seen with their lineage and revision.
- Publishing is refused while a job is queued or running, a latest field is pending review, a
  conflict is open, or reviewed values of equal rank disagree with no decision. A version holds,
  per equipment, the reconciled accepted and edited values and the decisions, as stored text;
  rejected fields are left out. Numbers come from a counter row locked for the transaction, so
  concurrent publishes get consecutive numbers and a refused one uses none.

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
- CSV export prefixes cells that a spreadsheet would read as a formula with `'`, which changes
  those values as text.

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

- The verifier proves that a quote and its number are on the page, not that the quote is about the
  field: a real "Maximum flow: 2596 gpm" offered as the rated flow is verified. Reconciliation and
  human review are the controls for that.
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
