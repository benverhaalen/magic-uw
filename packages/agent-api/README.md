# @magic/agent-api

The read surface of the open academic data platform ([plan D42](../../docs/plans/2026-09-26-course-backend/plan.md), [spec F3](../../docs/plans/2026-09-26-course-backend/spec.md)): typed, versioned, read-only reads over a student's local course store, for their own study tools and AI clients. The MCP course bank is an adapter over the same grant session.

## Contract

- **Name and version:** `magic.agent-api` **1.0.0**, exported as the `v1` namespace. A client builds against a major version; within it a result never changes shape, and new fields arrive in a minor version. A new major version ships beside the old one. `SUPPORTED_VERSIONS` lists what this build serves.
- **Read-only.** No verb writes coursework, evidence or settings. It works on the app's writer store or on a read-only reader (`createStore(path, { readOnly: true })`); receipts go to the sink you pass (the MCP reader appends them to a log the app imports).
- **Scoped grant on every call.** Each call names a grant (an MCP grant's `clientId` and token) and rechecks it: a revoked or disabled grant, a wrong token, or sharing turned off fails the next call. Only the grant's account × course pairs and categories are visible, excluded courses stay hidden, and every returned free-text field passes the same identity scrubber and `maySend` gate as the course bank and hosted payloads.
- **Budgets, not errors.** Each verb has a token budget (`BUDGET_TOKENS`, about 4 characters a token). A larger result is trimmed (narrower excerpts around the match, then fewer items) and reports `trimmed: true`.
- **One receipt per call,** naming the resources returned and those that contributed deadline evidence.

## Verbs (v1)

| Verb | Input | Returns |
|---|---|---|
| `courses()` | none | granted courses: name, resource count, open assignments, next due date, source coverage |
| `courseGraph({ courseId })` | a course | counts by kind, accepted links by type, assignments without a due date, coverage (`null` if not granted) |
| `resources({ courseId?, kinds?, cursor?, limit? })` | page ≤100 | list rows without bodies, `total`, `nextCursor` |
| `resource({ id })` | one id | the scrubbed item: an excerpt window, parts, deadline, citation (with a projection id for citation checks), freshness |
| `searchPassages({ query, courseId?, limit? })` | ≤20 hits | passage search on the FTS index (BM25, OR); each hit is an excerpt around the match with its citation |
| `assignments({ courseId?, days? })` | window in days | assignments with resolved due and planning dates, conflicts and completion, soonest first |
| `agenda({ days? })` | | `status: "not_built"` (TODO): the core agenda merges planning class meetings, which never leave through the platform; v1 waits for a planning-free variant |

```ts
import { createStore } from "@magic/storage";
import { createReadApi } from "@magic/agent-api";

const store = createStore(databasePath, { readOnly: true });
const api = createReadApi(store, { clientId, token }, { recordReceipt: (r) => log(r) });
const { hits } = api.searchPassages({ query: "enzyme kinetics", limit: 5 });
```

## Layout

- `src/v1.ts`: the v1 verbs, input schemas (zod) and result types.
- `src/session.ts`: the grant session shared with the MCP course bank (grant check, sharing gate, scrub projection, FTS search, receipts).
- `src/budget.ts`: detail levels and `fitToBudget`.

Not here yet (D42): the SQL views, the `@magic/sdk` package and its handshake, and the narrow write path for decks, cards, notes and study records.
