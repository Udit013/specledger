# Deploying SpecLedger

The free deployment is three services:

| Part           | Where                                         | What runs                                                                                             |
| -------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Database       | [Neon](https://neon.tech) free Postgres       | two databases: the real workspace, and the public demo (showcase and visitor sandboxes)               |
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
3. Render generates `DEMO_SESSION_SECRET` itself; it signs demo visitor sessions and is never
   shown to anyone. There are no shared tokens: people sign in with their own accounts (step 4).
4. Wait for the first deploy, then check the service from your machine:

   ```sh
   SMOKE_SHOWCASE=1 pnpm smoke https://specledger-api.onrender.com
   ```

   Every line should say `PASS`. The first request may take a minute while the service wakes.

`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`. If Google retires that model, set a current
free-tier model id in the Environment tab; the worker reports `LLM_MODEL_RETIRED` otherwise.

## 3. Review UI: Vercel

1. In Vercel, **Add New → Project**, import the repository, and set **Root Directory** to
   `apps/web`. `apps/web/vercel.json` supplies the install and build commands (they run from the
   repository root so the workspace packages build), the security headers, and a rewrite of
   `/api/*` to the Render service.
2. Under **Environment Variables**, add `ENABLE_EXPERIMENTAL_COREPACK` = `1`, so Vercel uses the
   pnpm version pinned in `package.json`. The UI needs no API URL: it always calls `/api` on its
   own origin. (Delete `VITE_API_URL` if an earlier setup added it; it is no longer read.)
3. Deploy. Vercel builds with Node 22 because `apps/web/package.json` declares `engines.node`
   (its default, a newer Node, is refused by the workspace's `engineStrict` setting).

Why the rewrite: the sign-in session is an HttpOnly, `SameSite=Strict` cookie. Browsers send it
only to the site that set it, so the browser must talk to the API on the UI's own origin. Vercel
forwards `/api/*` to Render, and the Content-Security-Policy allows connections to the page's
own origin only. If you host the API elsewhere, change the `destination` in
`apps/web/vercel.json`.

## 4. The first admin

Accounts are created by an admin, and the first admin is created from your machine, directly in
the Neon database (Render's free plan has no shell). The password is typed without being shown and
is never on the command line:

```sh
DATABASE_URL='<the Neon connection string>' pnpm user create --email you@example.com --name "Your Name" --roles admin,approver,reviewer,engineer
```

Then open the UI, **Sign in**, and add the other people under **Users**: each gets one or more
roles.

| Role     | May                                                      |
| -------- | -------------------------------------------------------- |
| engineer | upload documents and correct (edit) extracted values     |
| reviewer | accept or reject values and resolve conflicts            |
| approver | publish register versions                                |
| admin    | manage users, requeue dead jobs, reset the demo showcase |

Anyone signed in can read the workspace. Forgot a password? An admin can disable the account and
create it again, or you can run `pnpm user set-password --email <email>` the same way as above
(it ends that user's sessions).

## 5. The public demo

With `DEMO_DATABASE_URL` set, the service seeds the demo database's **showcase** itself: seven
synthetic documents (a revision pair, a brochure that disagrees with its datasheet, a range, and
the prompt-injection document), uploaded through the normal ingestion path and extracted by
Gemini once. Seeding is idempotent: a restart, even in the middle of seeding, only adds what is
missing and never extracts a document twice.

- **Anyone** can browse the showcase read-only: open the UI and choose **Browse the showcase**.
- **Try it yourself** gives a visitor a private **sandbox**: a copy of the showcase in its own
  Postgres schema, where they can review, resolve conflicts and publish (marked as simulated).
  Sandboxes cannot upload, requeue or administer, so visitors never cause a model call. A sandbox
  is dropped after its session expires (`DEMO_SESSION_TTL_MINUTES`, default 120), and at most
  `DEMO_MAX_SANDBOXES` (default 50) exist at once.
- Sandboxes can start only once the showcase is fully extracted; until then visitors are told
  the demo is being prepared.

To start the showcase over, an admin signs in and uses **Users → Reset the demo showcase**. That
wipes only the demo database's showcase (sandboxes are untouched) and extracts the seven
documents again (seven Gemini calls).

## Operating it

| Task                          | How                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See logs                      | Render → the service → Logs. Lines are JSON with `correlationId`; passwords, tokens, document text and keys are redacted.                                                               |
| Manage people                 | Sign in as an admin → **Users**: add, change roles (effective at once), disable (ends their sessions).                                                                                  |
| A document is stuck in Queued | The service was asleep; any request wakes it. Jobs that failed with a retryable error retry with backoff; `dead` jobs can be requeued with `POST /admin/jobs/:id/requeue` (admin).      |
| End every demo session        | Change `DEMO_SESSION_SECRET` in Render; sessions are stateless, so all of them stop working, and their sandboxes are dropped after expiry.                                              |
| Roll back                     | Render → Deploys → redeploy an earlier commit. Migrations are forward-only: an older build runs against the newer schema, which only ever adds tables, columns, constraints and values. |
| Change the model              | `GEMINI_MODEL` in Render. Replay recordings and the evaluation are tied to the prompt version, not the model.                                                                           |

## Security notes

- Real workspace: personal accounts, passwords stored only as scrypt hashes, sessions stored only
  as SHA-256 hashes, HttpOnly `SameSite=Strict` `Secure` cookies, and an anti-forgery header on
  every write. Sign-in attempts are limited to `LOGIN_RATE_LIMIT_PER_MINUTE` (default 5) per
  client; an unknown email and a wrong password get the same answer.
- Demo: visitor sessions are signed, expire, and work only on `/demo` routes and the visitor's
  own sandbox schema. The showcase is read-only. Workspace sessions are refused on demo routes
  and demo sessions everywhere else.
- Rate limits: 300 requests per minute per client, 10 uploads per minute, 10 demo sessions per
  minute, per instance. `TRUST_PROXY=2` makes them see the client's address behind Vercel's and
  Render's proxies. A client that calls the Render URL directly can spoof that address, which
  only lets it choose its rate-limit bucket.
- The Gemini key lives only in Render's environment, never in the UI or the repository.
- The site runs entirely on Vercel, Render and Neon. Docker on your machine is only for local
  development; it does not need to be running for the deployment.
- See [docs/threat-model.md](threat-model.md) for the rest.
