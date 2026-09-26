# Backend map: what the current code gives learning features, and what they still need

A map of `main` for anyone building features on top of it. It is refreshed when `packages/**` or `apps/**` change.
**Status: Proposal.** Nothing below is agreed with the team until it's proposed in `packages/contracts` (the team's stated rule in `docs/development.md`).

**Last mapped:** 2026-09-26 against `73ff7a6` (Ben: `f71732e` "feat: build local desktop data foundation and secured Jev gateway" + `73ff7a6` docs). Previous: `b089be8`.
Legend: **code** = read in the source at 73ff7a6; **doc** = a doc claims it, not checked or not implemented. Paths are relative to the repo root; `contracts:N` = `packages/contracts/src/index.ts:N`, likewise `storage`, `core`, `ai`, `local` (`packages/ai/src/local.ts`), `canvas`, `domain`.

## What exists (read from the code)
| Package / app | State at 73ff7a6 (code) | What a feature can use today |
|---|---|---|
| `@magic/contracts` | zod 4 schemas + interfaces. The b089be8 types are unchanged in shape (the diff reformats them). New: `localQuestionSchema`, `LocalStatus`, `LocalAnswer`, `localContextPayload()` (text ≤6000), optional `AppBridge` methods `signInUW/syncCanvas/signOutUW/localStatus/localAsk/cancelLocal` (contracts:258-306) | `Resource`, `Attempt`, `Judgment`, `Link`, `Job`, `EgressReceipt`, `Store` (161-190), `Command` (217-251), `Connector` (307) |
| `@magic/storage` | **Implemented.** `createStore(path)` (storage:42) on Node 24 built-in `node:sqlite` **`DatabaseSync`** (synchronous, one writer, WAL, `secure_delete`, file mode 0600). Migrations via `PRAGMA user_version`: v1 creates every table (72-141), v2 adds `links.target_hash` (143-149); refuses newer DBs (53). **FTS5** virtual table `resource_search(title, course_name, body)` (106) | Every `Store` method is implemented (next table) |
| `@magic/core` | `createCore(store, {fixture, gateway?, now?})` (core:19): `execute(Command)` switch (208-277), `snapshot()`, `context(id, recipient)` → `ContextManifest`, background `drain()` of the job queue (127-197) | `context()` is the one manifest builder; hard-coded purpose "Classify assignment kind" (89), one resource, text ≤12,000 chars (82) |
| `@magic/domain` | `resolveDeadline(claims)` (domain:6), `maySend(privacy, recipient, categories)` (34) | Pure; `local` is always allowed |
| `@magic/ai` | `judgmentResultSchema` fixed to `questionVersion: "assignment.kind.v1"` (ai:14-21), `JudgmentGateway.evaluate(payload) → KindJudgment` (23-28), `gatewayClient()` posting to the fixed path `/v1/judgments/assignment.kind.v1` (87). `createLocalAi()` (local:255) exports `status()` + `generate()` | Local Ollama text generation (below) |
| `@magic/connectors` | `recordedConnector`, `validateCapture`, **`canvasConnector({fetch})`** (canvas:274) | Canvas reads through the app's own browser session |
| `apps/desktop` | Electron: sandboxed renderer → `preload.ts` (`window.magic`, 9 IPC channels) → `main.ts` `ipcMain.handle` + sender check → **`utilityProcess` worker** (main.ts:86) that owns the Store + core (worker.ts:13-45). React renderer (`App.tsx`, `LocalAiPanel.tsx`) | The only runtime path to the Store |
| `apps/gateway` | Node `http` server: `POST /v1/devices` (anonymous enrollment → bearer token), `POST /v1/judgments/assignment.kind.v1`, `GET /health` (gateway.ts:132-160); own SQLite for devices and spend | One Jev question |
| `fixtures/course.json` | 1 synthetic `CaptureBatch`, 2 resources | Still the only in-repo data |

