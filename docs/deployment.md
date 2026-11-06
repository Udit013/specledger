# Deploying SpecLedger

The free deployment is three services:

| Part           | Where                                         | What runs                                                                                             |
| -------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Database       | [Neon](https://neon.tech) free Postgres       | two databases: the real workspace, and the public demo workspace                                      |
| API and worker | [Render](https://render.com) free web service | `apps/api/dist/serve.js` from the `Dockerfile`: the HTTP API and the extraction worker in one process |
| Review UI      | [Vercel](https://vercel.com) Hobby            | the static build of `apps/web`                                                                        |

Free tiers have limits that shape the demo:

- The Render service **sleeps after about 15 minutes without requests**. The next request wakes
  it, which takes about a minute; queued documents are processed once it is awake.
- The Render instance has **512 MB of memory**; `INGEST_PARSE_MEMORY_MB=128` keeps PDF parsing
  well inside it.
- The **Gemini free tier** has per-minute and per-day request limits. A document is one call
  (more for long documents). When Gemini is rate-limited or down, the worker retries with
  backoff and falls back to recorded answers where one exists (only p-108).
- Content sent to the Gemini free tier may be used by Google. That is why the deployment accepts
  **only the synthetic corpus PDFs** (`UPLOAD_ALLOWLIST=corpus`): nothing else can be uploaded,
  stored or sent to the model.

Account names and screens change; the steps say what to set, and the labels may differ slightly.

## 1. Database: Neon

1. Create a Neon project in **AWS US East 2 (Ohio)**, where `render.yaml` places the API, with
   Postgres 16 (the version CI tests). Leave Neon's optional services (Auth, storage, functions)
   off: SpecLedger does not use them.
2. In **Connection details**, copy the connection string with **pooled connection turned off**
   (the host must not contain `-pooler`). Migrations take a session-level advisory lock, which a
   transaction-mode pooler does not keep.
3. Make sure it ends with `?sslmode=require`. Keep it secret: it contains the database password.

4. For the public demo, create a **second database** in the same project (Neon: **Databases →
   New database**, for example `specledger_demo`) and copy its direct connection string the same
   way. Visitors only ever touch this one; the API refuses to start if it is the same database as
   `DATABASE_URL`.

The API creates the tables itself on first start (forward-only migrations), in both databases.

## 2. API and worker: Render

1. In Render, choose **New → Blueprint**, connect the GitHub repository, and pick `render.yaml`.
   It defines one free web service, `specledger-api`, built from the `Dockerfile`.
2. Render asks for the values marked `sync: false`:
   - `DATABASE_URL`: the Neon connection string from step 1.
   - `GEMINI_API_KEY`: your key from [Google AI Studio](https://aistudio.google.com/apikey).
   - `DEMO_DATABASE_URL`: the demo database's connection string from step 1.4. Leave it empty
     to run without a public demo.
   - `CORS_ORIGINS`: leave a placeholder for now (for example `https://example.invalid`); you set
     it to the Vercel URL in step 4.
3. Render generates `API_ENGINEER_TOKEN`, `API_APPROVER_TOKEN` and `DEMO_SESSION_SECRET` itself.
   The two tokens (in the service's **Environment** tab) are for you and the people you trust with
   the real workspace; demo visitors never need them. The session secret is never shown to
   anyone.
4. Wait for the first deploy, then check the service from your machine:

   ```sh
   pnpm smoke https://specledger-api.onrender.com
   ```

   Every line should say `PASS`. The first request may take a minute while the service wakes.

`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`. If Google retires that model, set a current
free-tier model id in the Environment tab; the worker reports `LLM_MODEL_RETIRED` otherwise.

## 3. Review UI: Vercel

1. In Vercel, **Add New → Project**, import the repository, and set **Root Directory** to
   `apps/web`. `apps/web/vercel.json` supplies the install and build commands (they run from the
   repository root so the workspace packages build) and the security headers.
2. Under **Environment Variables**, add:
   - `VITE_API_URL` = your Render URL, for example `https://specledger-api.onrender.com`
     (no trailing slash). It is read at build time.
   - `ENABLE_EXPERIMENTAL_COREPACK` = `1`, so Vercel uses the pnpm version pinned in
     `package.json`.
3. Deploy. Vercel builds with Node 22 because `apps/web/package.json` declares `engines.node`
   (its default, a newer Node, is refused by the workspace's `engineStrict` setting).

The UI's Content-Security-Policy allows API calls only to its own origin and `*.onrender.com`. If
you host the API elsewhere, change `connect-src` in `apps/web/vercel.json`.

## 4. Connect them

1. In Render, set `CORS_ORIGINS` to the Vercel production URL, for example
   `https://specledger.vercel.app` (exactly, no trailing slash), and save. Render redeploys.
2. Check CORS and an authenticated read:

   ```sh
   SMOKE_ORIGIN=https://specledger.vercel.app SMOKE_ENGINEER_TOKEN=<engineer token> \
     pnpm smoke https://specledger-api.onrender.com
   ```

Vercel preview deployments have other URLs and are refused by CORS; use the production URL.

## 5. Demo data

With `DEMO_DATABASE_URL` set, the service seeds the demo database itself when it starts and finds
it empty: seven synthetic documents (a revision pair, a brochure that disagrees with its
datasheet, a range, and the prompt-injection document), uploaded through the normal ingestion
path and extracted by Gemini in the background. Open the UI, press **Explore the live demo**, and
watch the document list move from Queued to Succeeded. Then follow [docs/demo.md](demo.md).

To start the demo over (visitors share one workspace), reset it with the approver token:

```sh
curl -X POST -H "Authorization: Bearer <approver token>" https://specledger-api.onrender.com/admin/demo/reset
```

That wipes only the demo database and seeds it again (seven new Gemini calls).

To put the same documents into the **real** workspace instead, the upload script still works:

```sh
SEED_API_URL=https://specledger-api.onrender.com SEED_ENGINEER_TOKEN=<engineer token> pnpm demo:seed
```

## Operating it

| Task                          | How                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See logs                      | Render → the service → Logs. Lines are JSON with `correlationId`; tokens, document text and keys are redacted.                                                                          |
| Rotate a token                | Edit `API_ENGINEER_TOKEN` or `API_APPROVER_TOKEN` in Render (any 32 or more URL-safe characters, for example `openssl rand -hex 32`); the service restarts and old tokens stop working. |
| A document is stuck in Queued | The service was asleep; any request wakes it. Jobs that failed with a retryable error retry with backoff; `dead` jobs can be requeued with `POST /admin/jobs/:id/requeue` (approver).   |
| Roll back                     | Render → Deploys → redeploy an earlier commit. Migrations are forward-only: an older build runs against the newer schema, which only ever adds columns, constraints and values.         |
| Start over                    | Demo: `POST /admin/demo/reset` (above). Real workspace: delete the Neon branch's tables (or create a new branch) and redeploy; the API migrates an empty database on start.             |
| Change the model              | `GEMINI_MODEL` in Render. Replay recordings and the evaluation are tied to the prompt version, not the model.                                                                           |

## Security notes

- Demo visitors get a short-lived signed session that works only on the `/demo` routes and the
  demo database. Share the role tokens only with people who should use the real workspace; the
  approver token can publish and reset the demo. Anyone with the engineer token can upload, but
  only corpus PDFs.
- The site runs entirely on Vercel, Render and Neon. Docker on your machine is only for local
  development; it does not need to be running for the deployment.
- Rate limits: 300 requests per minute per client and 10 uploads per minute, per instance
  (`TRUST_PROXY=1` makes them see the client's address behind Render's proxy).
- The Gemini key lives only in Render's environment, never in the UI or the repository.
- See [docs/threat-model.md](threat-model.md) for the rest.
