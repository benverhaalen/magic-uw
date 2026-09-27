# Implementation status

One row per feature: its status, where it is, and the evidence behind it. **Checked against `main` at `53ecbe3` on September 27, 2026**, after wave 2 and tab speed (#53), course analytics (#55), the study prepper (#57), the stall fix (#58), the break-card fixes (#59) Sean's sync fixes (#48, #52, #61), the stale sign-in cleanup (#54) and the desktop task setup. **Known on main at this check:** six failing tests (Today, readiness and seams tests) are being fixed on `fix/main-green`; the intent-latency test is slow on Windows since the per-ask sessions (#53). How the parts fit together is in [the architecture](architecture.md); measurement methods are in [benchmarks](benchmarks.md). The dated verification log this table replaces, with its full test narratives, is [archived](archive/implementation-log-2026-09-27.md). The desktop frontend's runtime receipts and boundaries are kept in [the desktop handoff](design-handoff.md).

**Status** uses the ladder in [AGENTS.md](../AGENTS.md):

| Status | Meaning here |
|---|---|
| researched | evidence gathered; no specification or code |
| proposed | specified in a plan or decision; no code |
| built | code on a branch or an open PR; not on `main` |
| tested in isolation | on `main` with passing tests, but no screen in the running app reaches it |
| integrated | on `main` and reachable from a screen of the running app |
| demonstrated | shown working live; the evidence is named |

**Evidence labels:** *synthetic* = a repo test or harness on synthetic data; *live-shaped* = a read-only copy of a real workspace, numbers only; *live* = the operator's own account, aggregates only; *modelled* = a cost or latency model, not a run. No real course content appears in this repository.

## Access and sync

| Feature | Status | Where | Evidence |
|---|---|---|---|
| UW sign-in in the app's own window; "Keep me signed in" | demonstrated | `main` (`apps/desktop/src/main.ts`) | live, 2026-09-26: sign-in to confirmed in 16.5 s including typing; Duo "Remember me" survived a quit and relaunch (#6) |
| Stale sign-in cleanup: an unfinished sign-in clears only `login.wisc.edu` cookies before the next attempt | integrated | `main` (#54) | 6 tests; tested live on one account on an earlier build, not this exact build |
| One-checkbox consent and the egress gate | demonstrated | `main` (`packages/core/src/egress.ts`) | 0 requests before the checkbox, in a spy test and the live trial (#6) |
| Enrollment first, current courses only, the "Your courses" step | integrated | `main` (`a62bcb1`, via #51) | 169/169 targeted tests (synthetic); live-shaped classification: 5 this term, 11 other, 11 past hidden, 7 nameless dropped ([status](status-2026-09-27.md)). The Canvas session also working for Course Search & Enroll is not verified live |
| Canvas sync: inventory, bounded concurrent reads; page-scope budgets and a responsive worker during a first sync (#48, #52) | demonstrated | `main` (`apps/desktop/src/ingestion.ts`) | live first read of 6 courses: 125 requests, 65 s (#6); replay 115 → 65 requests, 5.7 → 2.1 s after the scheduler (#8, synthetic replay) |
| Change-driven refresh: baselines across launches, manual refresh probes first, no URL twice | integrated | `main` (#53, `apps/desktop/src/ingestion.ts`) | relaunch 283 → 8 requests (70 → 2.9 s), first sync 126 → 30 s, manual refresh 283 → 56 (synthetic live-shaped account, `evals/perf/sync-account.ts`); one refresh catches all six change kinds tested |
| Canvas file downloads through the session (redirect-safe) | integrated | `main` (#53 `packages/connectors/src/session-fetch.ts`; #61 CDN host in `network.ts`) | root cause proven in real Electron 44.4.5 (live run: 386 of 386 files failed); fix: a 12 MB file byte-exact over local servers (synthetic). A later live refresh got all 98 files past the first redirect and stopped at Instructure's file CDN, now allowed (#61). A complete live download run after #61 is not recorded here |
| Course website triage and recipes | integrated (no screen shows the decisions) | `main` (`packages/core/src/site-triage.ts`, #47) | live-shaped, code only: 73 of 77 course-site pairs decided with no fetch or model. Read-once pages aren't read yet (the `open` event isn't sent) |
| Material pipeline: passages, links, course compile, references | demonstrated | `main` (`packages/core/src/graph`, jobs) | live, 6 courses: 1,254 jobs in 12.8 s, 0 failures; 96.4% of 673 materials categorised by code; 100% of 175 body links recovered (#13) |
| One job drain, derivation in budgeted batches | integrated | `main` (`packages/core/src/jobs`) | drain 20.8 s → 0.5 s; longest stall 336 → 49 ms (synthetic) |
| My UW: enrollment, saved DARS, course search, holds | integrated | `main` (`packages/connectors`, `renderer/myuw`) | synthetic adapters and copied-data desktop runs ([planning integration](planning-upgrade.md), [desktop handoff](design-handoff.md)) |
| GPA calculator: by semester, what-if, grades needed | tested in isolation | `main` (#53, `packages/domain/src/gpa.ts`) | 10/10 tests with worked examples; the panel is not yet mounted in the My UW page |
| Calendar with the enrolled class schedule | integrated | `main` (`renderer/CalendarPage.tsx`, `7b9bdf9`) | 48 focused tests; a copied-data Electron run ([desktop handoff](design-handoff.md)) |
| Task setup and owned browser windows | integrated | `main` (Ben's desktop integration) | copied-data setup, save and reload; real split windows are a user trial ([desktop handoff](design-handoff.md)) |
| Daily Brief on Home (current enrollment first; date-conflict notices temporarily hidden) | integrated | `main` (`renderer/home/DailyBrief.tsx`, `53ecbe3`) | 23 focused tests; copied-profile native QA, seven checks ([desktop handoff](design-handoff.md)); known open: the Today count and some course and category bugs ([frontend data bugs](frontend-data-bugs.md)) |
| Today rail and Home | integrated | `main` (`renderer/Home.tsx`, `TodayRail.tsx`) | [desktop handoff](design-handoff.md); rail duplicates 12 → 3 due-today rows on a read-only real workspace ([log](archive/implementation-log-2026-09-27.md#verification)) |
| Critical-action agenda (least slack first) | tested in isolation | `main` (#27) | reviewed; tests pass. Its Workspace tools preview is no longer mounted after the design integration |
| Notifications from stored changes | integrated | `main` (#32, #33, `renderer/notifications`) | synthetic captures; Jev sorting only where Jev is configured |
| Calendar feeds and UW GitLab | integrated | `main` (`packages/connectors`) | synthetic feeds; real UW feeds and GitLab not validated |
| Documents: PDF, Office, HTML; local OCR | integrated | `main` (`packages/connectors`) | one real-scan OCR run in 2–3 s (2026-09-26); 0/300 → 285/300 files with text on a synthetic course (#22) |

## Storage and retrieval

| Feature | Status | Where | Evidence |
|---|---|---|---|
| One SQLite file, WAL, schema v14, migrations with backup | integrated | `main` (`packages/storage`) | v5 → v7 with backup in 1.60 s, 0 rows lost (MT1, synthetic); purge ≈0.35 s at 5,000 resources |
| Encryption at rest for sensitive fields (v14) | integrated | `main` (#25) | privacy PR tests |
| Passages with offsets and contentless FTS search | integrated | `main` (`packages/retrieval`, `packages/storage`) | search p50/p95 56/197 → 3.3/4.8 ms at 5,000; recall@5 0 → 1.00 on 52 builder-written questions (MT1, synthetic) |
| Grounded ask with checked quotes and sentences; "not in your materials" | integrated (through the chat pane's read-only intent) | `main` (`packages/core/src/intent/ask.ts`, `renderer/chat`) | since #59 every date, weekday, number and name in a sentence must appear in its checked quotes: wrong-claim rate 60/60 → 0/60, false rejects 0/60 (synthetic, fake model; [break card](break-card.md)) |
| Course facts and the course brief as a stable prefix | tested in isolation | `main` (#45) | tests; no screen after the design integration |
| Scoped queries and change cursor (summary, pages, changes) | tested in isolation | `main` (`core.query`) | 30.6 MB snapshot → 17.5 KB summary (MT1, synthetic); the renderer still polls the full snapshot |
| Retrieval upgrade: local semantic candidates, timed captions, citation repair | proposed (private baseline and candidates, not integrated) | [desktop handoff](design-handoff.md#2026-09-27-1131-utc--retrieval-baseline-and-shared-ownership) | no before/after quality result yet; lexical baseline first ([course intelligence](course-intelligence.md)) |

## AI

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Client detection on any install layout | integrated | `main` (`packages/runner`, fix/client-detection) | 64/64 targeted; live on Windows with the real clients |
| Instant mode, no tools, env allowlist, stream tripwire | integrated | `main` (`packages/runner/src/process.ts`, `tripwire.ts`) | input tokens 3,021 → 1,298 (Claude Code), 21,424 → 6,373 (Codex) (#29); live on Windows: both instant runs answer, a forced Bash run is stopped |
| Warm pool, byte-stable prefix, content-hash cache | integrated | `main` (`packages/runner`, `packages/packs/core`) | 5.8–7.4 s cold → 1.7–2.2 s warm per call on one laptop; a repeat costs 0 tokens (`tests/packs.test.ts`) |
| AI efficiency: cacheable chat prefix, one ask per session, counts honoured, abbreviated quotes restored by code | integrated | `main` (#53) | a five-ask burst no longer re-sends the conversation (was 1,607 then 3,891 input tokens); "what changed" and grade what-ifs at 0 tokens |
| Intent router: code path first | integrated (chat reads only: ask, agenda, search) | `main` (`packages/core/src/intent`, `renderer/chat/intent.ts`) | fallback adds a 4.2 ms paired median (synthetic); 25 of 40 real commands on the code path, all correct (live-shaped, #24). No Ctrl+K binding on main |
| Jev: typed judgments, code first | integrated | `main` (`packages/ai`, `apps/desktop/src/embedded-jev.ts`) | 100 → 50 Jev calls on a synthetic 100-assignment course (#14). Accuracy not measured |
| Embedded Jev key (temporary) | integrated | `main` (#39, build-time `MAGIC_EMBED_TYPESAFE_KEY`) | accepted risk recorded in [decisions](decisions.md#2026-09-27--embedded-jev-key-temporary) |
| Hosted Jev gateway | tested in isolation | `main` (`apps/gateway`) | not deployed |
| Local tutor (Ollama) | integrated | `main` (`packages/ai/src/local.ts`, `LocalAiPanel`) | one real-model run, ~2.2 s (2026-09-26) |
| Local voice navigation (Whisper) | integrated | `main` (`renderer/voice`) | synthesized-audio transcription and copied-data checks; real human microphone use not demonstrated ([desktop handoff](design-handoff.md)) |

## Study

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Quiz, flashcard and study-guide generation (one checked call) | integrated | `main` (`packages/packs`, `packages/core/src/pack-handler.ts`, `LearningPanel`) | tests; a generation run on real course content is not recorded |
| Item-quality evaluation harness | tested in isolation | `main` (`evals`, `pnpm eval:items`, #43) | reviewed; tests pass |
| FSRS cards, Learn rounds, sectioned quizzes, topic states | integrated | `main` (`packages/learning`, `LearningPanel`) | tests; 0 model tokens by construction (no runner dependency) |
| Exam prep: blueprint, practice exam builder, step-checked solving | tested in isolation | `main` (#44) | tests; no screen after the design integration |
| Course mastery and "Build my strategy" | integrated (through the Analytics tab) | `main` (`packages/learning/src/mastery`) | 23 ms median on 5,000 resources (synthetic) |
| Practice analytics | integrated (through the Analytics tab) | `main` (`packages/learning/src/analytics`) | tests |
| Study & Learn page and the Home study card | integrated | `main` (#57, `renderer/study-prep/StudyLearn.tsx`) | every assignment, quiz and exam across current courses with readiness and cards due; paint gated under 100 ms (list) and 150 ms (item space), report-only on CI |
| Study prep per assessment (`study.prep`, KaTeX) | integrated (generation and Ask held; see evidence) | `main` (#57, `packages/core/src/study-prep`) | ~23 ms warm on a 5,000-resource store (synthetic); a generation run on real course content is not recorded. Held on `main` since `a719430`: the renderer returns "unavailable" for new Study generation and Ask, with no producing call, until exact-account, source-version and effective-policy enforcement is connected ([desktop handoff](design-handoff.md)); browsing materials still works |
| Item space per work item (11 types) | integrated | `main` (#57, `renderer/study-prep/ItemSpace.tsx`) | code types items with a reason: 40/40 synthetic cases; practice problems and exams with recomputed answers (tests) |
| Course Analytics tab | integrated | `main` (#55, `renderer/analytics`) | 10/10 tests; paints in ~8–10 ms median; three batched learning calls whatever the course size; a synthetic term in the sample course |

## Notes, mail and documents

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Lecture-note scaffolds (0 tokens), "fill from slides" | tested in isolation | `main` (`packages/notes`) | `tests/notes-*.test.ts`; no notes page on main |
| Notes sync to Word or Google Docs | integrated (setup in onboarding) | `main` (`packages/notes`, `renderer/onboarding`) | fakes; not run live |
| Notes to a local OneDrive, Google Drive or iCloud folder | tested in isolation | `main` (#53, `packages/notes`) | 31/31 tests; never deletes or overwrites the student's edits |
| Document window (notes open in Word or Docs, signed in) | integrated | `main` (`apps/desktop/src/doc-window.ts`, #31) | reviewed; tests pass |
| Outlook and Microsoft 365 through the app's own sign-in | integrated (connect row in onboarding) | `main` (`packages/connectors/src/graph.ts`, `apps/desktop/src/outlook.ts`) | fakes only; never run against Microsoft or UW: it needs a registered client ID ([Outlook setup](outlook-setup.md)) |
| Published Outlook calendar link | integrated | `main` (`renderer/App.tsx`) | synthetic; not tried against a live UW calendar |

## Privacy and consent

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Consent, egress gate, grants, preview, protection, receipts | integrated | `main` (`packages/core/src/privacy`, `egress.ts`) | teaching characters changed 0 of 696,516; personal canaries leaked 0 of 14 (#25, synthetic) |
| Remember my sign-in (opt-in; never touches Duo) | integrated | `main` (`apps/desktop/src/remember-signin.ts`, #40) | 30/30 tests; security review, 9 findings fixed; not run live; fit with the Duo rule is open (H2) |
| Checks that confirmed evidence but not the claim (B2–B4) | integrated (fixed, #59) | `packages/domain/src/notifications.ts`, `packages/core/src/site-triage.ts` | course-code mail no longer labelled course staff; a Jev raise moves one level, at most important for non-staff; a discussion-only link is link only. 60/60 → 0/60 each (synthetic, Wilson 95% [0, 6.0]); staff and course-content recall 60/60 ([break card](break-card.md)) |

## The open agent layer

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Read-only MCP course bank (six tools) | integrated | `main` (`apps/desktop/src/mcp-server.ts`, `packages/core/src/mcp.ts`, Data & AI) | search p50 6.3 s → ≈0.28 s at 5,000 (synthetic); grant and privacy rechecked per call |
| Agent API v1 (`@magic/agent-api`) | tested in isolation | `main` (`packages/agent-api`) | `tests/fix-platform-agent-api.test.ts` |
| Versioned SQL views, `@magic/sdk`, student-artifact write path | proposed | plan D42 | [plan](plans/2026-09-26-course-backend/plan.md) |

## Performance

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Repeat-work sweep with CI statement caps | integrated | `main` (`pnpm test:budgets`) | course summary 83,499 → 16 statements (2.7 s → 68 ms); learning views ~226k → ~810 (live-shaped, byte-identical outputs) |
| Stall audit harness | tested in isolation | `main` (#58, `evals/perf/stalls.ts`) | runs the real worker headless; per-action cost, idle timers, view latency while syncing and draining |
| Tab speed: one-pass anchor resolution, result-only replies, last answer painted first | integrated | `main` (#53) | learning views about 4.7 s → about 265 ms on a live-shaped copy (2,577 resources, 50 anchors) |
| Change-driven snapshot refresh | integrated | `main` (#58, `tests/stall-guards.test.ts`) | idle 10 s: 4 snapshot reads, 189 statements, 6.8 MB each → 0 reads, 10 statements (synthetic, 1,000 resources). Per-page slices through the summary and change cursor remain proposed |
| Semester cost model vs a typical AI study tool | built (modelled) | branch `bench/semester-model` | ours $1.91–2.24 per student per semester (modelled, $0 spent); not a measurement |
| Ingestion benchmark vs base Claude Code / Codex | built | branch `bench/base-claude` | zero-cost dry run only; live runs not done |
| Fresh-system end-to-end harness | tested in isolation | `main` (`pnpm test:e2e`) | green on Windows |

## Distribution and accounts

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Desktop app | integrated | `main` (`apps/desktop`) | development build; no signed installer |
| Website (Home, Pricing, About, FAQ, account) | built | `main` (`apps/web`, `vercel.json`) | deployment not claimed here |
| Accounts and payments (email sign-in, Supabase, Lemon Squeezy webhook) | tested in isolation | `main` (`api/lemon-webhook.ts`, `supabase/`) | stand-ins only; not connected to a live store; price decided as $5 a month; the site still shows $10 one-time ([accounts and payments](accounts-and-payments.md)) |

## Open pull requests (not reflected above)

#56 (the website: every current feature), #60 (the launch film pipeline) and #62 (Data & AI redesign). Their state is in each PR.
