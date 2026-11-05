# Threat model

Scope: the deployed demo (Vercel UI, Render API and worker, Neon Postgres, Gemini free tier) and
the code paths behind it. It lists what is protected, how, and what is not.

## What is protected

| Asset                                         | Why it matters                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| The published register and its audit log      | The product's output: must be correct, attributable and unchangeable once published |
| Review state (fields, conflicts, decisions)   | Wrong state becomes a wrong register                                                |
| Role tokens, the Gemini key, the database URL | Control of the system and of a paid-for (or quota-limited) model account            |
| The model quota                               | Exhausting it takes the demo down                                                   |
| Uploaded documents                            | In a real deployment, confidential vendor data                                      |

## Threats and controls

| Threat                                                                         | Control                                                                                                                                                          | Where                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A document tells the model what to output (prompt injection)                   | Document text sits in marked data blocks the model is told are untrusted; any value must be found in its quote on its page, so an obeyed instruction is rejected | `packages/llm/src/prompt.ts`, `packages/core/src/verifier.ts`    |
| The model invents a value, a quote or a unit                                   | Rules (a) to (g) of the verifier; unverified values never compete and need a reason to accept                                                                    | `verifier.ts`, `labels.ts`                                       |
| A hostile PDF exhausts memory or CPU (decompression bomb, endless parse)       | Parsing in a worker thread with a heap limit, a watchdog counting decoded buffers, and a wall-clock kill; size and page limits                                   | `packages/ingest/src/extractor.ts`                               |
| Script in document text reaches the browser (XSS)                              | Page text rendered as React text only, never HTML; a strict Content-Security-Policy on the UI                                                                    | `apps/web/src/components/SourcePage.tsx`, `apps/web/vercel.json` |
| Spreadsheet formula injection through exports                                  | Cells starting `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` (plain numbers excepted)                                                                      | `packages/exporters/src/register.ts`                             |
| Unauthenticated or wrong-role access                                           | Every route declares its roles; the app refuses to start otherwise; tokens compared as SHA-256 digests in constant time                                          | `apps/api/src/http/auth.ts`                                      |
| Brute force and request floods                                                 | Per-IP rate limits (stricter for uploads), body and multipart size limits, request timeout                                                                       | `apps/api/src/http/app.ts`                                       |
| Strangers sending real or abusive documents to the model through a public demo | `UPLOAD_ALLOWLIST=corpus`: only PDFs whose SHA-256 is in the corpus manifest are accepted; nothing else is stored or queued                                      | `apps/api/src/http/routes.ts`                                    |
| Lost updates between reviewers                                                 | Optimistic versions: a stale write gets 409 with the current state                                                                                               | `apps/api/src/services/review.ts`                                |
| A published version or the audit log is altered                                | Database triggers refuse UPDATE, DELETE and TRUNCATE on the audit log and published versions                                                                     | `packages/db/migrations/0001_immutability_triggers.sql`          |
| Secrets leak through logs or errors                                            | Log redaction by key; error responses carry codes and a correlation id, never stack traces or SQL; tests plant secrets and check logs                            | `apps/api/src/logger.ts`, `errors-and-security.test.ts`          |
| Secrets committed to Git                                                       | `.gitignore`, pre-commit hooks and a CI hygiene job refuse `.env` files and assistant configuration                                                              | `scripts/`, `.github/workflows/ci.yml`                           |
| A compromised dependency                                                       | Pinned versions and lockfile, high-severity audit in CI, minimal runtime image without dev dependencies, non-root user                                           | `Dockerfile`, CI                                                 |

## What is not protected (known limits)

- **Identity**: two shared bearer tokens stand in for users. Anyone holding a token acts as its
  role, and the audit log records the role, not the person. Real accounts (OIDC) are future work.
- **The synthetic flag is a claim**: the uploader states that a document is synthetic. With
  `UPLOAD_ALLOWLIST=corpus` that claim cannot be abused; without it, a token holder could send a
  real document to the Gemini free tier.
- **Rate limits are per instance and in memory**: they reset on restart and do not add up across
  instances.
- **No malware scanning** of uploaded PDFs beyond the parser sandbox; uploads are never served
  back as files, only as extracted text.
- **Free-tier infrastructure**: no SLA, no backups beyond what Neon's free plan keeps, and the API
  sleeps when idle.
- **The ACC-style adapter** is tested against a mock only; it is not connected to a real asset
  system in the deployment.
