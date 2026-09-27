# My Magic UW course backend: architecture

**Status:** state as of 2026-09-26 late, branch `feat/course-backend` at `b496d0a`. The branch is local for now. It gets pushed after the team's release cleanup, so its commits are re-applied onto the cleaned `main`. The commit IDs below will change when that happens; the commit subjects won't.
**Companion:** [My Magic UW: product direction](magic-canvas-direction.md) holds the product facts: what the student gets, the surfaces, pricing and the roadmap. This document holds the technical facts. The build itself is specified in [the course-backend plan folder](plans/2026-09-26-course-backend/): [spec](plans/2026-09-26-course-backend/spec.md), [plan](plans/2026-09-26-course-backend/plan.md), [tasks](plans/2026-09-26-course-backend/tasks.md) and [execution](plans/2026-09-26-course-backend/execution.md). Where this summary and the plan folder differ, the plan folder wins.

## 1. Summary

The course backend is the local system behind every My Magic UW feature:
- it connects to every source the student's own UW sign-in can already read
- it stores that material in one SQLite file on the student's computer, as passages with exact offsets
- it maps each course: sessions, topics, assessments and their stated scope, and the materials for each
- it generates study material through written prompt packs on the student's own AI client
- it runs study (quizzes, flashcards, levels, analytics) at zero model tokens

**The principle: AI writes, code decides.** Code does whatever has one right answer (dates, IDs, permissions, quotes). Jev makes small typed judgments. The student's AI gets one checked call only where language has to be read or written ([spec §2](plans/2026-09-26-course-backend/spec.md)).

**Status in one sentence:** sign-in, session, consent and the egress gate are integrated on the branch; the AI runtime is tested in isolation; the data layer, per-course sync and learning engines are built on lane branches; nothing has been demonstrated on a real account yet.

**Status labels used here.** This document uses a stricter "integrated" than [spec §1c](plans/2026-09-26-course-backend/spec.md):

| Label | Meaning |
|---|---|
| researched | evidence gathered; no specification or code |
| proposed | specified in the plan folder; no code |
| built | code exists on a lane branch, not yet merged into `feat/course-backend` |
| tested in isolation | merged into `feat/course-backend` with passing tests, but the running app doesn't call it yet |
| integrated | merged, and wired into the running app's path, with the whole suite passing |
| demonstrated | shown working on a real student account. **Nothing is demonstrated yet.** |

## 2. Where we are

*This section is updated at each piece boundary. Last update: 2026-09-26 late, `33b1827`. The whole suite passes 540/540 on this branch at that commit (Windows 11), across 67 test files. Full detail, per-file test counts, measurements and the live-trial record are in [the build record](course-backend-build-record.md); this section states only statuses.*

### 2.1 Stage: pieces and lanes

The build ran piece by piece (P0–P14, [execution.md](plans/2026-09-26-course-backend/execution.md)), then as long-lived lanes from about 22:00 CT on 2026-09-26. Every wave-A and wave-B lane named below has since merged into `feat/course-backend`.

