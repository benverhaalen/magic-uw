# Tasks: backend first, then the LLM features, then the study system

**Inputs:** [spec.md](spec.md) v7 (§2 AI boundary, Parts A–I) and [plan.md](plan.md) (D1–D30). **How it runs:** [execution.md](execution.md) splits these tasks into units U0-U10: a research pass, a /plan-run fleet, review, live trials, measurement.
**Check after every edit:** `node docs/plans/2026-09-26-course-backend/check-tasks.mjs` (dependencies defined, none superseded or dropped, no phase inversions, no cycles).
**Revision 8, final:** generation assisted by code (T57, T58, T64), the notes system (T59), and one-checkbox consent.
**Revision 7:**
- the AI-boundary gate (T02) and the consent gate (T06) in phase 1
- the final review's fixes

**Revision 6** set:
- **backend first**, benchmarked against public tools (D19, D22)
- a **study tool, not a game** (D20): no XP, streaks, freezes, path, Match or notifications
- **nobody idles** (D23): phase order is priority, and a later task starts only when nothing earlier is ready without an owner

**Baseline** (2026-09-26, after merging `main` `9302865`): `pnpm check` passes; `pnpm test` passes 254/255 (the Windows file-mode case, fixed by T05a). `main` now includes the planning integration (My UW, DARS, Course Search & Enroll) at schema v4.

**Rules:**
- **One writer per path.**
  - T05a and T05b own the shared files and create stubs.
  - A takeover of a block in another task's file is named in the taking task, and the block carries `// owner: <task>`.
  - N and P tasks own their files under `packages/learning/**` and `evals/**`, except `practice/targets.ts` (T47), `practice/assessment-quiz.ts` (T53), and `insights/mastery.ts` and `insights/prep.ts` (T54). Their full lines are in the [learning tasks](../2026-09-26-notebook-and-study-tracking/tasks.md); **§L rewrites their dependencies and accepts.**
- **Checks:** `node scripts/test-one.mjs tests/<its test>.test.ts` (it fails if the file is missing) unless a task states otherwise. The lead runs every check.
- **Fixtures are synthetic.** No real mailbox, course or message content in `tests/`, `evals/` or `docs/`. Operator-account data stays in `.data/` and `research/`.
- **Only conditions gate work:**
  - T30 on E1; T35 on E1 failing
  - captions (T32) on K1
  - the T20b and T51 deploys, T62 payment and T63 signing on the operator's say and accounts
  - T60 is written last
- **The 11:00 CT submission** shows what exists. N28 runs on whatever is done, labelling skipped steps.

## Phase 1: the backend, finalized, optimized and benchmarked

```
G0 Nothing is pushed until the team's release cleanup is done (gates pushing, not work)
  seat: lead
  accepts:
    - work starts now from the local base
    - afterwards a fresh branch from the rewritten main receives our non-merge commits by cherry-pick, and only that branch is pushed
    - negative: no branch containing the coordination-history merge is ever pushed

T00 Live probes: E1 UW consent for Mail.ReadBasic and optional Mail.Read, and the fields returned · K1 Kaltura captions · MD1 served models (claude, codex, gemini) · S1 real sync counts · RP1–RP3 remote connectors on the phone apps (claude.ai mobile, MCP App views, ChatGPT mobile)
  seat: lead (operator present)   owns: [research/probes-2026-09-27.md]   dependsOn: [T05a]
  check: { argv: ["node","scripts/check-probes.mjs"], expectExit: 0 }
  accepts:
    - each probe has a dated Verdict
    - negative: the check fails on any email address or token; the lead confirms there are no quoted subjects

T01 Entra public client (the operator registers)
  owns: [docs/notes/outlook-app-registration.md]
  accepts:
    - public client; delegated Mail.ReadBasic and Calendars.ReadBasic, plus **optional** Mail.Read (requested only if the student opts into previews); the redirect URI; the verification path
    - negative: no secret or admin-only permission

T02 The AI boundary sign-off (spec §2): the operator reviews every row (system, Jev or AI) and approves or moves it. Changes go into spec §2 with a reason.
  seat: lead (operator decides)   owns: [spec.md §2 edits only]   dependsOn: []
  check: spec §2 carries "Signed off: <date>" with the operator's changes listed
  accepts:
    - phase-2 tasks start only after sign-off
    - negative: no study-time function is assigned to AI

T06 One-checkbox consent and disclosures (spec G1; P1 review, research/piece-P1/synthesis.md §5.3): the checkbox comes before any network request; consent is enforced in maySend
  owns: [packages/core/src/egress.ts, packages/domain/src/index.ts (maySend block, // owner: T06), packages/storage/src/index.ts (consent block in preferences, and addReceipt accepting preview_required, // owner: T06; no schema change), packages/core/src/index.ts (the consent and preview.ack command cases, // owner: T06), apps/desktop/src/main.ts (the consent gate block T05d leaves, // owner: T06), apps/desktop/src/renderer/consent/**, tests/egress.test.ts]   dependsOn: [T05d]
  accepts:
    - before any network request, the first-run setup screen states the recipients (Jev, and the chosen provider or none), the purpose, the data categories, the provider settings, how to revoke, the UW session note and the Canvas page-view effect; one checkbox, then the UW sign-in, then Canvas connects automatically; "Load sample course" stays usable before it (no network)
    - the disclosure: "Magic Canvas reads your courses the way you would by opening them. Canvas can record these as page views, and reading a module item can satisfy a "must view" requirement. Magic Canvas never submits, posts, enrolls or marks anything complete."
    - the UW session note: "You sign in on UW's own page. If you choose Remember my sign-in, your NetID sign-in is saved encrypted on this computer only."
    - consent is a record per recipient with a disclosure version and time, written only by the consent command; the privacy command can't write it; maySend refuses any hosted recipient without a current record
    - maySend refuses planning, holds and audit for every non-local recipient, whatever the flags
    - every request shows a non-blocking context chip and writes a receipt describing the exact payload; a blocked request writes a receipt too
    - the first send of student_work, grades, comments or communications to a recipient shows one blocking preview of the actual payload (Ben's accepted flow); "always preview" makes it every time; declining sends nothing and writes "blocked"; a background job that needs a preview waits and never prompts
    - switching provider shows that provider's consent before any send
    - main refuses magic:signin, magic:sync, planning sync, source-fetch and evaluate until consent is recorded; the worker's refresh and public reads refuse too
    - the UI follows DESIGN.md and the repo's magic-design skill (AGENTS.md)
    - negative: a network-layer spy (webRequest on every session, plus a fetch interceptor in main and the worker) records 0 non-loopback requests before the checkbox; 0 Jev or provider requests before consent, and 0 ever in local mode across a full sync; no in-app approval prompt exists beyond the setup checkbox, a new provider's consent, the first-use sensitive preview and always-preview; a Canvas capture imported before the checkbox triggers no network read

T05d Session and consent seams: the P1 slice of T05b (P1 review §6)
  owns: [packages/contracts/src/** (consent and preview contracts, providers), apps/desktop/src/{main,preload,worker}.ts (plumbing: the consent gate block for T06, the presence message, the onboarding stub), packages/core/src/refresh.ts (cadence table with the presence gate), apps/desktop/src/renderer/App.tsx (the consent route slot), tests/seams-p1.test.ts]   dependsOn: [T05a]
  accepts:
    - `hostedProvider` and the privacy recipients gain `codex` and `openrouter`; `chatgpt` stays readable for stored preferences
    - contracts: the consent record (recipient, disclosure version, time), the `consent` command (grant, revoke), `preview.ack`, `alwaysPreview`, and a receipt status for "preview required"
    - main: a marked consent gate block (`// owner: T06`), a `presence` message beside suspend and resume (present = OS input within the last 30 minutes and the screen unlocked, from `powerMonitor`), and the onboarding stub block (T40)
    - the scheduler's cadence table: signed-in reads (Canvas, GitLab, My UW, Enroll) run only while present; feeds run when away; one catch-up read on return
    - negative: no second scheduler; nothing in this task sends a request

