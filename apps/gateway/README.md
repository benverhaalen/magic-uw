# Magic Canvas Jev gateway

A small HTTP proxy in front of TypeSafe's Jev so the desktop app (and
teammates) never see the TypeSafe API key. One key, owned by Magic Canvas,
pays for every request handled by this gateway. Students and teammates call this gateway's URL with
an anonymous device token instead.

Status: implemented and unit/integration tested (`tests/gateway.test.ts`).
Not deployed. A team-wide endpoint still needs a hosting destination, TLS, and persistent storage.

The accepted OpenRouter route will bill Jev through the student's own OpenRouter key instead; that adapter is not implemented here. Claude/Codex/Gemini routes retain this company-funded gateway. See [the product decision](../../docs/decisions.md#pricing-and-ai-access-resolution--september-26).

## Where the key lives

- **Ben (or whoever owns the TypeSafe billing account) sets `TYPESAFE_API_KEY`
  only in the gateway's own server-side environment** — a local `.env` file
  (copy `.env.example` to `.env`; it's gitignored) for local runs, or the
  hosting provider's secret manager for a deployed server. It is never
  committed, never logged, and never sent to a client.
- The key does **not** go in any `VITE_`-prefixed variable, any desktop-app
  config, or anywhere reachable by the Electron/browser bundle. See
  `docs/development.md`.
- **Teammates and students only need the gateway's URL.** They call
  `POST /v1/devices` once to get a bearer token (see below), then use that
  token for judgment requests. They never enter, see, or need a TypeSafe
  account or key.

## Running it locally

```sh
cp apps/gateway/.env.example apps/gateway/.env
# edit apps/gateway/.env and set TYPESAFE_API_KEY

pnpm install
node --env-file-if-exists=apps/gateway/.env --import tsx/esm apps/gateway/src/index.ts
```

Or, if you already export `TYPESAFE_API_KEY` (and any other overrides) in
your shell:

```sh
pnpm gateway
```

Without `TYPESAFE_API_KEY` set, the process logs a `startup_failed` line and
exits immediately — it never falls back to fake or unauthenticated judgments.

## API

### `GET /health`

No auth. Returns `{"status":"ok"}`.

### `POST /v1/devices`

Anonymous device enrollment. Send an empty JSON object `{}` (or a zero-length body). Any supplied fields are rejected. Response:

```json
{ "token": "<opaque bearer token, shown once>" }
```

The token is a high-entropy random value; only its SHA-256 hash is stored in
SQLite. There is no way to recover a lost token — enroll again. Enrollment is
rate-limited by the connecting IP address (`GATEWAY_ENROLL_HOURLY_LIMIT_PER_IP`,
`GATEWAY_ENROLL_DAILY_LIMIT_PER_IP`); the gateway does not trust
`X-Forwarded-For` or similar client-supplied headers for this, so behind a reverse proxy every request is currently counted against the
proxy address. Forwarded headers do not change this. Supporting a trusted
proxy requires an explicit verified proxy allowlist and adapter; this is not implemented.

### `POST /v1/judgments/assignment.kind.v1`

Requires `Authorization: Bearer <token>` from enrollment.

Request:

```json
{ "state": { "course": "...", "title": "...", "text": "...", "policy": "..." } }
```

`course` (≤200 chars), `title` (≤500 chars), `text` (≤12000 chars), `policy`
(≤4000 chars). `text` and `policy` may be empty; a title can still identify an assignment with an empty Canvas description. Unknown keys are rejected. The question and its
category set (`essay`, `problem_set`, `quiz`, `exam`, `discussion`, `project`,
`reading`, `other`) are fixed server-side; the client cannot supply its own
prompt, tool, or URL.

Response:

```json
{
  "kind": "essay",
  "probabilities": { "essay": 0.8, "problem_set": 0.1, "quiz": 0.02, "exam": 0.02, "discussion": 0.01, "project": 0.02, "reading": 0.02, "other": 0.01 },
  "model": "jev-1.13.0",
  "questionVersion": "assignment.kind.v1"
}
```

Only these validated fields are ever returned. The pinned model/version, all eight probability keys, finite values in [0, 1], a total within 0.001 of one, and the selected highest-probability option are checked. These checks establish a valid response, not that its classification is correct. Raw upstream error bodies,
headers, and status text are never reflected back to the client; an upstream
failure becomes a generic `502 upstream_error`.

### Errors

Structured JSON: `{"error": "<code>", "message": "..."}`. Rate-limit and
budget responses are `429` with a `retryAfterSeconds` field and a
`Retry-After` header, e.g. `global_daily_limit`, `device_daily_limit`,
`device_hourly_limit`, `device_concurrency_limit`,
`global_concurrency_limit`, `enrollment_hourly_limit`, `enrollment_daily_limit`, `enrollment_global_daily_limit`.

## Abuse and spend controls

- **Global daily cap** (`GATEWAY_GLOBAL_DAILY_LIMIT`, default **100**): a hard
  ceiling on paid TypeSafe requests per UTC day across every device combined.
  Keep this conservative. It limits attempts through this gateway, not dollars or other uses of the billing account. The fixed question and input limits also bound each request's size; vendor prices still determine the bill.
- **Per-device hourly/daily caps** and **per-device concurrency** limit how
  fast any single enrolled device can spend. A global concurrency cap defaults to 8, and enrollment across all IPs is capped at 500 per UTC day. Concurrency is in-process; operate one gateway process for this version.
- Request budgets are reserved **atomically in SQLite before** the upstream call is
  made, and the reservation is **not rolled back on an upstream error** — a
  blocked request never calls TypeSafe at all, and a failing request still
  counts against the budget so retried failures cannot be used to spend
  without limit. Counters are keyed by UTC day/hour, so they survive a
  process restart without any extra bookkeeping.
- Anonymous enrollment is **not Sybil-proof**: nothing stops someone from
  enrolling many devices from many IPs. The per-IP enrollment caps and the
  global daily request cap are the actual protection for the bill, not the
  enrollment step itself.
- Body size is enforced against bytes actually read from the connection, so a
  missing or lying `Content-Length` cannot bypass the limit. Requests time
  out (`GATEWAY_REQUEST_TIMEOUT_MS`) if the client stalls or upstream hangs. The body-read timeout and upstream timeout are separate phases; the upstream timer covers headers and the entire response body (capped at 64 KiB).
- Upstream redirects are rejected, so credentials cannot be forwarded to a redirected URL. No automatic retry occurs. Disconnecting cancels upstream work but retains the concurrency slot until that work actually settles.
- Device tokens are compared by looking up a SHA-256 hash in SQLite; the raw
  token is never stored or logged.

## Logging and data recipients

Every request produces one constant-shape structured log line: timestamp,
method, known route (unknown paths become `/unrecognized`), status, duration, device id on completed judgments, and an error code when relevant.
**Request/response bodies, headers, tokens, and the TypeSafe API key are
never logged.**

Recipients of student-submitted data through this gateway:

| Recipient | What it receives |
| --- | --- |
| This gateway process | `course`/`title`/`text`/`policy` in memory only, for the duration of the request; not persisted |
| TypeSafe (Jev), via HTTPS | The same `state` fields, plus the fixed question/criteria for `assignment.kind.v1`, to produce the judgment. See TypeSafe's [Data handling](https://docs.typesafe.ai/models.md) and [Legal](https://docs.typesafe.ai/legal.md) pages for their retention/training policy |
| SQLite on the gateway's disk | Device id, hashed token, enrolling IP, enrollment/request timestamps, and request counters — never the submitted course text |

This gateway is one processing hop described in
`docs/ai-and-privacy.md`'s "Jev through our proxy" row; its own logs and
retention are part of that disclosure, not a separate exemption.

## Operator revocation

Run these on the gateway host with the same `GATEWAY_DB_PATH`; they do not need the TypeSafe key:

```sh
node --env-file-if-exists=apps/gateway/.env --import tsx/esm apps/gateway/src/admin.ts list
node --env-file-if-exists=apps/gateway/.env --import tsx/esm apps/gateway/src/admin.ts revoke <device-id>
node --env-file-if-exists=apps/gateway/.env --import tsx/esm apps/gateway/src/admin.ts revoke-all
```

Listing prints only device IDs, creation times, and disabled status. Revocation persists and blocks future requests; a request already in flight may complete. It cannot prevent someone from enrolling a new identity. The global request cap remains the spend backstop. To stop all new paid requests, stop the gateway. Protect and back up its SQLite file; its token hashes, IPs, and counters persist until the operator removes them. Deleting the database resets budgets and invalidates every device token, so never treat an ephemeral database as production budget enforcement.

## Design principles and verification

- Keep the owner credential server-side; expose a narrow capability, not an unrestricted model proxy.
- Reserve spend before starting work, including failed work. Native `fetch` is used here because it has no implicit SDK retries; a future SDK must disable retries or reserve each attempt.
- Validate the actual network response and enforce limits through body completion. Configuration names and comments alone are not a security boundary.
- Keep source content untrusted and choose from fixed categories; a model judgment never authorizes a tool action.
- Collect only operational metadata. Authentication, course text, arbitrary URL paths, and upstream errors must not become logs.
- Anonymous access keeps sign-in effort low but cannot establish one human per token. Document the limitation and rely on a global ceiling.

The HTTP contract and pinned `jev-1.13.0` were checked against TypeSafe's [API](https://docs.typesafe.ai/api.md), [Choice](https://docs.typesafe.ai/primitives/choice.md), and [models](https://docs.typesafe.ai/models.md) documentation on 2026-09-26. Tests use synthetic inputs and local fake responses, including a real local HTTP response that stalls after its headers. They cover restart budgets, revocation, request/response bounds, cancellation, and output validation. They do not measure live model accuracy, latency, billing, or production abuse resistance. No private student data or paid call is needed to run them.

## Deployment status and requirements

If/when this is actually hosted:

- **TLS is required** and is not this process's job — put it behind a
  reverse proxy or platform load balancer that terminates TLS, and keep
  `GATEWAY_HOST=127.0.0.1` so the Node process itself is never directly
  internet-facing.
- Per-IP enrollment limiting sees the proxy address until a trusted proxy adapter is implemented. Do not enable arbitrary forwarded-header trust to work around this. Set aggregate limits for that deployment deliberately.
- Re-check `GATEWAY_GLOBAL_DAILY_LIMIT` and the per-device caps for the
  expected number of real users before raising them from the conservative
  defaults; they are the primary bound on TypeSafe spend.
- Run one process with a persistent SQLite volume. Multiple independent databases would each have their own daily cap. Hosting and TypeSafe costs need operational monitoring before inviting public traffic.

## Client integration

- The workspace has the `pnpm gateway` script and the `zod` dependency this app uses. No SDK or extra service is required.
- The desktop client should call this gateway's `/v1/devices` once (caching
  the returned token locally) and then `/v1/judgments/assignment.kind.v1`
  with that bearer token — never bundle a TypeSafe key into the desktop
  build.