| Piece or lane | Scope | Status | Evidence | Next step |
|---|---|---|---|---|
| P0 test harness | T05a: Windows-safe suite, per-test-file checks | **integrated (tested in the suite)** | `6199250`; `tests/harness.test.ts` 8/8 | none |
| P1 sign-in, session, consent | T05d seams, T05c session state and "Keep me signed in", T06 one-checkbox consent and egress | **integrated (tested in the suite)**; one live trial run | `e5430e0`, `d63a515`, `b7fb439`, `b67ab04`, `08af173`, `cb70b7a`, `eb2a033`; tests 8 + 16 + 13 | T05e "Remember my sign-in" waits on H2; re-measure the live trial's sync-efficiency fixes |
| P2 local database | MT1 baseline; T11a, T10 (schema v6), T10L (v7), T11b; T14 | **merged and tested**: schema v7 migrations run in the app; passage search is not yet called by the app; MT1 "after" measured and thresholds met | merge `39bb062`; `f365af7` (T14); build-record §5.1 | none for the primary thresholds; two secondary MT1 rows (zero-change re-sync growth, ingest slope) still miss their target |
| P3 Canvas sync and freshness | T05b seams, D32 inventory, D41 access check, D37/T33 per-course freshness, T15 scoped queries | **integrated (tested in the suite)** | merge `bb80f53`; `ec2d61b` (T15) | live-sync efficiency fixes found in the trial (build record §6) |
| P4 extraction and passages | T11a/T11b (merged); T16 extraction cache, T32 Kaltura, T65 summary tier | T11a/T11b **integrated**; T16, T32, T65 **not started** | see P2 | T16, T32, T65 remain proposed |
| P5 jobs, Jev, organising | T20 batched item cards, T20b gateway endpoints | **not started** (the drain's job subjects and the pack job's cache/ledger wiring are integrated) | build record §3.4, §7 | T20/T20b after T10 (done) |
| P6 other sources | T00 probes, T01, T30/T35 Outlook, T36, T31, T34 | **not started**; probes E1 and K1 not run | none | T34 (teachers and TAs); the probes need the operator present |
| P7 typed academic API | T50a in-process handlers | **not started** | none | after T10 (done) |
| P8 backend benchmark | MT2, MT7a | **not started** | MT1 done (P2) | after P2–P4 |
| P9 model runtime and packs | T12 runner, D38 session pool, T40 onboarding detection, T13 pack core, T80 client manager, T81 onboarding screens | **merged and tested (client manager and onboarding screens are wired into the app; runner, session pool and pack core are not yet wired into the worker) (tested in the suite)**; not demonstrated on a real pack run | merges `efc6604`, `9a08a6b`, `a826f41`; build record §3.5, §4 | wire a real, non-synthetic pack run through the worker; D38's pool spikes S1–S10 before it's the default |
| Learning engines lane | N00, N05–N12, N14, N29, P01, P05, P07, P08, P11, P13, P14, P16 | **merged, tested in isolation** (the app's learning router still answers "not built") | merge `e161b13`; build record §8 | study UI surfaces (P12/P10) |
| P10 course pass and mapping | T21, T22 | **not started** | none | needs T11b (done), T13 (done), T20 |
| P11 generation | T57, T58, T64, T45, T53, T41, T44, T46, T42, T48, T52 | **not started** (engines N05, N06, N12 are integrated) | none | after P10 |
| P12 study system | engines, then T54, T47, T59, T43, P17 | engines **merged, tested in isolation**; UI **not started** | build record §8 | after P11's first packs |
| P13 platform and secondary | T50b, T55, T51, T38, T56, T62, T63 | **not started** | none | after P7 |
| P14 close | T60 legal, T61 acceptance | **not started** | none | last (plan §8) |

**Gates:** T02 (the operator signs off the AI boundary, spec §2) is still open. G0 (nothing is pushed until the team's release cleanup is done) holds; no push to `main` has happened.

### 2.2 Progress by area

| Area | Status |
|---|---|
| Sign-in and session | **integrated (tested in the suite); demonstrated** in one live trial on the operator's account (sign-in, Duo remember-me, a live bug found and fixed). "Remember my sign-in": proposed (H2) |
| Consent and egress | **integrated (tested in the suite)** (T06); zero requests before the checkbox held in the live trial; the per-provider onboarding screen is integrated (T81) |
| Storage and retrieval | **merged and tested**; v7 migrations run in the app, passage search not yet called by the app; MT1 "after" measured, every primary threshold met (build record §5.1) |
| Sync and freshness | **integrated (tested in the suite)**; live-trial sync ran 65 s / 125 requests for the first sync; efficiency fixes identified, not yet re-measured |
| Course map and inventory | inventory and access check **integrated (tested in the suite)**; course pass and mapping **proposed** |
| AI runtime and onboarding | runner, session pool, pack core, client detection, isolated client profiles and the built-in terminal **merged and tested**; client profiles, terminal and onboarding are wired into the app, while runner, pool and packs are not yet wired into the worker (tested in the suite)**; not demonstrated on a real pack run |
| Generation | **proposed** (verifier and guide engines integrated on the learning lane) |
| Study and analytics | engines **merged, tested in isolation**; surfaces **proposed** |
| Platform (D42) | **proposed** |
| Dictation (D43) | **proposed** |
| Outlook (D44) | **researched and proposed**; probe E1 not run |

### 2.3 What's left, in build order

**Next:**

| Item | Depends on | Finishing it enables |
|---|---|---|
| Wire a real pack run (non-synthetic content) through the worker into the ledger and artifact store | pack job integrated; data lane merged | the first real prompt-pack run, recorded in the ledger |
| Canvas sync efficiency fixes (`include[]=items`, request pacing, one sync on sign-in) | found live (build record §6) | first full sync in ≤10 s (currently 65 s) |
| T05e "Remember my sign-in" | H2 | the opt-in encrypted NetID save |

**After:**

| Item | Depends on | Finishing it enables |
|---|---|---|
| T20 item cards and T20b gateway endpoints (a PR; the deploy is the operator's say) | T10 (done) | code-first classification with one Jev request per item |
| T21 course pass, T22 mapping | T11b (done), T13 (done), T20, N05 (done) | settled assessment scopes and the dossier |
| T57 analyzers, T58 planner, T64 verifiers, then T45, T53, T41, T44, T42 | T21/T22, T13 (done) | quizzes, flashcards, guides and chat, all checked by code |
| T50a typed academic API | T10 (done) | in-app handlers with caps; the base for the course bank and the platform |
| T34, T31, T36, T32, then T30 or T35 | probes E1 and K1 | teachers and TAs, feeds, calendar, Kaltura, Outlook |
| T16, T65, T17 optimizations; MT2 and MT7a | the merged data layer | before-and-after numbers; the first public comparison rows |

**Later:** the study surfaces (T54 levels and the mastery display, T47 "Quiz me on", T59 notes, T43 notebook UI, P17 journey), offline validation (P18–P21), dictation (D43), the course bank and platform (T50b, T55), licence and signed installers (T62, T63), then legal and acceptance (T60, T61).

## 3. System map

### 3.1 Processes

```mermaid
flowchart LR
  subgraph PC["Student's computer"]
    R["Renderer: React UI"] -->|"AppBridge (preload): magic:* channels"| M
    M["Main process: persist:uw session, consent gate, sign-in window, tray, presence, Jev credential"]
    M <-->|"utilityProcess messages: command, source-fetch, evaluate, presence"| W
    W["Utility worker: Store, ingestion, refresh, job drain, runner"]
    W --> DB[("One SQLite file")]
    W -->|"spawn, stdin/stdout, tools off"| C["Student's CLI client in an app-owned profile (D45, proposed)"]
    T["Built-in terminal: the student's own client session (proposed)"] -.-> C
    MCP["mcp-server.cjs: optional course bank"] -.->|"reads"| DB
  end
  M -->|"signed-in reads for the worker"| UW["UW: Canvas, My UW, Enroll, GitLab, Kaltura"]
  W -->|"public client, gated on consent"| PUB["Public course sites, calendar feeds"]
  M -->|"evaluate"| JEV["Jev gateway (hosted)"]
  C --> AI["The student's AI provider"]
```

- **Only main touches the UW session.** The worker asks main for every signed-in read (`source-fetch`) and for every Jev call (`evaluate`); main holds the device credential.
- **Main's consent gate** checks every channel that can reach the network (§6).
- **The worker's own public sockets** (course-site crawl, document downloads, calendar feeds, Registrar reads) are wrapped by the same consent check (`apps/desktop/src/worker-clients.ts`).
- **The MCP server** is a separate, optional process. Today it opens the database file itself; T50b moves it behind a read-only reader, so no agent process gets the database path.

### 3.2 Data flow

```mermaid
flowchart LR
  P["Change detection: hot tick, per-course content probe (D37)"] --> A
  A["Connect: sign-in, course inventory (D32), access check (D41)"] --> B
  B["Store: resources, versions, passages with offsets, summaries"] --> C
  C["Map: code rules, then Jev judgments, then one course pass; checked by code"] --> D
  D["Generate: prompt packs on the student's AI, one checked call, cached by hash"] --> E
  E["Study at 0 tokens: FSRS, sectioned quizzes, topic levels, analytics"]
  E -->|"answers and reviews"| B
```

### 3.3 Storage layout

One file, one writer (the worker), schema versions owned only by `packages/storage`.

```mermaid
flowchart TB
  subgraph MAIN["On main"]
    V13["v1-v3: sources, resources, resource_versions, observations, field_observations, resource_changes, completions, resource_search (FTS5), preferences, links, jobs, judgments, attempts, receipts, scope_baselines, course_overrides, sync_runs, mcp_grants"]
    V4["v4 planning: planning_sources, planning_captures, planning_records, planning_versions"]
    V5["v5 course intelligence: course_intelligence"]
  end
  subgraph OURS["Ours: built on the data lane, not merged"]
    V6["v6 course core: passages, passage_fts (contentless), course_sessions, assessments, assessment_scope, map_links, life_items, course_spaces, extraction_recipes, course_briefs, material_facts, compile_runs, ledger, ui_events; jobs gain subjects; resource_search dropped"]
    V7["v7 learning and practice: learning_concepts, items, cards, reviews, attempts, artifacts, coverage, sessions, concept state, stars, option tags, views, and the rest of the learning spec's tables"]
  end
  V13 --> V4 --> V5 --> V6 --> V7
```

- Every new table is keyed to `sources(id) ON DELETE CASCADE`, directly or through `resources`. A course is `sources.course_id`; there's no `courses` table.
- The planning (v4) and course-intelligence (v5) tables are untouched.
- `material_summaries` and `platform_writes` are specified ([spec B2](plans/2026-09-26-course-backend/spec.md)) and not built yet.
- The canonical purge list is [spec B1](plans/2026-09-26-course-backend/spec.md).

## 4. How it fits the whole system

### 4.1 What we reuse from `main`

The map of what exists is [the backend map](notes/backend-map.md).

| Part on `main` | How the course backend uses it |
|---|---|
| **Refresh coordinator** (`packages/core/src/refresh.ts`): a probe before any full read, quiet hours, jitter | kept. We add a cadence table and presence gating (integrated), and per-course probes (built on a lane) |
| **Job queue and drain** | extended, not replaced: jobs gain a subject and `lease(kinds[])`, and only kinds with a consumer are queued (data lane) |
| **Judgments cache** (input hash, model, question version) | reused for every Jev judgment. A text hash (O5) lets text judgments survive a submission change |
| **Links with reasons** | kept for exact links. Jev and course-pass links live in `map_links` with their rung (code, Jev, pass, student) |
| **Receipts** | reused for every send; T06 adds the `preview_required` status and a `blocked` receipt for a refused Jev send |
| **Privacy gates** (`maySend`) | extended with consent records per recipient (T06) |
| **Course intelligence** (schema v5; [course intelligence](course-intelligence.md)) | kept as the fully local path, and its quote anchoring is reused. Whether our syllabus brief (D34) becomes a revision of it or its own table is open decision H6 |
| **Planning** (schema v4; [planning handoff](planning-upgrade.md)) | reused as is. Planning records never enter AI, Jev, MCP or the data platform |

### 4.2 What we build on from the team's in-flight branch

`integration/backend-features` isn't on `main` yet. The course backend reuses these parts instead of rebuilding them:

| Team work (pending merge) | Where we use it |
|---|---|
| Deadline claims from course prose, each with a literal span, and a tiered resolver | the unified schedule (spec D8) and the code-first scope patterns; the course pass reads only what this can't (PDF schedules, discussions) |
| Fuzzy supporting-material candidates after each sync (rule `link.fuzzy.v1`) | the input to Jev's link judgments (spec C4), not a second candidate generator |
| Known-identity scrubber and citation-span validation | applied to every hosted payload, MCP output and platform export |
| Madgrades adapter | planning (local only) |
| Judgment queue that pauses on gateway budget refusals | kept in the extended drain |
| Recurring ICS events expanded within a bounded window | the unified schedule |

### 4.3 The Today rail and planning

The Today rail work is on the team's `sean/today-calendar-rail` branch (PR #2), not on `main` yet. It adds day-plan entries (`day-plan` and `day-plan-remove` commands), the published Outlook calendar ICS, and one work projection for Upcoming and the rail.
- **The unified schedule (spec D8)** reads day-plan entries as the student's own entries. Study sessions it proposes are saved as day-plan entries when the student moves them.
- **Outlook calendar (T36)** reuses the rail's published-ICS route once PR #2 merges, and only fills gaps.
- **One open storage point:** day-plan entries live in `preferences` with no link to their source, so deleting a source leaves them behind. The P2 review recommends a table with a cascade. That's the rail author's call.
- **Planning** stays its own surface (My UW) and its own tables. Only its dates (enrollment windows, appointments, holds) appear on the schedule, locally.

## 5. Frontend surfaces the backend serves

The UI will change with the team's design direction ([DESIGN.md](../DESIGN.md)). This section names only the channels and commands each surface calls.

**Channels** (`apps/desktop/src/preload.ts` → `ipcMain.handle` in `main.ts`):

| Channel | Bridge method | On `main` or ours | Status |
|---|---|---|---|
| `magic:execute` | `execute(command)` | main | integrated |
| `magic:open`, `magic:import`, `magic:signin`, `magic:sync`, `magic:planning-sync`, `magic:signout`, `magic:local-status`, `magic:local-ask`, `magic:local-cancel`, `magic:mcp-export` | as named | main (sign-in, sync and planning reads now pass the consent gate) | integrated |
| `magic:keep-signed-in` | `keepSignedIn(value?)` | ours (T05c) | integrated |
| `magic:onboarding` | none yet | ours (T40) | main answers it; the preload doesn't expose it yet (T81 adds the bridge method) |
| `magic:open-link` | `openLink(url)` | ours (T05b) | built on the seams lane: link cards open in the default browser, https only |

**Commands** through `magic:execute` (`packages/contracts/src/index.ts`, `commandSchema`):
- **On `main`:** `snapshot`, `import`, `ingestion-settings`, `course-override`, `mcp-grant`, `fixture`, `complete`, `privacy`, `context`, `enrich`, `link`, `purge`, `planning-guide`, `planning-search`, `planning-sections`, `planning-compare`, `planning-import`.
- **Ours, integrated:** `consent` (grant or revoke per recipient; the only writer of consent records) and `preview.ack` (the answer to a blocking preview, bound to the payload's hash).
- **Ours, built on the seams lane (stubs answer `not_built` until their task lands):** `map`, `correct`, `pack`, `ui_event`, `workspace` (the command bar's resolved verb: open, quiz, cards, explain, due), and `learning` with the ops `notebook.*`, `study.*`, `knowledge.*` and `practice.*`.

| Surface | Calls |
|---|---|
| Onboarding (T81) | `magic:onboarding`, then `consent`, `magic:signin`, `magic:sync` |
| Consent and agreements | `consent`, `preview.ack`, `privacy`; the receipts come back in `snapshot` |
| Sign-in and "Keep me signed in" | `magic:signin`, `magic:signout`, `magic:keep-signed-in` |
| Course map and dossier | `map`, `correct`, `ui_event` (T15 replaces full snapshots with scoped queries) |
| Access chips and "Connect this course" (D41) | `map` (access states), `magic:signin` for UW single-sign-on hosts, `magic:open-link` for the rest |
| Notebook, chat and artifacts | `learning` `notebook.*`, `pack` |
| Study: flashcards, quizzes, Learn, levels | `learning` `study.*`, `knowledge.*`, `practice.*` |
| Command bar (D40) | `workspace` |
| Today rail and schedule | `snapshot` today; `day-plan` on PR #2; `timeline` (spec D8, proposed) |
| My UW | `magic:planning-sync`, `planning-*` |
| Settings: data and privacy | `privacy`, `purge`, `mcp-grant`, `magic:mcp-export` |

## 6. What changed from `main`, and why

| Area | `main` today | Ours | Why (evidence) | Status |
|---|---|---|---|---|
| **IPC and snapshots** | every command returns the full snapshot | scoped, paged, course-scoped queries with a change cursor (T15, O1) | the snapshot is 28.8 MB and takes 480 ms p50 to execute at 5,000 resources (MT1, synthetic data, this laptop) | proposed (next on the seams lane) |
| **Search and FTS** | FTS5 over whole documents; every query term prefix-matched and AND-joined; no `LIMIT`; each hit re-read with its field history | passages with exact offsets; contentless-delete FTS5 keyed by passage rowid; questions as OR + BM25, `LIMIT` ≤20; "not found" when the top hit covers under half the query's content terms | 45.8% of MT1's queries return nothing (MT1); OR + BM25 found 10 of 10 planted answers where prefix-AND found 0 (P2 spike, synthetic); contentless tables per [SQLite FTS5](https://www.sqlite.org/fts5.html#contentless_delete_tables) | built (data lane) |
| **The ingest bottleneck** | deleting a resource's old FTS row looks it up by an unindexed column, so each delete scans the whole table | FTS rows addressed by rowid | the scan is 5.4 ms per delete at 1,000 resources and 23.4 ms at 5,000, about 88% of ingest time; ingest without it ran at 2,147 resources/s (P2 spike, synthetic) | built (data lane); target ≥10× at 5,000 |
| **Duplicate text** | each body stored twice: in `resource_versions` and as the FTS table's content | one copy; excerpts cut by offsets | the FTS copy is 31% of the database (24.2 of 78 MB at 5,000; P2 spike) | built (data lane) |
| **Field history** | every sync appends one row per observed field, changed or not | last-seen per field (upsert) | a zero-change re-sync adds 15.8 MB (+20%) at 5,000, and the history is never read (P2 spike). This changes the team's ingestion design, so it goes to `main` as a reviewable PR | built (data lane) |
| **Migrations and backup** | each version step in its own transaction; no backup; the MCP server can open and migrate the file too | all pending steps in one `BEGIN IMMEDIATE` that re-reads the version; a `VACUUM INTO` copy first; restore through `node:sqlite` `backup()` | a mid-chain failure today leaves an intermediate version; `VACUUM INTO` took 317 ms on 92 MB, and `backup()` into the live path restored cleanly with a reader open (P2 spike); [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto), [node:sqlite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) | built (data lane); the MCP read-only open is proposed |
| **Purge** | deletes a fixed list of tables; 8.7 s at 5,000 | enumerates every table in `sqlite_schema` and every app-owned file | a derived table must not survive "Delete local data" (P2 spike timing) | built (data lane); target ≤1 s |
| **Sync and change detection (D37)** | one account-wide activity-summary probe; any change triggers a full read of every course | a hot tick on `todo` and `upcoming_events` (their IDs carry the course); a per-course content probe every 15 min and on focus; warm reads of the courses that moved only | the activity stream's item types are discussion topics, announcements, context messages, messages, conversations, submissions, conferences, collaborations and assessment requests, so files, pages and module items never move it ([canvas-lms `lib/api/v1/stream_item.rb`](https://github.com/instructure/canvas-lms/blob/master/lib/api/v1/stream_item.rb)); a zero-change re-sync still made 69 of the full sync's 79 requests (MT1) | built (seams lane); targets ≤5 min dated, ≤15 min undated |
| **Background reads while away** | background refresh runs whenever the app is open | signed-in reads (Canvas, GitLab) only while the student is present (input in the last 30 min, screen unlocked); credential-free feeds while away; one catch-up read on return | no request ever keeps a UW session alive, so the session ends on UW's own clock | integrated (T05d) |
| **Sign-in and session** | sign-in window with a profile check; expiry recovery was open | expiry confirmed only by a login redirect, a login page, or a 401 whose body says `unauthenticated`, then one "Sign in again"; a permission error marks only that area; "Keep me signed in" (on by default: tray, start at login); quitting signs out | session cookies are dropped on quit (measured, Electron 44.4.5), and UW calls browser session restore "a serious security concern" ([KB 4302](https://kb.wisc.edu/4302)) | integrated (T05c); not demonstrated |
| **"Remember my sign-in" (D39)** | none | opt-in, encrypted with `safeStorage`, filled only on UW's NetID login page; Duo never automated | UW's standard permits "Storing one's personal NetID and NetID password in a password management application" ([KB 59262](https://kb.wisc.edu/itpolicy/page.php?id=59262)); saved only when [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) encryption is available | proposed; open H2 |
| **Consent and egress** | privacy preferences and `maySend`; the accepted disclosure flow "not implemented" ([AI and privacy](ai-and-privacy.md)) | one setup checkbox writes a consent record per recipient; main's gate refuses every network channel without it; the worker's own public clients are gated too; a new sensitive category (or "always preview") holds the send as `preview_required` until `preview.ack` for that exact payload hash | implements the team's accepted flow with the fewest clicks; zero requests before the checkbox (spy test) | integrated (T06) |
| **AI runtime** | local Ollama coaching; paid routes accepted, not built | `ModelRunner` with Claude Code and Codex one-shot adapters, API-key adapters and a local adapter; one call, tools off, a JSON schema, the prompt on stdin, retry then escalation, a ledger and a background budget | one checked call instead of an agent loop, so untrusted course text can't trigger a tool | tested in isolation (T12) |
| **Warm session pool (D38)** | none | an interactive lane per open course, one background lane rotated per batch, an escalation lane on demand | measured on this laptop: a new `claude -p` per call took 5.8–7.4 s; a warm session answered follow-ups in 1.7–2.2 s (plan D38) | tested in isolation |
| **Packs** | none | versioned packs with byte-stable prefixes (O8), grounded-quote checks, a cache key by hash, ledger rows | the model writes; code checks every quote against the exact passages it was given | tested in isolation (T13 core; the stores are in memory until v6 merges) |
| **Onboarding and client detection** | none | detects Claude Code and Codex and asks each CLI for its own sign-in state (no credential file read), then chooses Claude Code → Codex → a stored key → Ollama | AGENTS.md: no provider integration is promised before it's verified | tested in isolation (T40) |
| **Isolated client profiles (D45)** | none | the app runs the student's client with its own configuration directory, e.g. `CLAUDE_CONFIG_DIR=<userData>/clients/claude`; the student signs in there through the provider's own flow in a built-in terminal | "a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" ([authentication](https://code.claude.com/docs/en/authentication), [env vars](https://code.claude.com/docs/en/env-vars)). The lead's spike (2026-09-26): with an app-owned directory, `claude auth status` reported "Not logged in", and the student's own `~/.claude` wasn't modified | proposed; building on `wave-b/T80` |
| **Subscription route** | none | the student's own Claude Code sign-in, unmodified binary | verified in the provider's terms for Claude Code ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): "Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential"), pending live testing. Codex has no documented arrangement ([openai/codex#36886](https://github.com/openai/codex/issues/36886)); Gemini CLI's terms forbid third-party use of its sign-in ([tos-privacy.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)), so Gemini is API key only | researched; open H5 |
| **Course inventory and access (D32, D41)** | a fixed set of Canvas endpoints | every place a course keeps content is listed by code (tabs, external tools, module items by type, the syllabus, links in bodies); each gets an access state: readable, needs UW sign-in, needs its own login, link-only, blocked | a fixed endpoint list misses external tools and linked platforms. The app never launches an LTI tool, because a launch can enrol the student or start recording ([KB 65466](https://kb.wisc.edu/65466)) | built (seams lane) |
| **Store vs link (D40)** | everything captured is stored | text-bearing content becomes passages; tools and platforms with their own login become link cards opened in the default browser | stores what can be quoted and checked; never scrapes a third-party login | proposed (the link-card channel is built on the seams lane) |
| **Learning system** | an `attempts` table with no consumer | knowledge model, FSRS, Learn and Write modes, the session builder, calibration, the copy lint | study runs at 0 tokens, and progress is defined by evidence rules | built (learning lane); tables built (data lane) |
| **Jev** | one question type; small per-device limits | code-first classification, then one batched request per item; versioned endpoints and limits (T20b, a PR) | code answers most items at no cost, and nothing is re-asked | proposed |
| **Data platform (D42)** | six local MCP tools with grants and receipts | a versioned read contract, a read-only course bank, scoped tokens, a narrow write path for student-owned artifacts ([spec F3](plans/2026-09-26-course-backend/spec.md)) | see the product direction | proposed |
| **Dictation (D43)** | none | on-device speech-to-text into the command bar only; never stored or sent ([spec D9](plans/2026-09-26-course-backend/spec.md)) | Electron's `SpeechRecognition` fails in Electron ([electron#46143](https://github.com/electron/electron/issues/46143)) | proposed |
| **Outlook (D44)** | none | Microsoft Graph, delegated; sender, subject, time and link stored; an optional code-extracted gist; never bodies ([spec A3](plans/2026-09-26-course-backend/spec.md)) | `Mail.ReadBasic` excludes bodies ([permissions reference](https://learn.microsoft.com/graph/permissions-reference)); user consent to it may be blocked by the tenant ([app consent policies](https://learn.microsoft.com/entra/identity/enterprise-apps/manage-app-consent-policies)); probe E1 decides | researched and proposed |

## 7. Implemented, per task

Tests counted on this branch at `b496d0a`; the whole suite is 359/359.

| Task | What | Files | Checks | Status |
|---|---|---|---|---|
| T05a | Windows-safe suite, `test-one`, `check-probes` | `scripts/test-one.mjs`, `scripts/check-probes.mjs` | `tests/harness.test.ts` 8/8 | integrated |
| MT1 | performance harness and baseline, synthetic data, replayed Canvas transport | `evals/perf/*` | `pnpm magic:perf --suite baseline`; result recorded at `91e39fa` | integrated (a harness, not an app feature) |
| T05d | session and consent seams: providers, consent contracts, presence-gated cadence | `packages/contracts/src/index.ts`, `packages/core/src/refresh.ts`, `apps/desktop/src/worker.ts` | `tests/seams-p1.test.ts` 8/8 | integrated |
| T05c | session state at launch, expiry classification, one "Sign in again", "Keep me signed in" (tray, login item), sign-in window self-confirmation | `apps/desktop/src/keep-signed-in.ts`, `main.ts`, `packages/connectors/src/canvas-http.ts` | `tests/session.test.ts` 16/16 | integrated; not demonstrated |
| T06 | one-checkbox consent, per-recipient records, main's consent gate, gated worker clients, previews bound to a payload hash, egress receipts | `packages/core/src/egress.ts`, `apps/desktop/src/worker-clients.ts`, `renderer/consent/ConsentSetup.tsx`, `packages/storage/src/index.ts` | `tests/egress.test.ts` 13/13 | integrated |
| T12 | `ModelRunner`: Claude and Codex one-shot, API-key and local adapters; retry, escalation, ledger rows, background budget | `packages/runner/src/*` | `tests/runner.test.ts` 15/15 (argument lists checked against a fake CLI) | tested in isolation |
| D38 | warm Claude session pool: per-course interactive lanes, a rotated background lane, on-demand escalation | `packages/runner/src/pool.ts` | `tests/session-pool.test.ts` 7/7 | tested in isolation |
| T40 | onboarding detection: installed CLIs, their own auth status, engine choice, model probe | `apps/desktop/src/onboarding.ts`, `main.ts` (`magic:onboarding`) | `tests/onboarding.test.ts` 7/7 | tested in isolation (no bridge method yet) |
| T13 core | pack format, O8 byte-stable prefixes, grounded-quote checks, cache by hash, ledger and artifact stores (in memory) | `packages/packs/core/src/*`, `packages/core/src/jobs/pack.ts` | `tests/packs.test.ts` 10/10 | tested in isolation |
| T11a, T10, T10L, T11b | passage splitter and quote validator; schema v6 and v7; the drain; one-transaction migration; complete purge; stored passages and passage search | data lane (`wave-a/T10`) | the lane's own tests; not yet re-run by the lead | built |
| T05b, D32/D41, D37/T33 | integration seams; course inventory and access check; per-course freshness | seams lane (`wave-a/T05b`) | the lane's own tests | built |
| N00–N14, P01–P16 (subset) | knowledge model, FSRS adapter, item checks, guide schemas, concept map, Learn, Write, session builder, calibration, copy lint | learning lane (`wave-a/LRN`) | the lane's own tests | built |
| T05e | "Remember my sign-in" | none | none | proposed (H2) |

## 8. Measurements

### 8.1 MT1 baseline (synthetic data, this laptop)

**Machine:** Windows 11, Intel Core Ultra 9 275HX, 24 cores, 31.4 GiB. Node 24.14.1, SQLite 3.51.2. Commit `91e39fa`. Synthetic corpus, replayed Canvas transport, no network.
**What it proves:** where today's code spends time and bytes as data grows. It's the "before" for every storage and IPC change. It says nothing about real UW timing.
**Noise:** across runs, throughput varied about ±20% and p95 up to 2.6×. So every adopt threshold asks for an effect of 3× or more, or is structural.

| Metric | Size | Today (MT1) | Adopt at |
|---|---|---|---|
| Ingest throughput | 100 / 1,000 / 5,000 resources | 963 / 351 / 78 resources/s | ≥1,000 at 1,000; **≥750 at 5,000 (≥10×)** |
| Database bytes per 1,000 resources | 5,000 | 15.6 MB | **≤11 MB (−30%)** |
| Search p50 / p95 through the store API | 1,000 | 10.5 / 16.4 ms | ≤2 / ≤8 ms |
| Search p50 / p95 through the store API | 5,000 | 56 / 197 ms | **≤5 / ≤15 ms** |
| Queries returning no hit | 24 queries | 45.8% | question recall@5 ≥0.90; correct "not found" ≥0.80 |
| Command payload (full snapshot) | 5,000 | 28.8 MB; execute p50 480 ms | **≤256 KB**; p95 ≤50 ms |
| Canvas full sync, 5 courses | replay | 79 requests (15.8 per course) | see D37 targets |
| Zero-change re-sync | replay | 69 requests (0.87 of a full sync) | only changed courses read |
| Fresh database create and migrate | in process | 14.5 ms p50 | migration with backup ≤2 s, 0 rows lost |
| Jobs queued by one 5-course sync | replay | 300, most with no consumer | only kinds with a consumer are queued |
| Not measured yet | | the live sync; the renderer ↔ worker round trip and cold start (no timing hooks); the AI ledger | |

### 8.2 SQLite spike (P2 review, synthetic data, this laptop, single runs)

**What it proves:** the cause of each MT1 problem, and that the fix works in isolation. They're indicative numbers, not the MT1 record; MT1 "after" confirms them.

| Finding | Measured |
|---|---|
| The FTS delete scans the whole table | 5.4 ms per delete at 1,000; 23.4 ms at 5,000; about 88% of ingest time |
| Ingest without that path | 2,147 resources/s (a zero-change re-ingest of 5,000) |
| Search time spent re-reading each hit | about 88% |
| FTS match only: prefix-AND, all rows vs OR + BM25, `LIMIT` 20 | 6.4 / 21.2 ms vs 1.2 / 5.6 ms p50/p95 at 5,000; contentless 0.9 / 5.1 ms |
| Planted-answer recall@5 | OR + BM25 10/10; prefix-AND 0/10 |
| FTS content copy | 24.2 of 78 MB (31%) at 5,000 |
| Zero-change re-sync growth | +15.8 MB (+20%) at 5,000 |
| Purge | 8.7 s at 5,000 (target ≤1 s) |
| `VACUUM INTO` backup | 317 ms for 92 MB (target ≤1 s) |

### 8.3 Warm sessions (plan D38, measured on this laptop, 2026-09-26)

| Mode | Latency | Fixed tokens |
|---|---|---|
| a new `claude -p` per call | 5.8–7.4 s | 2.8k–11.3k |
| one warm session, follow-up asks | 1.7–2.2 s | the course prefix read from cache |
| our system prompt replacing the default | | 11.3k → 2.8k |

**What it proves:** the pool saves seconds per ask on this machine. It doesn't yet prove it's the right default: spikes S1–S10 (history growth, idle memory, Codex caching) and MT6's warm-versus-cold row decide that. Cache reads are billed at a fraction of input on the key route ([Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing)); on a subscription they count against the plan's own limits.

### 8.4 Thresholds not yet measured

- **P1 live trial:** launch to setup ≤3 s; back from sign-in to confirmed ≤3 s p95; first assignment ≤30 s; relaunch to "Sign in again" ≤2 s with 0 requests; 0 false "Sign in again"; 0 requests before the checkbox; 0 Jev or AI requests in local mode.
- **Freshness:** a new dated item ≤5 min, undated material ≤15 min, while the student is present.
- **Public comparisons** (spec B6, MT7a/MT7b): targets are fixed before anything runs, and the rows we lose are published too ([benchmarking](notes/benchmarking.md)).

## 9. Where we differ from recorded decisions, and the open calls

The evidence-backed differences are in [where we differ](notes/where-we-differ.md). The human calls below come from the plan's conflict review ([plan §9](plans/2026-09-26-course-backend/plan.md#9-open-human-calls) carries the canonical list as it's updated). Each position is stated with its source, and none is settled here.

| # | The question | Our direction | The team's recorded position | Who decides | What depends on it |
|---|---|---|---|---|---|
| H1 | Pricing and setup prerequisites | open source and free with the student's own keys; $5 lifetime for the hosted Jev service (Nathaniel, 2026-09-26) | a $5 one-time app licence covering the service and company-funded Jev ([decisions](decisions.md)) | Nathaniel and Ben | licence activation in setup (T62), the setup screen's recipients, the price row in the benchmark, the submission text |
| H2 | "Remember my sign-in" | opt-in saved sign-in, filled on UW's login page after an expiry; Duo still decides (plan D39) | "Never automate Duo or bypass expiry" ([AGENTS.md](../AGENTS.md)) | Ben reads D39 against the rule; the team | T05e, the live trial, the public disclosure |
| H3 | A sign-in window that opens by itself | opens by itself when a sign-in is needed and "Keep me signed in" is on (plan D33) | "the app does not pop up a login during background work" ([pipeline details](pipeline-details.md)) | the team | T05c's behaviour, T05e |
| H4 | Jev links and scopes applied without review | settled by code, then Jev, then one pass; correctable in one click, never a confirmation step (plan D33) | "auto-apply only independently checked exact identity rules" until evaluation supports more ([pipeline details](pipeline-details.md)) | the team | T20, T22, MB1 as the adoption gate |
| H5 | The subscription CLI route | the student's own Claude Code or Codex sign-in drives the app's runs (plan D36) | no subscription integration promised before it's verified ([AGENTS.md](../AGENTS.md)); verify per route ([decisions](decisions.md)) | Nathaniel and Ben; accepting Anthropic's Commercial Terms before any release | T12's routes, D38's background lane, T40/T81 wording |
| H6 | Syllabus brief vs the course-intelligence profile | the syllabus becomes the course's checked brief from our course pass (plan D34) | the compiler's cited-policy profile; "Unknown policy is not permission" ([course intelligence](course-intelligence.md)) | the team, with the compiler's authors | where the brief lives; which policy source governs coaching |
| H7 | Terminal-driven workspace vs the near-approved Home | a command bar and live activity line over one workspace (plan D40) | "Home is approximately 95% desired … Preserve its structure" ([DESIGN.md](../DESIGN.md)) | Ben, as design owner, from a concrete comparison | the workspace UI, T43, P17, the dictation mic's place |
| H8 | The mastery bar and percentage copy | an evidence-defined bar toward mastery of an assessment (plan D21) | "No invented mastery, readiness score, or completion claim" ([Home direction](home-design-direction.md)) | the team | T54, P17, the copy lint |

**Also open:**
- **T02:** the operator signs off the AI boundary (spec §2) before phase 2. Owner: Nathaniel.
- **PRs to `main`** for the shared-package changes (schema v6/v7, the agent-API move, the gateway endpoints): when, after G0. Owner: Nathaniel with the team.
- **Day-plan storage** (§4.3): the rail author's call.
- **Two MCP issues** were reported to the team privately.

## 10. How to run and verify

Node 24, pnpm 10.29.2.

| Command | What it checks |
|---|---|
| `pnpm install` | dependencies |
| `pnpm check` | TypeScript across apps, packages and `evals/**` |
| `pnpm test` | the whole suite (`tsx --test tests/*.test.ts`): 359/359 at `b496d0a` |
| `node scripts/test-one.mjs tests/<file>.test.ts` | one task's tests (fails if the file is missing) |
| `pnpm build` | check, then the desktop build |
| `pnpm magic:perf --suite baseline` | MT1 on synthetic data; results go to `.data/perf/<commit>/`, which git ignores |
| `node docs/plans/2026-09-26-course-backend/check-tasks.mjs` | the task graph: dependencies, cycles, phase order |

**The live trial** (the `live-trial` procedure, with the operator present):
- The operator signs in in the app's own window with their NetID and Duo. No agent types credentials or approves Duo.
- Every agent check runs headless and read-only: no submit, enrol, post or quiz attempt.
- Raw numbers stay in `.data/`, outside git. Only aggregates are published, including the rows we lose.
- Status as of this update: the trial has started; no NetID sign-in has been completed yet.

## 11. What's next

The build order is in [§2.3](#23-whats-left-in-build-order). The dependencies between the main pieces:

```mermaid
flowchart LR
  L1["Data lane: v6, v7, passages"] --> T15["T15 scoped queries"]
  L2["Seams lane: inventory, access, freshness"] --> T15
  L1 --> WIRE["Pack job and ledger in the worker"]
  RT["Runner, pool, packs (merged)"] --> WIRE
  D45["D45 onboarding: profile, terminal, flow"] --> WIRE
  L1 --> T20["T20 Jev item cards"]
  T20 --> T21["T21 course pass"]
  WIRE --> T21
  T21 --> T22["T22 mapping"]
  T22 --> GEN["Generation: T57, T58, T64, then packs"]
  LRN["Learning engines"] --> GEN
  GEN --> STUDY["Study surfaces: T54, T47, T59, T43"]
  L1 --> T50a["T50a typed API"]
  T50a --> PLAT["Course bank and platform: T50b, T55"]
```
