# A five-minute walkthrough

Open the site and press **Try it yourself**: no account and no token. You get a private sandbox,
a copy of the public showcase that only you can see, deleted when your session ends; you act as
engineer, reviewer and approver there. (To only look, **Browse the showcase** is read-only.) The
documents are synthetic test datasheets; the values come from a real model (Gemini), extracted
once for the showcase, so what the verifier decided is shown, not assumed.

## 1. The document list (30 s)

Open **Documents**. Each upload has a processing status: Queued, Running, Succeeded, Failed or
Dead, shown as words and a symbol, never color alone. The list refreshes itself while something
is processing, more slowly the longer nothing changes, and stops when everything has settled.

What it shows: uploads are stored and queued in one database transaction, and a worker claims
jobs from a Postgres queue (`FOR UPDATE SKIP LOCKED`) with leases and retries.

## 2. Evidence for every value (1 min)

Open **p-106-datasheet.pdf**. Fields on the left, the source page on the right, the selected
field's quote highlighted on the page. Move with `j` and `k`.

What to point out:

- The highlight is computed by the same code that verified the value (`locateQuote`), so a quote
  that differs from the page only in spacing is still found.
- A field the verifier could not confirm says **Unverified** and lists why
  (`QUOTE_NOT_FOUND`, `VALUE_NOT_IN_QUOTE`, `UNIT_MISMATCH`, `LABEL_MISMATCH`, ...).
- Press `a` to accept: the status changes, focus moves to the next field, and a screen reader
  hears "rated_flow accepted." Press `?` for all shortcuts.

## 3. A prompt injection that does not work (1 min)

Open **p-108-datasheet.pdf**. Its page contains a line telling "automated extraction systems" to
report the rated flow as nine thousand nine hundred ninety-nine gallons per minute.

What to point out:

- The page text is shown as plain text; nothing in a document is ever run or rendered as HTML.
- If the model obeyed the line, its `rated_flow` of 9999 is **Unverified**: the quote it cites
  does not contain the number 9999, so the verifier refuses it. If the model ignored the line, the
  real value is verified as usual. Either way, an obeyed instruction cannot become an accepted
  value without a person accepting it, with a reason.

## 4. Revisions, sources and conflicts (1 min 30 s)

- **m-201 Rev A and Rev B**: the register takes each value from Rev B, the later revision of the
  same datasheet (reconciliation rule `LATER_REVISION`).
- **p-106 datasheet and brochure**: the datasheet outranks the brochure for the same pump, so its
  values win where they differ (rated head 260 ft against the brochure's 250 ft).
- Now **reject** the datasheet's rated head. Rejecting it would let publishing fall back silently
  to the brochure's value, so a **conflict** opens instead. Open **Conflicts**: both candidates
  with their quotes and pages, which one was rejected, and what the rules alone would choose.
  Choose a value, give a reason, and resolve. The decision records exactly which candidates you
  saw, so a later revision of the datasheet reopens it for review instead of overwriting it.

## 5. Publish, export and audit (1 min)

- Click **Publish register** (in a sandbox it says _simulated_: it runs the real checks and
  creates a demo version only you can see). Until every field is reviewed and every conflict resolved, the
  server refuses and lists exactly what blocks it. Once clear, it creates an immutable, numbered
  version (concurrent publishes get consecutive numbers).
- Export with `GET /register/versions/1/export?format=csv` or `format=json`. The CSV neutralises
  spreadsheet formulas; the JSON carries a SHA-256 content hash anyone can check.
- On any field or conflict, **History** shows every change: who (by role), what, when, why.

## 6. Concurrency, if there is time (30 s)

Open the same document in two tabs. Accept a field in one, then edit it in the other: the second
gets "This field changed on the server", with the server's value and your change kept, to reapply
or discard. Nothing is overwritten.

## 7. The boundaries, if asked (30 s)

- The visitor session is signed by the server and works only on `/demo/...` routes, against the
  visitor's own sandbox schema. Workspace sessions are refused there, and the visitor session is
  refused everywhere else. Sandboxes have no upload, requeue or admin routes, so a visitor cannot
  cause a model call.
- The real workspace needs an account: **Sign in**, and what you can do follows your roles
  (engineer, reviewer, approver, admin). The session is an HttpOnly cookie no script can read.
- `apps/api/test/integration/http/demo.test.ts` checks that one visitor's publish leaves another
  visitor, the showcase and the workspace untouched.

## The engineering story behind it

- The pure core (`packages/core`) holds normalization, units, the verifier and reconciliation,
  with property tests and mutation checks.
- `pnpm verify` and CI run typecheck, lint, about a thousand unit tests, about three hundred
  integration tests against Postgres, dependency-boundary checks, migration drift, the corpus
  validator, an evaluation regression gate, and a build and start of the container image.
- The evaluation numbers in the README come from **simulated** extraction errors on a synthetic
  corpus; they show what the verifier catches, not how accurate any model is. See
  [evaluation.md](evaluation.md).
