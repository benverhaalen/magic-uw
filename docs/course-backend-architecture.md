# My Magic UW backend reference

**Role:** the detailed reference behind [the architecture](architecture.md), which is canonical. This page keeps what is too detailed for it: the schema history, the agent-runtime mechanisms with their measured effects, the job-handler contract, freshness, the measured effect of each design choice, the frontend's query path, the command bar and the open human calls. Status per feature is in [implementation status](implementation-status.md); measurements and methods are in [benchmarks](benchmarks.md); the build specification is [the course-backend plan folder](plans/2026-09-26-course-backend/) (where they differ on a design, the plan folder wins). **Checked against `main` at `42217fb`, September 27, 2026.**

## 1. Summary

The backend connects to the sources the student's own UW sign-in can read, stores them in one SQLite file as versioned resources and passages with exact offsets, maps each course by code, generates study material with one checked call on the student's own AI client, and runs study at zero model tokens. The system picture, processes, packages and data flow are in [the architecture](architecture.md).

### 1.1 Status labels

The labels are defined once, in [implementation status](implementation-status.md): researched, proposed, built, tested in isolation, integrated, demonstrated. "Demonstrated" always names its evidence; the live evidence so far is the operator's own account, reported as aggregates only.

## 2. Where we are

Status per feature moved to [implementation status](implementation-status.md). **Gates:** T02 (the operator signs off the AI boundary) is still open. The open human calls are in [§12](#12-open-human-calls).

## 3. Process model

See [architecture §2](architecture.md#2-processes).

## 4. Data flow: from sign-in to study

See [architecture §4](architecture.md#4-sync) for sync and [architecture §6](architecture.md#6-the-ai-boundary) for generation. The same stored result serves every later request: a repeat costs 0 tokens through the content-hash cache, and study reads only stored artifacts.

## 5. Storage

One file, one writer, schema versions owned only by `packages/storage` (`SCHEMA_VERSION = 14` on `main`, from `privacy-v14.ts`). All pending steps run in one `BEGIN IMMEDIATE` after a `VACUUM INTO` backup copy, so a failure can't leave an intermediate version.

| Version | What it adds | Status |
|---|---|---|
| v1–v3 | `sources`, `resources`, `resource_versions`, `resource_changes`, `completions`, `preferences`, `links`, `jobs`, `judgments`, `attempts`, `receipts`, `scope_baselines`, `course_overrides`, `sync_runs`, `mcp_grants` | integrated |
| v4 | planning: `planning_sources`, `planning_captures`, `planning_records`, `planning_versions` (local only) | integrated |
| v5 | `course_intelligence`: the course profile with quoted policy, grading and topics ([course intelligence](course-intelligence.md)) | integrated |
| v6 | the course core: `passages`, `passage_fts` (contentless-delete FTS5 by passage rowid), `passage_vocab`, `course_sessions`, `assessments`, `assessment_scope`, `map_links`, `course_spaces`, `extraction_recipes`, `course_briefs`, `material_facts`, `life_items`, `compile_runs`, `ledger`, `ui_events`, `field_seen`; jobs gain subjects; the old whole-document `resource_search` is dropped | integrated |
| v7–v8 | learning and practice: `learning_courses`, concepts and aliases, items with sources, concepts and checks, cards and reviews, attempts, self-ratings, disputes, artifacts, coverage, sessions, concept state, stars, option tags, views | integrated |
| v9 | course-space observations (the access state of every course space, persisted) | integrated |
| v10 | the course graph: `external_refs`, `resource_refs` | integrated |
| v11 | notes: `notes`, `note_versions`, `note_links`, `note_template_choices`, `note_suggestions`, `note_remotes`, `note_sync_settings` | integrated |
| v12 | planning indexes and capture pruning | integrated |
| v13 | a receipts index for the 90-day retention roll-up | integrated |
| v14 | encryption at rest (AES-256-GCM, key wrapped by `safeStorage`, destroyed on purge) for mail fields, notes text, planning captures and `life_items` | integrated (#25) |

- **Every content table cascades from `sources(id)`,** directly or through `resources`, and purge enumerates `sqlite_schema` rather than a fixed list, so no derived table survives "Delete local data".
- **Courses are not a table.** A course is `(accountScope, courseId)` on `sources`; `learning_courses` anchors the learning tables.
- The grouping of these tables for developers is in [the platform document §3](academic-data-platform.md#3-the-agent-first-academic-database).

## 6. The agent runtime

**Order of methods.** Every decision goes to the cheapest method that can be right:
1. **Code** for exact facts: dates, IDs, submission types, permissions, quotes, and most material roles (96.4% of 673 live materials categorised by code, #13).
2. **Jev** for small typed judgments code can't make, one per item, cached by a title-and-text hash so a grade or submission change costs 0 Jev budget (#14).
3. **One checked call** to the student's AI where language must be read or written: a pass tier first, escalation to the strong tier only when the output fails its schema or checks.

**How a call is made** (`packages/runner`, `packages/packs/core`, `packages/core/src/pack-handler.ts`):

| Mechanism | What it does | Measured effect |
|---|---|---|
| **No tools** | the CLI runs with tools off, the prompt on stdin, and a strict JSON schema; course text is framed as untrusted reference data (`POOL_PROTOCOL`) | untrusted course text can't trigger an action; argument lists checked against a fake CLI (`tests/runner.test.ts`) |
| **Byte-stable course prefix** (O8) | system text, then the course frame (course, sections, the course-intelligence profile, the effective AI policy), then the question last; the prefix depends only on the pack and the course | lets the provider's prompt cache hit across calls for one course; the provider-side hit rate is not measured |
| **Content-hash cache** | pack version + prefix + input + passages → one key | a repeat writes a `cache_hit` ledger row and costs 0 tokens (`tests/packs.test.ts`) |
| **Warm session pool** (D38) | an interactive lane per course, a rotated background lane, escalation on demand; `warm()` starts the CLI with the prefix and sends nothing | 5.8–7.4 s per cold `claude -p` against 1.7–2.2 s warm on one laptop ([plan D38](plans/2026-09-26-course-backend/plan.md)); two quiz calls → one spawn (#14). Codex stays one-shot |
| **Instant mode** (D50) | runs the student's already signed-in Claude Code or Codex with the app's configuration as flags only (`--safe-mode` for Claude Code; `--ignore-rules`, replaced base instructions and tools off for Codex), offered only after `--help` confirms the flags; nothing is written to the student's settings | input tokens 3,021 → 1,298 (Claude Code), 21,424 → 6,373 (Codex) (#29) |
| **Client health** (D51) | a typed state checked before every run: not installed, not signed in, plan insufficient, usage limited with the reset time, model unavailable, offline, ok | one notice with the next step instead of a failed call (#29) |
| **Background budget** | a daily token limit on work the student didn't start, and a pause after a provider usage limit | protects the student's plan limits (`packages/runner/src/runner.ts`) |
| **Ledger** | one row per call, cache hit or intent route | the student sees each action's use |

**The course brief.** The checked syllabus brief (D34, `course_briefs`) is written by the `course.facts` drain job through the student's own client, with a local fallback (#45, on `main`); packs, guides and the grounded ask open with it as a stable prefix. How it relates to the course-intelligence profile is open decision H6.

**Study at zero tokens.** `readPackArtifact` takes no runner, and the learning engines have no runner dependency, so no study-time path can call a model.

## 7. Privacy and consent layers

See [architecture §10](architecture.md#10-privacy-and-consent) and, per egress path, [AI and privacy](ai-and-privacy.md). Microsoft scopes are read-only except the app's own OneDrive folder and one calendar event per click the student confirmed; `Mail.Send` and `Mail.ReadWrite` are never requested ([Outlook setup](outlook-setup.md)).

## 8. One job drain

There is exactly **one job drain** in the app: core's pipeline loop (`packages/core/src/jobs/pipeline.ts`, over `createDrain` in `packages/core/src/drain.ts`). Core has no inline drain; `saved()` and `wake()` only wake the loop. Every kind runs there as a registered handler: the material pipeline's code jobs (`passages.resource`, `link.resource`, `compile.course`) and Jev's `enrich.resource` (`jobs/enrich.ts`).
- **Idle-only and sliced:** a slice starts after a quiet gap (3 s), leases at most 20 jobs while the student is present (200 away), then yields.
- **Never during a sync:** `syncStarted()` aborts the slice between jobs and nothing is leased, whatever wakes it, until `syncEnded()`. The desktop worker wraps `ingestion.tick` with both.
- **Retry-after:** a handler's `defer` returns the job to pending without spending an attempt and sets a durable per-kind cooldown; the loop wakes itself when it ends, also after a restart.
- **Errors:** a thrown handler error is a retry, and its message is recorded on the job.
- **Cancellation:** purge, a privacy change and close abort the running slice between jobs and cancel an in-flight Jev call (its result is discarded; no receipt claims a failure).

**Registering a kind** (for example a `course.facts` job): add a `JobHandler` to the registry passed to `createCore({ jobs })` (the worker passes `pipelineJobRegistry()` in `jobs/default-registry.ts`). Register before `createCore`: the loop fixes its kinds when it starts. Core adds `enrich.resource` itself.

```ts
interface JobHandler {
  kind: string;                         // "area.name", unique
  subject: "resource" | "course" | "assessment";
  ready: boolean;                       // false: a stub, never enqueued or leased
  owner: string;
  onSave?(resource: Resource): boolean; // save → enqueue for resource subjects; course subjects get one job per course at its inventory hash
  available?(ctx: { store }): boolean;  // checked before every lease; false leaves the kind queued (Jev: gateway + maySend)
  run(job, { store, now, signal }): Promise<
    | { status: "done" }
    | { status: "retry"; error: string }               // backoff, then the store's retry limit
    | { status: "stop"; error: string }                // refused (consent): finish with the error, end this wake
    | { status: "defer"; until: string; error: string } // retry-after: no attempt spent, the kind waits
  >;
}
```
A handler that sends goes through egress itself (manifest, receipt, re-check after the call), as `enrich.resource` does.

## 9. Freshness

- **Canvas (D37).** The account-wide activity stream doesn't carry files, pages or module items (its item types are listed in [canvas-lms `lib/api/v1/stream_item.rb`](https://github.com/instructure/canvas-lms/blob/master/lib/api/v1/stream_item.rb); sourced, checked 2026-09-26), so it can't see a quietly added lecture file. The app runs a hot tick on `todo` and `upcoming_events` every 5 minutes, a per-course content probe every 15 minutes and on focus, and warm reads only of the courses that moved.
- **Presence.** Signed-in reads run only while the student is present (input in the last 30 minutes, screen unlocked); credential-free feeds run while away; one catch-up read on return. No request keeps a UW session alive.
- **Scheduler (T17).** Six requests in flight per host, honouring Canvas's `X-Rate-Limit-Remaining` and cost headers and backing off on 403 and 429; module items read inline; identical GETs within a sync read once (#8).
- **Microsoft Graph.** Delta queries per mail folder and a −14…+120-day calendar window; a check with nothing new costs one request per folder; 410 restarts the stream, 429 and 503 honour `Retry-After` (`packages/connectors/src/graph.ts`).
- **Files.** Unchanged files are skipped from the Files list's `updated_at` and size before any request (#22).

## 10. Where the design is novel, and the measured effect

Measurements are on one Windows 11 laptop unless marked live. Synthetic results say where time and bytes go; only rows marked live say anything about real UW timing. The consolidated table with methods and caveats is [benchmarks](benchmarks.md).

| Choice | What we did | Measured effect | Status |
|---|---|---|---|
| **Automatic Canvas connection for a student alone** | the student's own UW sign-in; no institution setup, no developer key | live: sign-in to confirmed 16.5 s; first read of 6 courses in 65 s (before T17) | demonstrated |
| **Passages with offsets and contentless FTS** (D46) | text stored once; FTS5 in contentless-delete mode keyed by passage rowid; OR + BM25 with a term-coverage gate so "not in your materials" is a real answer | ingest 78 → 1,431 resources/s; search p50/p95 56/197 → 3.3/4.8 ms; 15.6 → 10.3 MB per 1,000 resources; question recall@5 0 → 1.00 on 52 builder-written planted questions (MT1, synthetic) | integrated |
| **Code-first course mapping** | material roles, dates, terms, formulas and assessments covered, each with a basis and a quote | live: 96.4% of 673 materials categorised with 0 model calls; references recall 100% of 175 body links (#13) | demonstrated |
| **Code-first Jev** | code decides quiz and discussion items from submission types; Jev sees the title, ≤2,000 characters and the clipped item policy | 100 → 50 Jev calls on a synthetic 100-assignment course (#14) | tested in isolation |
| **Per-course change detection** (D37) | hot tick plus per-course content probes | a hot tick is 1–1.7% of a full sync (synthetic) | integrated |
| **Bounded concurrent sync** (T17) | per-host scheduler with Canvas's own rate-limit headers | replay: 115 → 65 requests, 5.7 → 2.1 s (#8) | integrated |
| **Session file downloads to verified hosts** | main follows Canvas's redirects itself; only the Canvas hop carries cookies | synthetic: files with text 0/300 → 285/300; 4 syncs → 1 (#22). Electron 44's `session.fetch` rejected every redirect, so a live run on 2026-09-27 lost 386 of 386 files; `sessionHopFetch` fixes every session read (#53, a 12 MB file byte-exact over local servers) | integrated (the redirect fix since #53) |
| **Warm pool and instant mode** | one warm session per course; the student's own signed-in client with flags only | 5.8–7.4 s → 1.7–2.2 s per ask; input tokens 3,021 → 1,298 (Claude Code), 21,424 → 6,373 (Codex) | integrated |
| **Speculative intent routing** | the AI branch prepares in parallel with a 20 ms code resolver and sends only on a miss | code hit p50 1.1 ms, 0 calls; a code miss adds p95 −0.9 ms against AI-only (fake CLI at 800 ms, #24) | tested in isolation |
| **Grant-scoped read-only course bank** | the MCP reader opens the file read-only and searches `passage_fts` within the grant | search p50 6.3 s → ≈0.28 s at 5,000 resources (#19) | integrated |
| **Scoped queries instead of snapshots** | summary, paged course views, one resource, and an exact change cursor | 30.6 MB snapshot → 17.5 KB summary (MT1, synthetic); the renderer switch is the frontend owner's | tested in isolation |
| **One-transaction migrations with a backup** | `VACUUM INTO`, then every step in one `BEGIN IMMEDIATE` | v5 → v7 with backup in 1.60 s, 0 rows lost (MT1, synthetic) | integrated |
| **Code-verified quotes** | every quote checked against the exact passage version; a sentence with no checked quote is dropped | no public tool we checked states that it verifies quotes ([platform §8](academic-data-platform.md#8-scorecard)) | integrated (generation and the grounded ask; sentence binding since #59) |

**Quality is not yet benchmarked.** The blind quality run on a public MIT OpenCourseWare course (spec B6, [benchmarking](notes/benchmarking.md)) has its protocol fixed; its results, including rows we lose, go to [benchmarks](benchmarks.md).

## 11. Frontend surfaces the backend serves

The UI will change with the team's design direction ([DESIGN.md](../DESIGN.md)). Channels are in `apps/desktop/src/preload.ts`, handled in `main.ts`; commands go through `magic:execute` (`commandSchema` in `packages/contracts/src/index.ts`).

| Surface | Calls | Status |
|---|---|---|
| Onboarding: agreement → UW sign-in → Your courses → your AI → appearance → connections | `magic:onboarding`, `consent`, `magic:signin`, `magic:sync` | integrated |
| Home, Courses and the course page, Calendar, My UW, Sources (the designed desktop, [desktop handoff](design-handoff.md)) | `snapshot`, page views, `day-plan`, `magic:planning-sync`, `planning-*` | integrated |
| Course item and study panel | `learning` (`study.*`, `notebook.ask`) | integrated |
| Study & Learn, the item space, the Home study card (#57) | `study.prep`, the item-space list, packs | integrated |
| Course page Analytics tab (#55) | `snapshot` plus three batched learning calls | integrated |
| Workspace tools (labelled previews, #30): agenda, references, guides, practice, analytics, mastery, notes, Outlook, course facts, page views | scoped queries, `magic:graph`, one learning or notes op per tab | not mounted on `main` since the design integration; the component remains in `renderer/backend/` |
| Settings: data, privacy and the course bank | `privacy`, `purge`, `mcp-grant`, `magic:mcp-export` | integrated |
| Chat pane and command bar (D40) | `command` and `intent.preview` (intent router) | the chat pane runs read-only intents (ask, agenda, search): integrated; no Ctrl+K binding on `main` |

**From the 2-second snapshot poll to summary plus change cursor.** Since #58 the renderer reads the snapshot only when the worker signals a change ([architecture §12](architecture.md#12-performance-where-the-time-goes)); the steps below remain the path to per-page slices. The backend side is in place (`core.query` via `magic:query`); the renderer switch belongs to its owner:
1. **On mount:** `query({ view: "summary" })`, then `query({ view: "resources", courseId, limit })` for the visible course, paging with `nextCursor`; open one item with `query({ view: "resource", id })`.
2. **Every tick, or on the worker's change notification:** `query({ view: "changes", cursor })`, then patch only the listed resource ids. Store the returned `cursor`.
3. **The cursor:** the first caught-up page hands over from the summary's time cursor to a sequence cursor on `resource_changes.seq`. `complete: false` with changes means another page follows; `complete: false` with none (a purge, a removed source) means reload the summary and the visible page.
4. **After a command:** use the command's own result and re-run step 2; `snapshot` stays for debugging.

### 11.1 Command bar and intent router

**What it does.** The command bar (Ctrl+K typed, or dictated into the same bar) takes a plain-language request and returns one typed result: `ran {action, args, result}`, `clarify {question, candidates}`, `answer {text, citations}` or `unavailable {reason}`, each with its path (`code`, `ai`, `cache` or `none`), latency and tokens (`packages/core/src/intent`).
- **The code path, 0 tokens:** courses by code, name or nickname; relative dates in the student's time zone; topics by the course's concept labels; assignments by title words. A confident single match runs at once; an ambiguous one is asked by code. The resolver runs under a 20 ms CPU-time budget; an overrun is a miss, never an error.
- **The AI fallback** (`intent-classify` v1): the prefix is the action catalogue, an argument glossary and the course codes and names, with no passages and no other student data. Code re-resolves every argument the model returns: an invented course, assignment or date becomes `clarify`, never a guess.
- **The grounded ask** (`intent-ask` v1): code retrieves within 3,000 tokens and 8 passages; the coverage gate answers "Not in your materials." with no model call; every cited quote is checked by `findQuote`. Since the break-card fix B1 (#59), every date, weekday, number and name in an answer sentence must appear in its checked quotes, or the quote is shown in the sentence's place ([break card](break-card.md)). Planning records are never retrieved.
- **Actions that write** go through their owners' checks: a calendar event from the router is only a proposal; main writes it after the student clicks to confirm.

## 12. Open human calls

The canonical list is [plan §9](plans/2026-09-26-course-backend/plan.md#9-open-human-calls). None is settled here.

| # | The question | The operator's direction | The team's recorded position | What depends on it |
|---|---|---|---|---|
| H1 | Pricing and setup prerequisites (price settled September 27: [$5 a month](decisions.md#2026-09-27--price-5-a-month)) | open source and free with the student's own keys; $5 lifetime for the hosted Jev service | a $5 one-time app licence covering the service and company-funded Jev ([decisions](decisions.md#pricing-and-ai-access-resolution--september-26)) | licence activation (T62), setup, the submission text |
| H2 | "Remember my sign-in" | opt-in saved sign-in on UW's login page; Duo still decides (D39) | "Never automate Duo or bypass expiry" ([AGENTS.md](../AGENTS.md)) | T05e, the public disclosure |
| H3 | A sign-in window that opens by itself | opens when needed and "Keep me signed in" is on (D33) | "the app does not pop up a login during background work" ([pipeline details](pipeline-details.md)) | T05c, T05e |
| H4 | Jev links and scopes applied without review | settled by code, then Jev, then one pass; correctable in one click (D33) | auto-apply only independently checked exact identity rules ([pipeline details](pipeline-details.md)) | T20, T22 |
| H5 | The subscription CLI route | the student's own Claude Code or Codex sign-in drives the app's runs (D36; instant mode, D50) | no subscription integration promised before it's verified ([AGENTS.md](../AGENTS.md)); see the provider terms in [platform §7](academic-data-platform.md#7-business-model) | T12, D38's background lane, onboarding wording |
| H6 | Syllabus brief vs the course-intelligence profile | the syllabus becomes the course's checked brief (D34) | the compiler's cited-policy profile; "Unknown policy is not permission" ([course intelligence](course-intelligence.md)) | where the brief lives; which policy governs coaching |
| H7 | Terminal-driven workspace vs the near-approved Home | a command bar over one workspace (D40) | "Home is approximately 95% desired … Preserve its structure" ([DESIGN.md](../DESIGN.md)) | the workspace UI, the mic's place |
| H8 | The mastery bar and percentage copy | an evidence-defined bar toward mastery (D21) | "No invented mastery, readiness score, or completion claim" ([Home direction](home-design-direction.md)) | T54, the copy lint |

## 13. How to run and verify

Node 24, pnpm 10.29.2.

| Command | What it checks |
|---|---|
| `pnpm install` | dependencies |
| `pnpm check` | TypeScript across apps, packages and `evals/**` |
| `pnpm test` | the whole suite (`tsx --test tests/*.test.ts`) |
| `node scripts/test-one.mjs tests/<file>.test.ts` | one file's tests |
| `pnpm build` | check, then the desktop build |
| `pnpm magic:perf --suite baseline` | MT1 on synthetic data; results go to `.data/perf/<commit>/`, which git ignores |
| `node docs/plans/2026-09-26-course-backend/check-tasks.mjs` | the task graph |

**Live trials** run with the operator present: the operator signs in with their NetID and Duo in the app's own window; every agent check is headless and read-only; raw numbers stay in `.data/`, and only aggregates are published, including the rows we lose.