### `Store` methods (all implemented in `packages/storage/src/index.ts`)
| Method | How (code) | Note for features |
|---|---|---|
| `ingest` (248) | Content hash = sha256 of the whole `ResourceInput` (32); new hash → new row in `resource_versions`, FTS row rewritten, `enrich.resource` job queued (384). Only an `ok`+`complete` batch marks absent items `deleted` (388-414) | Adding any populated field to a resource changes its hash, bumps its version and invalidates its judgments |
| `resources(search?)` (419) | FTS5 prefix-AND over literal terms (`"term"*`), `ORDER BY rank`; returns whole `Resource`s | No snippets, offsets or scores come back: retrieval returns whole documents |
| `putJudgment` / `judgment` / `judgments` (653-710) | Keyed by free-form `key` (≤4000 chars); refuses a write if `inputHash` ≠ the resource's current hash; returned only while the hash still matches | A usable cache for any feature judgment, tied to one resource |
| `addAttempt` / `attempts` (711-773) | Immutable by id; requires a live resource; `confidence` 0..1 or null; `createdAt` ISO with an offset | **Nothing in production calls `addAttempt`** (only tests); no `Command` writes it |
| `putLink` / `decideLink` / `links` (506-576) | Types enforced to `specifies · supports · same_as` (509); same account and course only; hidden once either end changes; a user's decision is never overwritten | No production producer calls `putLink` |
| `enqueue` / `lease` / `finish` / `jobs` (184, 578-652) | `UNIQUE(kind, resource_id, input_hash)`; lease token fencing; 3 attempts with backoff | `lease` has **no kind filter** (592-598) |
| `addReceipt` / `receipts` (774-819) | Metadata only; silently dropped if any `resourceIds` is no longer live (789) | |
| `purge` (820) | Deletes `sources` (cascades to every resource-keyed table), receipts and preferences, then `VACUUM` | Feature data in *another* DB file would survive a purge |
| `privacy` / `setPrivacy` / `setCompleted` / `sources` | As named | |

### `Command` union (contracts:217-251; handled at core:212-271)
`snapshot{search?}` · `import{batch}` · `fixture` · `complete{id,completed}` · `privacy{value}` · `context{id,recipient}` (preview only) · `enrich{id}` (queues Jev) · `link{id,status}` · `purge{confirmation:"DELETE LOCAL DATA"}`. Every result is `{snapshot, manifest?, message?}`. It is a strict discriminated union; `main.ts:204` and `core:210` both parse it.

### Paths
- **IPC (code):** renderer `window.magic.execute` → `preload.ts:4` `invoke("magic:execute")` → `main.ts:220` (checks the sender, 38-46) → `worker.postMessage({kind:"command"})` (217) → `worker.ts:92-110` → `core.execute`. Local AI uses separate channels `magic:local-status / local-ask / local-cancel` (main.ts:247-258 → worker.ts:69-91 → `local-service.ts`), **not** a `Command`. Canvas sync runs in *main* (main.ts:378-399) and imports each batch through `execute({type:"import"})`.
- **Canvas (code):** GET `/users/self/profile` (canvas:385), `/courses?enrollment_state=active&include[]=syllabus_body` (397), `/courses/:id/assignments?include[]=submission` (455). Produces `kind:"assignment"` resources (HTML description → plain text, due/lock claims, points, submitted) and one `kind:"material"` resource per course: **the syllabus** (429-445). **Not fetched:** files/attachments, modules, pages, announcements, discussions, quizzes, calendar events, grades. Text over 200k chars makes the scope `partial`; it is not truncated (118). One request in flight, 20 pages / 2,000 records per list. No PDF/PPTX extraction exists anywhere.
- **Local AI (code):** Ollama at `127.0.0.1:11434` only; requires `llmfit` recommendations, an exact installed model + quant match, and Ollama cloud disabled, rechecked before each call (local:414-429). `generate()` has a **fixed coaching system prompt** ("do not produce submission-ready answers…", local:459), 4096-token context, `num_predict` 800, free-text output, input text ≤6000 chars; `policy.mode:"restricted"` short-circuits to a refusal. One local request at a time (local-service.ts:30,55). Doc: no real local-model run has been validated.
- **Jev (code):** gateway → TypeSafe `POST https://api.typesafe.ai/v1/systemone`, model pinned `jev-1.13.0` (typesafe.ts:7-10), one `choice` question `kind` over `essay · problem_set · quiz · exam · discussion · project · reading · other` (99-125). The result is validated (sums to 1, argmax), cached as a `Judgment` and shown as `ResourceView.kindLabel` when p ≥ 0.9 (core:30-48). Default budget: **100/day global, 20/day and 5/hour per device**, 1 concurrent per device (gateway.ts:38-51). Doc: not deployed; `TYPESAFE_API_KEY` server-side only.
- **Privacy and receipts (code):** default `local_only`, Jev off (contracts:103). `maySend` gates by mode, recipient and category (`course_text`, `student_work`). `core.drain` runs only when a gateway exists **and** `maySend(jev, course_text)` passes (core:128-133); it writes a `sent` receipt *before* the call (160), `failed` on error (184), `blocked` when `enrich` is refused (247). A privacy change or purge bumps a generation counter and discards late results (core:165-171, 204-207; local-service.ts:95-104). The local path writes no receipt. ChatGPT, Claude and Gemini are preferences and preview recipients only, with no hosted calls (doc and code agree).

