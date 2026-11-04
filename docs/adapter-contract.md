# ACC-style asset adapter contract

> **ACC-style and unverified.** This contract was written for SpecLedger to show how a published
> register would be pushed to an asset system such as Autodesk Construction Cloud (ACC). It has
> **not** been checked against the real Autodesk API, because free access to it could not be
> confirmed. Every statement here describes the contract and the mock in
> `packages/exporters/src/adapter/`, nothing more. Before connecting a real system, its own API
> reference has to be read and this document reconciled with it.

## Mapping a register item to an asset

One item of a published register version becomes one asset upsert. `assetPayloadFor(version,
item)` builds the payload; `assetPayloadSchema` validates it before it is sent.

| Asset payload field      | Source                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| `externalId`             | `specledger:` followed by the item's tag, e.g. `specledger:P-106` |
| `name`                   | the tag                                                           |
| `attributes[]`           | one per field of the item, sorted by field name                   |
| `attributes[].name`      | the field name, e.g. `rated_head`                                 |
| `attributes[].value`     | the value as stored text, e.g. `260`                              |
| `attributes[].unit`      | the unit as stored, e.g. `ft`                                     |
| `source.system`          | always `specledger`                                               |
| `source.registerVersion` | the published version number                                      |
| `source.publishedAt`     | when the version was published, ISO 8601                          |

Values are sent as the text the reviewer accepted, with their units, not converted: the register
is the record of what the documents said and what a human decided.

## Request

```
POST {baseUrl}/assets/upsert
Content-Type: application/json
Authorization: Bearer <token>          (when configured)
Idempotency-Key: <key>                 (every request)
X-Correlation-Id: <id>                 (when the caller has one)

<asset payload>
```

The target matches on `externalId`: an unknown one creates the asset, a known one updates it as
a new revision.

### Idempotency key

Every request carries `Idempotency-Key`: printable ASCII without spaces, 1 to 255 characters.
SpecLedger derives it from the version and the tag, `specledger:register:v<number>:<tag>`
(`idempotencyKeyFor`), so a retried request, or a whole sync run again, repeats the same key.

The contract requires the target to keep each key with a hash of its request body and its
response, and then:

- the same key with the same body returns the original status and body, and writes nothing;
- the same key with a different body is refused with 409 `IDEMPOTENCY_CONFLICT`.

This is what makes retries safe: when a response is lost after the target processed the request
(a timeout, a dropped connection), the retry is answered from the record instead of writing a
second revision.

### Correlation id

`X-Correlation-Id` is passed through from the caller (for example the publish request's id), so
one id ties the API logs, the job and the target's logs together. The mock echoes it.

## Responses

| Status | Body                                                        | Meaning                    |
| ------ | ----------------------------------------------------------- | -------------------------- |
| 201    | `{ assetId, externalId, revision: 1, created: true }`       | created                    |
| 200    | `{ assetId, externalId, revision: n, created: false }`      | updated as revision n      |
| 400    | `{ error: { code: "VALIDATION", fields: [paths] } }`        | payload refused            |
| 401    | `{ error: { code: "UNAUTHORIZED" } }`                       | token refused              |
| 409    | `{ error: { code: "IDEMPOTENCY_CONFLICT" } }`               | key reused with other body |
| 429    | `{ error: { code: "RATE_LIMITED" } }`, optional Retry-After | slow down                  |
| 503    | `{ error: { code: "UNAVAILABLE" } }`, optional Retry-After  | try again later            |

`Retry-After` is either delay-seconds (`120`) or an HTTP date (`Sat, 01 Jun 2030 12:00:30 GMT`),
as RFC 9110 defines it.

## Client error taxonomy and retry rules

`createHttpAssetClient` implements the `AssetSystemClient` port. It returns a typed `Result` and
never throws for an expected failure.

| Code                    | When                                                   | Retried?                     |
| ----------------------- | ------------------------------------------------------ | ---------------------------- |
| `VALIDATION_FAILED`     | 400 or 422, or a payload or key refused before sending | no                           |
| `UNAUTHORIZED`          | 401 or 403                                             | no                           |
| `IDEMPOTENCY_CONFLICT`  | 409                                                    | no                           |
| `RATE_LIMITED`          | 429                                                    | yes, within the limits below |
| `UNAVAILABLE`           | 503                                                    | yes, within the limits below |
| `TIMEOUT`               | no answer within the per-attempt timeout               | yes, with backoff            |
| `NETWORK`               | connection failure                                     | yes, with backoff            |
| `RESPONSE_SCHEMA_DRIFT` | a success body missing a field or with a field retyped | no                           |
| `UNEXPECTED_STATUS`     | any other status, including other 5xx                  | no                           |
| `ABORTED`               | the caller's signal fired                              | no                           |

Retry limits (all configurable, defaults shown):

- at most `maxAttempts` (4) attempts, each with its own timeout (`timeoutMs`, 10 s) covering the
  response body;
- a 429 or 503 waits exactly what `Retry-After` says; without it, full-jitter exponential backoff,
  `random() × min(maxMs, baseMs × 2^(attempt−1))` with 250 ms base and 5 s cap;
- a `Retry-After` longer than `maxRetryAfterMs` (30 s) is not waited for: the call fails at once
  with `retryAfterMs`, so a caller is never blocked for an unbounded time and can reschedule;
- every attempt sends the same `Idempotency-Key` and `X-Correlation-Id`.

Errors carry the HTTP status, the attempt count, whether a later try could succeed, the field
paths the target refused (never their values), and for drift the report.

## Response drift

The contract's success body is described as a shape (`ASSET_RESPONSE_SHAPE`). `detectDrift`
compares a response with it and returns a report instead of throwing: every field `added`,
`removed` or `type_changed`, with its dotted path and the expected and actual JSON types.

- Only added fields: the response is still read, and the report comes back with the result
  (`drift.compatible: true`), so new fields in the target's API are noticed without breaking.
- Anything removed or retyped: the call fails with `RESPONSE_SCHEMA_DRIFT` and the report.

## The mock

`createMockAssetServer()` is a Fastify server on the loopback interface implementing this
contract, with failure switches applied to the next requests in order:

| Switch                                 | Effect                                                                |
| -------------------------------------- | --------------------------------------------------------------------- |
| `{ kind: 'rate_limited', retryAfter }` | 429, with `Retry-After` if given                                      |
| `{ kind: 'unavailable', retryAfter }`  | 503, with `Retry-After` if given                                      |
| `{ kind: 'validation' }`               | 400 with a field path                                                 |
| `{ kind: 'slow', delayMs }`            | processes the request, then holds the response back                   |
| `{ kind: 'drift', mode }`              | processes, then answers with an `extra`, `missing` or `retyped` field |

Duplicate keys always replay the original response. The mock counts writes and assets so tests
can prove that a retried or duplicated upsert wrote once.

## What the contract tests prove, and what they do not

They prove that the client keeps this contract: it retries what the contract says is retryable,
waits as the target asks within the cap, never retries a validation error, sends the same key on
every attempt, and reports drift without crashing. They do not prove that the real Autodesk API
uses these paths, fields, status codes, header names or idempotency semantics. To find out, one
would read the ACC Assets API reference, obtain a sandbox account, record real responses for
each case (success, validation error, rate limit, outage), and replace the mock's answers with
those recordings so the same contract tests run against them.