T05a Harness and workspace
  seat: executor   owns: [package.json, pnpm-lock.yaml, tsconfig.json, packages/{learning,runner,packs,retrieval,agent-api}/package.json, scripts/test-one.mjs, scripts/check-probes.mjs, tests/storage.test.ts (Windows guard), tests/harness.test.ts]
  dependsOn: []   check: test-one on harness, and pnpm test
  accepts:
    - the full suite passes on Windows (255/255 at `9302865`; the file-mode guard fixes the one failure)
    - dependencies ts-fsrs, @azure/msal-node
    - the path aliases
    - "magic:acceptance" and "magic:perf" scripts
    - negative: test-one fails for a missing file

T05c Session state, expiry and "Keep me signed in" (P1; spec A1; P1 review §1-§4)
  owns: [packages/connectors/src/canvas-http.ts (expiry block, // owner: T05c), apps/desktop/src/main.ts (the magic:signin block, and a new tray and login-item block, // owner: T05c), apps/desktop/src/renderer/App.tsx (the sign-in banner block), tests/session.test.ts]   dependsOn: [T05d]
  accepts:
    - a 401 whose body status is "unauthorized", or a 403 that isn't a rate limit, marks only that scope inaccessible; needs_sign_in is declared only after /api/v1/users/self/profile also returns 401 with status "unauthenticated"
    - at launch, a missing canvas_session in persist:uw is detected from the cookie store with 0 network requests and shows "Sign in again" within 2 s; with "Keep me signed in" on, the sign-in window opens by itself (D33)
    - "Keep me signed in" (on by default): closing the window keeps the app in the tray, the app starts at login (setLoginItemSettings), and the tray menu offers Open, Sign out and Quit; Quit and Sign out end the session; with it off, closing the window quits as today
    - the banner reads "Sign in again" and opens the sign-in directly (one click)
    - a second magic:signin call while the window is open waits for it instead of returning
    - the My UW and Enroll sign-ins close themselves once the existing session.json or student-info read confirms the session
    - an expiry and a re-sign-in keep every stored record (the resource count is unchanged)
    - negative: no password field is read or filled outside T05e's fill block (the UW login origin, with Remember my sign-in on); no cookie is written or restored; no hidden window; no request is sent to extend a session

T05e Remember my sign-in (P1; plan D39; spec A1)
  owns: [apps/desktop/src/signin-preload.ts (new: the sign-in window's capture and fill block), apps/desktop/src/main.ts (the vault entry and the preload hook in the sign-in window, // owner: T05e), apps/desktop/src/renderer/App.tsx (the Settings "Forget my sign-in" row), tests/remember-signin.test.ts]   dependsOn: [T05c, T06]
  accepts:
    - a "Remember my sign-in on this computer" checkbox at the UW sign-in, off by default, with the note that it's stored encrypted on this computer only, never sent anywhere, and removable in Settings
    - capture only with the box ticked, only on UW's exact NetID login origin (the host measured in the P1 trial); the credential is stored by safeStorage in the app's data folder, only when `safeStorage.isEncryptionAvailable()` is true and, on Linux, the backend is not `basic_text`; otherwise the box is disabled with the reason (Electron safe-storage docs: available "once the app emits the 'ready' event on Windows and Linux, or if the Keychain is available on macOS")
    - on an expiry that a sync finds while the student is present, the sign-in window fills and submits the saved sign-in; Duo is shown only when Duo requires it
    - one failed automatic sign-in clears the credential and shows the normal sign-in
    - Forget my sign-in, Sign out, purge and uninstall delete it
    - negative: never on any other origin; never in the database, logs, receipts or any egress; no retry loop; no Duo automation; no fill without the box ticked

T05b Integration seams (supersedes learning B01, B03, B04)
  owns: [packages/contracts/src/**, packages/core/src/index.ts, packages/core/src/jobs/registry.ts + stubs (jobs/{card,link,compile,pack,passages}.ts, core/src/drain.ts, learning/src/router.ts), packages/core/src/refresh.ts (cadence table), apps/desktop/src/{main,preload,worker,ingestion}.ts (plumbing), apps/desktop/src/renderer/App.tsx (route slots), scripts/build.ts, tests/seams.test.ts]
  dependsOn: [T05a, T05d]
  accepts:
    - the source kinds, Commands (map, confirm, pack, ui_event, learning ops incl. practice.target and practice.assessmentQuiz) with an exhaustive switch
    - (moved to T05d: the providers, the consent contracts and the presence-gated cadence; T05b keeps the rest)
    - the learning channel to the router stub
    - the save → enqueue hook
    - one scheduler: hot 5 min only while present (T05d's gate), mail 5 min, feeds hourly
    - main: source-fetch for kaltura and graph, the vault accepting Outlook ICS hosts, a Graph proxy stub, evaluate-batch, and marked stub blocks for the reader (T50b), onboarding (T40) and licence (T62)
    - negative: an unknown Command is a type error; there's no second scheduler

T10 Schema v5: course core, job subjects, the drain, purge (after planning's v4)
  owns: [packages/storage/src/{index,v5}.ts (the index.ts migration block only; planning's v4 untouched), packages/storage/src/v6-learning.ts (stub → T10L), packages/core/src/drain.ts (takeover), tests/storage-v4.test.ts]   dependsOn: [T05b]
  accepts:
    - v4 → v5 keeps every row, including the planning tables
    - assessments with no resource
    - lease(kinds[]) with a staleness rule per subject
    - the drain serves only its registered kinds, with no hot loop
    - the "_life" sentinel
    - purge enumerates every table
    - **before migrating,** a `VACUUM INTO` backup is taken and restored automatically if the migration fails
    - negative: a database newer than v6 is refused; a failed migration leaves the original database intact; the planning tables are never altered

T10L Learning and practice tables (plan D17)
  owns: [packages/storage/src/v6-learning.ts, tests/storage-learning.test.ts]   dependsOn: [T10]
  accepts:
    - the learning spec §7.2 and addendum §6 tables as amended by D17: learning_courses as the anchor; learning_coverage keyed to assessments.id; learning_concept_aliases
    - **not created:** the addendum's tables for dropped features (learning_notifications, learning_digests)
    - negative: purge leaves zero rows in every learning table

T11a Quote validator and passage splitter, pure (supersedes N01)
  owns: [packages/retrieval/src/{quotes,split}.ts, tests/quotes.test.ts]   dependsOn: [T05a]
  accepts:
    - split offsets slice back to the exact text
    - verbatim quotes validate against a named version
    - negative: a quote from another version fails

T11b Stored passages, passage FTS, course-scoped search with not-found (supersedes N02)
  owns: [packages/connectors/src/documents.ts (start/end only), packages/retrieval/src/{store,search}.ts, packages/core/src/jobs/passages.ts, tests/passages.test.ts]   dependsOn: [T10, T11a]
  accepts:
    - passages rebuilt per version
    - bm25 with ≤240-character excerpts
    - not-found when nothing supports the query
    - negative: an old version is never searchable

T20 Jev client: batched item cards and links (owns packages/ai/src/index.ts after B07)
  owns: [packages/ai/src/{index,cards}.ts, packages/core/src/jobs/{card,link}.ts, tests/jev-cards.test.ts]   dependsOn: [T05b, T10, T06]
  accepts:
    - code-first classification
    - one batched request per item (O9), cached
    - priority: upcoming assessments first
    - structure-only fallback when refused or rate-limited
    - negative: an unchanged item never re-calls; local mode makes zero Jev calls

T20b Gateway (moved into phase 1: the architecture depends on Jev at course scale; the code is a PR to main, and the deploy needs the operator's say): versioned endpoints (cards, links, item.option_correct.v1, answer.key_idea.v1, concept.match.v1) and configurable limits (supersedes B07; a PR to main reviewed by the gateway owner; the deploy needs the operator's say)
  owns: [apps/gateway/src/**, tests/gateway.test.ts]   dependsOn: [T20]

Sources:
T34 Canvas teachers and TAs   owns: [packages/connectors/src/canvas.ts (users scope), packages/connectors/src/canvas-http.ts (allowlist entry), tests/canvas-users.test.ts]   dependsOn: [T05b]
  accepts:
    - teacher and TA display names per course
    - negative: student enrollments are never stored
T31 Public campus feeds   seat: executor   owns: [packages/connectors/src/feeds.ts, tests/feeds.test.ts]   dependsOn: [T05b, T10]
  accepts:
    - today.wisc.edu ICS and the RSS feeds become life_items
    - negative: my.wisc.edu, Handshake and WIN are refused
T30 Outlook (condition: E1 passed)   owns: [packages/connectors/src/outlook.ts, apps/desktop/src/graph.ts, tests/outlook.test.ts]   dependsOn: [T05b, T10, T01, T00, T20, T34]   (merges after R2)
  accepts:
    - PKCE sign-in; the token stays in main
    - delta pages become life_items with webLink
    - duplicate_of for Canvas, Piazza and Gradescope notices
    - staff matched by name; Jev only on the rest
    - with the Mail.Read opt-in, only the 255-character bodyPreview is stored
    - negative: no body text; Jev never hides a message; a delta only adds new messages
T35 Mail fallback: a code read of the rendered inbox (condition: E1 failed; Microsoft's terms checked)   owns: [packages/connectors/src/outlook-web.ts, tests/outlook-web.test.ts]   dependsOn: [T05b, T10]
  accepts:
    - on demand only, from a synthetic inbox page fixture: sender, subject, date, preview line, link
    - negative: it never runs in background sync; no body is read
T36 Outlook calendar through the published ICS link (reuse Sean's published Outlook calendar in PR #2, `setOutlookCalendar(url)`, once merged; this task then only fills gaps)   owns: [packages/connectors/src/outlook-ics.ts, tests/outlook-ics.test.ts]   dependsOn: [T05b]
  accepts:
    - events parsed within Microsoft's six-month window
    - negative: the feed URL is kept in the vault, never in the store
T32 Kaltura: links and dates, plus captions if K1 passed; never downloads media   owns: [packages/connectors/src/kaltura.ts, tests/kaltura.test.ts]   dependsOn: [T05b, T11b, T00]
  accepts:
    - recordings carry their link and date
    - captions are stored verbatim, as provided, as passages with t_start and t_end, and a watch link at the time offset
    - negative: no media request is ever made
T33 Per-course warm reads (M2 watermarks), meeting ≤5 min freshness (takes over the cadence table and the ingestion selection block)   owns: [packages/connectors/src/canvas-selection.ts, tests/refresh-course.test.ts]   dependsOn: [T05b]
T37 (superseded by the planning integration on main: planning-search, planning-sections, and the enrollment packages; reuse them, and build nothing new here)
  accepts:
    - sections, meetings and rooms for the student's courses, cached per term
    - negative: it never enrolls or changes anything; an endpoint change fails soft, marked partial

T50a The typed academic API: handlers the app calls in-process (read verbs of spec F1, with caps, grants and receipts)
  owns: [packages/agent-api/src/handlers/**, tests/agent-api.test.ts]   dependsOn: [T10, T11b]
  accepts:
    - every verb is within its token cap
    - grants are rechecked per call; a receipt per call
    - negative: a revoked grant is refused on the next call

Measured and optimized (spec B5):
MT1 The perf harness and baseline (the measurement plan's MT1)
  owns: [evals/perf/**]   dependsOn: [T05a]   check: { argv: ["pnpm","magic:perf","--suite","baseline"], expectExit: 0 }
  accepts:
    - writes .data/perf/<sha>/baseline.json with every §1 metric of the backend optimization plan
    - negative: it refuses to run without a recorded git SHA
T15 O1: scoped queries instead of full snapshots (takes over the snapshot block in core/index.ts and the data-loading block in App.tsx)
  owns: [packages/core/src/queries.ts, tests/queries.test.ts]   dependsOn: [T05b, T10, MT1]
  accepts:
    - views get paged, course-scoped results plus a change cursor
    - command payload bytes drop, reported before and after on MT1
    - negative: no view still needs the full snapshot
T14 Storage optimizations: O2 statement cache, O3 synchronous=NORMAL, O5 text_hash, M3 external-content FTS, M4 mmap/cache (takes over the relevant blocks in storage/src/index.ts after T10L)
  owns: [packages/storage/src/perf.ts, tests/storage-perf.test.ts]   dependsOn: [T10L, MT1]
  accepts:
    - each change reported before and after on MT1; the M-items adopted only at their thresholds
    - negative: no durability loss beyond WAL-NORMAL's documented window; a submission flip no longer invalidates text judgments
T16 O6: extraction cached by file content hash; OCR only for empty pages (takes over the caching block in documents.ts)
  owns: [packages/connectors/src/extract-cache.ts, tests/extract-cache.test.ts]   dependsOn: [T11b, MT1]
  accepts:
    - an unchanged file is never re-extracted
    - negative: a changed file always is
T17 Canvas request cost: M1 concurrency, M8 GraphQL batching, M9 ETag/304 (takes over the concurrency default in canvas-http.ts)
  owns: [packages/connectors/src/canvas-graphql.ts, tests/canvas-cost.test.ts]   dependsOn: [T34, MT1, T00]
  accepts:
    - each item adopted only at its threshold (≥30% faster with zero 429s; −40% request cost; any 304)
    - negative: no 429 storm in the live run
MT2 Dataset fetchers with a licence gate (the measurement plan's MT2), including the OCW import used by the benchmark
  owns: [evals/datasets/**]   dependsOn: [T05a]
MT7a Head-to-head, backend rows (spec B6): manual setup steps, sign-in → all sources in vs hand upload, freshness, and purge and data locality, against Gemini Notebook, Quizlet, ChatGPT/Claude Projects and Open Notebook (same model); the public tools are timed by hand, following the protocol
  seat: lead + operator   owns: [docs/notes/benchmark-protocol.md, evals/h2h/backend/**]   dependsOn: [MT1, MT2, T15, T14, T33]
  accepts:
    - the targets in spec B6 are copied into the protocol before any run
    - raw results go to .data/bench/h2h/
    - negative: a row that can't be timed fairly is "not measured", never estimated

R1 Review of T05a, T05b, T06, T10 and T10L   seat: reviewer   owns: [research/review-R1.md]   dependsOn: [T05a, T05b, T06, T10, T10L]
  accepts:
    - those tasks merge only when every finding is fixed or accepted with a reason

N28 (amended) Scripted demo: runs whatever exists, labelling each skipped step. At 11:00 that's at least the phase-1 backend and the course map   owns: as its learning line   dependsOn: [T05b, N29]
N29 Synthetic smoke cases (learning line, unchanged)
```

## Phase 2: the system-driven, LLM-token features (and the engines they need)

```
T12 ModelRunner, CLI adapters, local mode (supersedes N20, N21)
  owns: [packages/runner/**, tests/runner.test.ts, tests/fixtures/fake-cli/**]   dependsOn: [T05a]
  accepts:
    - argv exactly as spec E2, the prompt on stdin
    - usage parsed; probe()
    - the local adapter over packages/ai/src/local.ts with zod validation and one retry
    - on Windows, the native binary is resolved
    - negative: never --dangerously-skip-permissions, --bare or --dangerously-bypass-approvals-and-sandbox; the prompt never in argv
T13 Packs: format, checks, cache, ledger (learning_artifacts); O8 stable prefixes (system, then the course skeleton and policy, then the question last)
  owns: [packages/packs/core/**, packages/core/src/jobs/pack.ts, tests/packs.test.ts]   dependsOn: [T10L, T11a, T12, T06, T02]
  accepts:
    - retry → escalate → student question
    - a cache hit spends no tokens
    - a ledger row per call
    - the prompt prefix is byte-stable across calls for the same course
    - a daily background token budget in the configuration; on a provider usage limit, background work pauses (no retry, no escalation) and on-demand work tells the student
    - negative: an invented quote is never stored as verified
T40 Onboarding: detect the CLIs, auth status, model probe, tiers, local mode, and the ledger view (takes over the onboarding blocks)
  owns: [apps/desktop/src/onboarding.ts, apps/desktop/src/renderer/settings/**, tests/onboarding.test.ts]   dependsOn: [T12, T05b]
  accepts:
    - the ledger shows tokens per action
    - "config import" is read-only: each CLI's default model and plan tier, and an OpenRouter key from the environment only with consent
    - negative: no credential file is read; the student's own client settings are never written

Engines the LLM features need (learning lines; §L dependencies): N00 · N27 · N04 · N05 · N06 · N11 · N24 · N14 · N12 · N15

T21 The course pass and compile job   owns: [packages/packs/course-pass/**, packages/core/src/jobs/compile.ts, tests/compile.test.ts]   dependsOn: [T11b, T13, T20, N05]
  accepts:
    - sessions, learning_concepts (origin model), assessments (including syllabus-only ones), scope, learning_coverage and map_links, with tiers and reasons
    - enqueued once the syllabus and assessments are harvested
    - negative: an invented quote, unknown ID or out-of-term date is rejected, retried, then escalated; student-edited concepts are never overwritten
T22 Mapping: caps, ranking, floor, confirm, incremental, the T1–T4 basis (supersedes N13)   owns: [packages/core/src/map.ts, tests/mapping.test.ts]   dependsOn: [T21, T20]
  accepts:
    - caps: Core ≤8, Also useful ≤6, Practice ≤5, assignment ≤5
    - confirm locks map_links and learning_coverage
    - chapter and module sections recorded per assessment
    - negative: a settled scope is never rewritten silently
T57 Content analyzers, run at ingest (spec §2, generation assisted by the system)
  owns: [packages/retrieval/src/analyze/**, tests/analyzers.test.ts]   dependsOn: [T11b, N05]
  accepts:
    - from synthetic fixtures: key terms and definitions, formulas, worked examples, code snippets, ordered processes and instructor-emphasis signals, each with offsets and topic tags
    - negative: an extraction whose span doesn't slice back to the text is discarded; nothing calls a model
T58 The generation planner and type router
  owns: [packages/packs/core/src/planner.ts, tests/planner.test.ts]   dependsOn: [T57, T22, T13]
  accepts:
    - cells (section × topic × type × count) come from coverage weights, and later from the student's weak topics
    - the type is routed by content (definition → cloze or typed; process → ordering; formula → numeric; code → output tracing; confusable pair → MC)
    - instructor and existing checked items fill cells first
    - the model gets only the missing cells' passages, in one batched call per section
    - negative: a cell is never sent twice for unchanged passages (text hash)
T64 Verifiers: numeric recompute, a WASM code sandbox, near-duplicate removal
  owns: [packages/packs/core/src/verify/**, tests/verifiers.test.ts]   dependsOn: [T13]
  accepts:
    - numeric keys are recomputed and a mismatch is dropped
    - Python (Pyodide) and JavaScript (QuickJS) snippets run for output-tracing questions; the licences are checked at adoption
    - near-duplicates are removed across instructor and generated items
    - negative: the sandbox has no network, no file system and a time limit (a test tries all three); a snippet that times out drops its item

T45 The items pack: MC, T/F, typed, cloze and numeric families   owns: [packages/packs/items/**, tests/items-pack.test.ts]   dependsOn: [T13, N05, N06, T58, T64]
  accepts:
    - tagged to 1–3 topics, each citing a verified passage
    - N06's code stages always run
    - Jev per-option Nouls when served, otherwise the §6.4 label
    - negative: an item failing a code check is never served
T53 Assessment quiz builder (spec H3): sections from the assessment's chapters and modules; T1 instructor practice quizzes → T2 instructor details plus mapped materials → T3 past exams → T4 materials; weights from coverage; every question tagged with its topic and source
  owns: [packages/learning/src/practice/assessment-quiz.ts, tests/assessment-quiz.test.ts]   dependsOn: [T45, N15, T22, N24, T58]
  accepts:
    - ≥1 question per section; the tier shown
    - results by section and topic
    - missed topics return 1–2 days later (successive relearning)
    - T1 questions are extracted by code where possible (MB3)
    - negative: a question without a topic tag or a quote-valid source is never included; a T3 question outside this term is dropped; no predicted grade; **a Canvas quiz attempt is never started**
T41 The flashcards pack and precompute   owns: [packages/packs/flashcards/**, tests/flashcards.test.ts]   dependsOn: [T13, N14, N24, T57, T58, T64]
  accepts:
    - term and cloze cards are built by code from T57's definitions first; the model writes only cards for concepts without a clean definition
    - cards from a settled scope, a topic set or misses, each quote verified
    - precompute ≤14 days
    - FSRS
    - negative: an unverified card is dropped; swapping sides never creates a second card
T44 The study guide pack   owns: [packages/packs/study-guide/**, tests/study-guide-pack.test.ts]   dependsOn: [T13, N12, T57]
  accepts:
    - the outline (sections, key terms, formulas, dates) is built by code; the model writes only each section's prose
    - negative: an unsupported claim is removed and counted; no claim without a verified quote
T46 The practice exam pack (with N15)   owns: [packages/packs/practice-exam/**, tests/practice-exam-pack.test.ts]   dependsOn: [T45, N15, T22, T58]
  accepts:
    - the blueprint follows coverage, with the tier and provenance shown
    - negative: no score prediction
T42 Chat and explain, with retrieval the app runs (supersedes N03)   owns: [packages/packs/chat/**, packages/core/src/chat.ts, tests/chat.test.ts]   dependsOn: [T11b, T13, T22]
  accepts:
    - ≤3 `need` lookups per round, ≤2 rounds; citations verified; "couldn't find support" when nothing matches
    - negative: the model is never handed tools; a third round is refused
T48 The rescope and mail-digest packs   owns: [packages/packs/{rescope,mail-digest}/**, tests/rescope-digest.test.ts]   dependsOn: [T13, T22]
  accepts:
    - the rescope pack re-runs one assessment's scope and flags changes to a settled scope
    - the digest is one batched daily call for action-flagged mail only
    - negative: a settled scope is never rewritten silently
T52 The audio overview: a script pack, played with local OS voices   owns: [packages/packs/audio-overview/**, tests/audio-overview.test.ts]   dependsOn: [T13, T22]
  accepts:
    - negative: no network call for speech
MT3 The grounded-Q&A suite (quote validity and claim support reported separately)   owns: [evals/qa/**]   dependsOn: [MT2, T42]
MT4 The item-quality suite (flaw rules; seeded catch and false-drop)   owns: [evals/items/**]   dependsOn: [MT2, T45]
MT6 Ledger and cascade ablation: code-first vs all-model; one call vs an agent loop (S6); warm vs cold sessions (S5)   owns: [evals/cost/**]   dependsOn: [MT3, T13, T41]
MT7b Head-to-head, answer, quiz and cost rows (spec B6), NotebookLM first: sign-in → first course map; answer p50 and p95 over 30 questions; on-demand quiz time; tokens per answer and per quiz vs the NotebookLM-style long-context baseline and Open Notebook, both on the same model; valid items per 1,000 tokens; model spend per term on the student's own keys, against the same tools, following the protocol   seat: lead + operator   owns: [evals/h2h/answers/**, docs/notes/benchmark-results.md]   dependsOn: [MT7a, MT3, MT6, T41, T53]
  accepts:
    - the published rows include the ones we lose
    - negative: no Jev figure in any committed file
MB1 Scope by code: the share of real assessments whose scope patterns resolve, and precision against the student's labels   owns: [evals/boundary/mb1/**]   dependsOn: [T21, T00]
  accepts:
    - adopted as the default path at ≥60% matched and ≥95% precision
    - the result is written into spec §2
MB2 Code-built cloze cards vs AI cards (validity on a seeded set)   owns: [evals/boundary/mb2/**, packages/packs/flashcards-cloze/**]   dependsOn: [T41, MT4]
  accepts:
    - adopted where validity is within 5 points; the default card source per course is recorded
MB3 Instructor-question extraction by code, per file type   owns: [evals/boundary/mb3/**]   dependsOn: [T53]
  accepts:
    - adopted per type at ≥90% correctly split questions

R2 Review of T12, T13, T21, T45, and T30 when built (T30 merges after R2)   owns: [research/review-R2.md]   dependsOn: [T12, T13, T21, T45]
```

## Phase 3: the study system (Open Notebook and Quizlet-like)

```
Engines (learning lines; §L): N07 knowledge model (R1–R6) · N08 typed grading · N09 Learn and the mistakes queue · N10 priority and session builder · N25 router · N23 barrel · P01 · P02 · P07 flashcards quality of life · P08 Write · P09 Test · P11 stars, filters, own cards · P12 error patterns · P13 anchors, coverage map, what changed · P05 quick study sessions · P14 calibration and session history (no time-on-task totals) · P16 copy lint

T54 Understanding and mastery (spec H4, H6): per-topic level bars; the assessment mastery bar ("Mastered n of m topics", "not a grade prediction"); the prep list for an assessment and for a course
  owns: [packages/learning/src/insights/{mastery,prep}.ts, tests/insights-mastery.test.ts]   dependsOn: [N07, N10, N24, T22]
  accepts:
    - the topic bar is min(0.99, min(c/8,1)·min(p̂/0.75,1)), and 1 only at Solid
    - the assessment bar is coverage-weighted, with a change marker after each answer
    - fired rules shown as reasons
    - a replay test that **starts with a wrong answer** shows the bar falling on each wrong answer and rising on each right one
    - negative: no predicted score or pass probability; a lapse visibly lowers a Mastered topic; hinted answers don't move it
T47 Quiz me on the topics I choose (spec H5): selection first; description resolved by code → Jev → rescope pack; editable chips; aliases saved
  owns: [packages/learning/src/practice/targets.ts, packages/packs/rescope-topics/**, tests/practice-targets.test.ts]   dependsOn: [N05, N10, N24, T13, T20, T45]
  accepts:
    - results by topic, with levels before and after
    - negative: never widens silently; an unchecked concept is never offered as a chip
T59 The notes system (spec D7): a code-built .docx tree per term and course, one templated note per session, assignment, exam and reading, kept current and linked both ways
  owns: [packages/notes/**, apps/desktop/src/notes-targets.ts, packages/packs/notes-outline/**, tests/notes.test.ts]   dependsOn: [T05b, T22, T20, T13]
  accepts:
    - targets: a local folder by default; detected Google Drive or OneDrive sync folders offered with no approval; the optional Drive API (drive.file) or Graph upload behind its own consent
    - Jev picks the template; the optional outline pre-fill is checked
    - a new lecture creates its note with source links
    - negative: a note the student edited is never overwritten (hash-detected; a new version is written beside it); only paths and hashes are stored

T43 The notebook UI: course page (Sources, Notes, Studio incl. audio), dossier, assignment work view, the code-built concept map, life items on the Briefing
  owns: [apps/desktop/src/renderer/notebook/**, tests/renderer-caps.test.ts]   dependsOn: [T05b, T22, T41, T44, N05, T50a, T59]   check: test-one on renderer-caps, and pnpm test:desktop
  accepts:
    - caps and confirm
    - each session's note opens from the notebook (T59)
    - ui_events and learning_views written
    - keyboard navigation and WCAG AA contrast (I3)
    - negative: 20 Core candidates render as 8 plus "All in scope (20)"
P17 (amended) The Practice and Insights screens: Flashcards, Learn, Write, Test, the assessment quiz with sections and topic tags, quiz-me chips, level bars and the mastery bar, the prep list, the coverage map, error patterns
  owns: [apps/desktop/src/renderer/{practice,insights}/**, scripts/practice-journey.ts]   dependsOn: [T05b, N25, N14, P05, P07, P08, P09, P11, P12, P13, P14, T47, T53, T54]
  check: { argv: ["tsx","scripts/practice-journey.ts"], expectExit: 0 }
  accepts:
    - the journey covers every listed surface; keyboard and contrast (I3)
    - calibration (P14) and quick sessions (P05) are reachable
    - negative: the P16 lint over renderer and packs finds nothing; no XP, streak or game element renders; 50 wrong answers in a row, and the next item is still served
Validation (learning lines): N22 evaluation harness · P18 · P19 · P20 · P21 (supersede the measurement plan's MT5)
MB4 Typed-answer grading without Jev vs human grading   owns: [evals/boundary/mb4/**]   dependsOn: [N08]
  accepts:
    - adopted at ≥90% agreement
```

## Phase 4: secondary, platform, release, close

```
T50b The course bank: the read-only reader, MCP and the magic CLI (supersedes N18, N19, N26; takes over the reader block)
  owns: [packages/agent-api/src/adapters/**, apps/desktop/src/{reader,mcp-server}.ts, apps/cli/**, tests/course-bank.test.ts]   dependsOn: [T50a, T41]
  accepts:
    - MCP and CLI outputs are byte-identical
    - it serves while the app is closed
    - a socket spy proves the app never uses MCP
    - negative: no database path in any connection file or child environment
T55 The open framework (spec F3): docs, examples, a "build your own study tool" guide, the boundary test
  owns: [docs/framework/**, examples/**, tests/framework-boundary.test.ts]   dependsOn: [T50a, T12, T13]
  accepts:
    - framework packages build with zero imports from the app, gateway or licence code
    - a sample connector plugs in with one file
T51 The remote relay (OAuth 2.1, PKCE, pass-through), after probes RP1–RP3; the deploy needs the operator's say   owns: [apps/relay/**]   dependsOn: [T50b, T00]
  accepts:
    - protected resource metadata; per-student endpoint; the desktop approves access
    - negative: the relay persists no content; "desktop offline" when asleep
T62 Licence activation and gateway enrollment, on the operator's chosen payment provider (takes over the licence block)
  owns: [apps/desktop/src/licence.ts, tests/licence.test.ts]   dependsOn: [T05b]
  accepts:
    - a key activates offline-tolerantly and enrolls the device
    - negative: the Jev key never ships to the client
T38 Canvas auth abstraction: the student's session today, or a university-issued OAuth2 developer key (UW partnership groundwork)   owns: [packages/connectors/src/canvas-auth.ts, tests/canvas-auth.test.ts]   dependsOn: [T34]
  accepts:
    - the connector runs unchanged over either auth, with the OAuth2 path stubbed and tested with a fake token endpoint
    - negative: no token is logged or stored outside the vault
T56 Student-written packs (Open Notebook's transformations, done safely)   owns: [packages/packs/student/**, tests/student-packs.test.ts]   dependsOn: [T13, P17]
  accepts:
    - a student saves a named prompt over a chosen scope; it's versioned, run on their AI, and checked like ours
    - negative: a student pack can't disable the quote checks or reach outside the chosen scope
T63 Signed installers and auto-update (the operator's Apple and Windows signing accounts)
  owns: [electron-builder.yml, scripts/release.ts, .github/workflows/release.yml]   dependsOn: [T05a]
  accepts:
    - notarized macOS and signed Windows builds; updates only from signed releases
    - negative: an unsigned update is refused; T10's backup runs before a post-update migration
T60 Legal: research, drafts, expert pass (last)   owns: [docs/legal/**]   dependsOn: [T12, T21, T30, T41, T42, T50b, T51, T62, T06]
  accepts:
    - destinations per client and for Jev, matching T06's consent screens; lifetime fair use; UW rules; the Canvas side-effect disclosure
    - negative: no clause claims a flow the code doesn't have
T61 Acceptance run   owns: [scripts/acceptance.ts]   dependsOn: [T22, T41, T43, T47, T53, T54, P17, T31, MT7b]   (T30 if E1)
  check: { argv: ["pnpm","magic:acceptance"], expectExit: 0 }
  accepts:
    - the spec's "Acceptance for the whole", including the sectioned assessment quiz, level bars, the mastery bar, a quiz on chosen topics, and the benchmark table
R3 Pre-release review of T62, T63 and T50b   owns: [research/review-R3.md]   dependsOn: [T62, T63, T50b]
```

## §L The learning tasks: status, rewritten dependencies, amendments (these win over the learning tasks' own lines)

**Superseded:**

| Learning tasks | Replaced by |
|---|---|
| N01 | T11a |
| N02 | T11b |
| N03 | T42 |
| N13 | T22 |
| N18, N19, N26 | T50b |
| N20, N21 | T12 |
| B01, B03, B04 | T05b |
| B06, B09 | T05a |
| B02, B12 | T10, T10L |
| B05 | built; offsets in T11a and T11b |
| B07 | T20b |
| B08 | T43, P17 |
| the measurement plan's MT5 | P18–P21 |

**Dropped** (D20, a study tool, not a game): N16 · P03 · P04 · P06 · P10 · P15. **Restored** after the final review: P05 (quick study sessions) and P14 (calibration and history, without time-on-task totals).

**Kept, with their dependencies:**

| Task | dependsOn | Amendment |
|---|---|---|
| N00 | [] | — |
| N29 | [] | — |
| N27 | [T11a] | — |
| N04 | [N00, N27] | — |
| N05 | [T11a] | concepts live in `learning_concepts`; T21 writes origin-model concepts through N05's validators |
| N06 | [T11a, N04, N05] | N06 validates; T45 generates and calls it |
| N07 | [N00, N05] | the student-facing name for Solid is "Mastered" (spec H4) |
| N08 | [N06] | — |
| N09 | [N06, N07, N08] | — |
| N10 | [N07, N09] | — |
| N11 | [T11a, N05, N06] | the §7.4 interface drops passage and job methods |
| N12 | [T11a] | schemas and validation only; band emphasis is applied at render time (T43) |
| N14 | [T05a] | — |
| N15 | [N06, T22] | exam-faithful by default; "lean toward iffy" uses N10 when it exists |
| N22 | [N06, N07, N11, N29] | — |
| N23 | [N00, N04, N05, N06, N07, N08, N09, N10, N11, N12, N14, N15] | barrels kept modules only |
| N24 | [N11, T10L] | `sql-store.ts` only |
| N25 | [N23, N24, T05b, T12] | takes over T05b's router stub |
| N28 | [T05b, N29] | runs whatever exists, labelling skipped steps |
| B10 | [T05a] | native structured output for the local adapter |
| B11 | [T05b] | — |
| P01 | [N11] | — |
| P02 | [P01, N24, T10L] | `sql-store.ts` only |
| P07 | [N14, N09] | — |
| P08 | [N08, N11] | — |
| P09 | [N15] | — |
| P11 | [P01, T11a, N05, N06] | — |
| P12 | [P01, P13, N05, N06, N12] | — |
| P13 | [P01, T11a, N07, T22] | — |
| P05 | [N10] | study sessions sized to the minutes the student has; no XP |
| P14 | [P01, N07, N11] | calibration and session history only; no time-on-task or productivity totals |
| P16 | [] | scans packages/learning/src, packages/packs and renderer/{notebook,practice,insights}; it also rejects XP, streak and league copy |
| P18 | [N22] | — |
| P19 | [P18, N07] | — |
| P20 | [P18, N14] | — |
| P21 | [P18, N14] | — |

**Planned Codex moment:** a `verify` pass on T21's and T45's schemas and checks, before T61 (plan §7).