## Features can start now, against the contracts as they are
- **Pure engines** over `Resource[]` and `Attempt[]`: blueprint, item validators, citation checker (exact-match a quote in `Resource.text` at a stated `version`), FSRS and Elo, study-plan ordering by `resolveDeadline().planningAt`.
- **Eval harness** on `createStore(":memory:")` + `ingest(CaptureBatch)` + `resources(search)` for retrieval + `putJudgment` for cached verdicts: the real storage semantics, no Ben edits, no network. `scripts/preview.ts` shows the pattern.
- **Grounded Q&A, local-only:** FTS retrieval works now; generation needs a prompt other than the coaching prompt (see "Would require Ben").

## Gaps: what the learning features need that the contracts don't carry yet
Propose each as **additive and optional**, with a fixture and a test; tell Ben in the PR. Note `resourceInputSchema` is `.strict()` (contracts:35): an old build rejects a capture that carries a new field.
| Need | Status at 73ff7a6 | Smallest proposal |
|---|---|---|
| **Location anchors in `text`** | **open**: `plainText` (canvas:62) keeps no offsets; no page or slide sources are fetched | `parts?: {kind:'page'\|'slide'\|'section', label, start, end}[]` |
| **Material role** | **open**: the only material is `externalId:"syllabus"` (canvas:432) | `role?: 'slides'\|'notes'\|'reading'\|'syllabus'\|'practice_exam'\|'past_exam'\|'solution'\|'review_sheet'` |
| **Term of origin** | **open** | `term?: string` + `sameTerm` in domain |
| **Assessment type** | **changed**: a *judged* label exists, not a captured field: `ResourceView.kindLabel` (contracts:203, core:38-48) from Jev `assignment.kind.v1` (`quiz`/`exam`/`project`/…); only with Jev on, p ≥ 0.9; lab and homework are not in the set | Keep `assessment?` as a captured field; the Jev label is only a fallback |
| **Coverage links** | **open**: `Link.type` is still `specifies\|supports\|same_as` (contracts:114), enforced again at storage:509 | add `'covers'` in both places |
| **Modules and order** | **open**: modules are not fetched | `module?: {id, name, position}` + a modules scope in canvas |
| **Source format** | **open**: everything is HTML → text | `format?: 'pdf'\|'pptx'\|'docx'\|'html'\|'video'\|'text'` |
| **Class sessions** | **open**: no calendar or event capture | `session?: {start, end, location?}` on `kind:'event'` |
| **Generated study items + reviews** | **changed**: `@magic/storage` exists and Ben owns it (`docs/development.md` package table). `attempts` table + `addAttempt` exist, but there are no item, review or FSRS-state tables, and `Attempt` has `correct` + `confidence`, not a 1–4 rating | Migration v3: `items`, `reviews` keyed to `resources(id)` so purge cascades; `Store.items()/putItem()/reviews()/addReview()` |
| **Feature commands** | **open**: the union is unchanged (9 variants) | e.g. `{type:'practice.generate', courseId, assessmentId?}`, `{type:'attempt', …}` |

## Extension points for learning features today (no edit to Ben's files)
| Plug-in | Where | Limit |
|---|---|---|
| New workspace package `packages/<feature>` | `pnpm-workspace.yaml:3` (`packages/*`); type-checked by `tsconfig.json:26` (`packages/**/*.ts`) | Tests import it by path; `@magic/<feature>` by name needs a line in `tsconfig.json:15-22` (shared config, a trivial ask) |
| Read and write through the `Store` interface | `contracts:161-190`, implemented by `createStore` at storage:42 | Runs in-process only: in the app that is the worker (worker.ts:13), where no feature code is loaded today; in tests or the eval harness you open your own store |
| Retrieval for grounded Q&A | `Store.resources(search)` storage:419 | Whole documents; do citation offsets in feature code |
| Practice evidence | `Store.addAttempt` storage:711, `Store.attempts` storage:753; `Attempt` contracts:140-150 | `itemId` and `skill` are free strings; one attempt must name a live `resourceId` |
| Feature judgment cache (verifier verdicts, item checks) | `Store.putJudgment` storage:662, `judgment` 653; `Judgment` contracts:131-139 | Your own `questionVersion` and `key`; bound to one resource's current hash, which gives automatic invalidation |
| Candidate links (materials ↔ assignment) | `Store.putLink` storage:506 with `supports`/`specifies` | No `covers` type |
| Privacy gate + receipts for any outbound call | `maySend` domain:34, `Store.addReceipt` storage:774, `localContextPayload` contracts:286 | Build your own manifest; `core.context` is assignment-kind only |
| New source of captures (e.g. OCW converter, files) | `Connector` contracts:307-310; ingest via `import` (contracts:224, core:215) or the **Import capture** file dialog (main.ts:265-286, JSON ≤8 MB) | Must fit today's `ResourceInput` (strict) |
| Local model selection | `createLocalAi().status()` local:352, `selectInstalledLocalModel` local:195, `recommendLocalModels` local:113 | `generate()` is coaching-only free text |
| Job kinds | `Store.enqueue(kind, …)` storage:184 accepts any string | **Not usable without Ben**: see next section |

## Would require Ben
| Change | Files and lines |
|---|---|
| Feature `Command` variants (practice, attempt, flashcard review) | `contracts:217-251` + `core:212-271` switch (no default branch: an unhandled variant silently returns a snapshot) + renderer |
| A new IPC channel (e.g. streaming generation) | `preload.ts:3-13`, `main.ts:220-258`, `worker.ts:48-111`, `AppBridge` contracts:296-306 |
| Feature tables in the workspace DB (items, reviews, FSRS state, verified items) | `SCHEMA_VERSION` storage:24 + a `schemaVersion < 3` block after 143-149; `Store` contracts:161-190; purge coverage storage:820 |
| Feature job kinds | `core:136-139` fails any kind ≠ `enrich.resource`; `lease` has no kind filter (storage:592-598), so a second consumer would steal jobs; `drain` runs only with Jev permitted (core:128-133) |
| A new Jev judgment (item verification, answerability) | gateway routes `apps/gateway/src/gateway.ts:132-160`, `schema.ts:15-29`, `typesafe.ts:7-8,37-50,99-125`; client `ai:14-28,87`; the evaluate relay `worker.ts:16-43` + `main.ts:172-191`; budget `gateway.ts:38-51` |
| Local structured generation (quiz items, JSON output) | `local:233-246` input schema, `local:443-470` fixed prompt and options (no JSON `format`); `local-service.ts:54-116` |
| Multi-resource context (course-wide Q&A, exam scope) | `ContextManifest.payload` is one resource (contracts:191-200); `core.context` 72-96 |
| Resource fields from "Gaps" | `resourceInputSchema` contracts:21-35 (strict); a hash change bumps every version (storage:32) |
| `covers` link type | `contracts:114`, `storage:509` |
| Canvas coverage: modules, pages, files, quizzes | `canvas.ts:396-484`; source scope union at 415 |
| Snapshot fields for feature state | `contracts:205-216`, `core:59-70` |

## Breaks for feature code
**None in types.** `git diff b089be8..73ff7a6 -- packages/contracts` reformats every b089be8 type unchanged and only *adds* exports. New **runtime** rules that code written against the old map must respect:
- `addAttempt` throws for a missing or deleted resource or a conflicting duplicate id; `createdAt` must carry an offset.
- `putJudgment` returns `false` when `inputHash` is stale and throws when a key is reused with different inputs; `judgment()` hides stale rows.
- `enqueue` silently no-ops on a stale hash; `links()` hides links whose target changed since `putLink`.

## Open with the team
- Where feature state lives: a Store migration v3 (purge covers it) versus a feature-owned DB (purge would miss it). Ask Ben.
- Whether `generate()` gets a task parameter (prompt + JSON schema) or a sibling function for practice items.
- Jev budget: 20/day per device cannot carry a per-item verification pipeline; local verification or a raised cap is a product decision.
- Extraction (PDF/PPTX → text + `parts`): no code exists; `docs/tool-evaluation.md` lists candidates (doc).
