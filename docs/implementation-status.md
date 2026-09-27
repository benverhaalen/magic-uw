# Implementation status

One row per feature: its status, where it is, and the evidence behind it. **Checked against `main` at `ccd21f8` on September 27, 2026**, plus the pushed state of the branches named. How the parts fit together is in [the architecture](architecture.md); measurement methods are in [benchmarks](benchmarks.md). The dated verification log this table replaces, with its full test narratives, is [archived](archive/implementation-log-2026-09-27.md). The desktop frontend's runtime receipts and boundaries are kept in [the desktop handoff](design-handoff.md).

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
| One-checkbox consent and the egress gate | demonstrated | `main` (`packages/core/src/egress.ts`) | 0 requests before the checkbox, in a spy test and the live trial (#6) |
| Enrollment first, current courses only, the "Your courses" step | integrated | `main` (`a62bcb1`, via #51) | 169/169 targeted tests (synthetic); live-shaped classification: 5 this term, 11 other, 11 past hidden, 7 nameless dropped ([status](status-2026-09-27.md)). The Canvas session also working for Course Search & Enroll is not verified live |
| Canvas sync: inventory, bounded concurrent reads | demonstrated | `main` (`apps/desktop/src/ingestion.ts`) | live first read of 6 courses: 125 requests, 65 s (#6); replay 115 → 65 requests, 5.7 → 2.1 s after the scheduler (#8, synthetic replay) |
| Change-driven refresh: baselines across launches, manual refresh probes first, no URL twice | built | PR #53 (`fix/sync-events`) | relaunch 283 → 8 requests (70 → 2.9 s), first sync 126 → 30 s, manual refresh 283 → 56 (synthetic live-shaped account, `evals/perf/sync-account.ts`); one refresh catches all six change kinds tested |
| Canvas file downloads through the session (redirect-safe) | built | PR #53 (`packages/connectors/src/session-fetch.ts`) | root cause proven in real Electron 44.4.5 (live run: 386 of 386 files failed); fix: a 12 MB file byte-exact over local servers (synthetic); 137/137 targeted. Not yet re-run live |
| Course website triage and recipes | integrated (no screen shows the decisions) | `main` (`packages/core/src/site-triage.ts`, #47) | live-shaped, code only: 73 of 77 course-site pairs decided with no fetch or model. Read-once pages aren't read yet (the `open` event isn't sent) |
| Material pipeline: passages, links, course compile, references | demonstrated | `main` (`packages/core/src/graph`, jobs) | live, 6 courses: 1,254 jobs in 12.8 s, 0 failures; 96.4% of 673 materials categorised by code; 100% of 175 body links recovered (#13) |
| One job drain, derivation in budgeted batches | integrated | `main` (`packages/core/src/jobs`) | drain 20.8 s → 0.5 s; longest stall 336 → 49 ms (synthetic) |
| My UW: enrollment, saved DARS, course search, holds | integrated | `main` (`packages/connectors`, `renderer/myuw`) | synthetic adapters and copied-data desktop runs ([planning integration](planning-upgrade.md), [desktop handoff](design-handoff.md)) |
| GPA calculator: by semester, what-if, grades needed | built | PR #53 (`packages/domain/src/gpa.ts`) | 10/10 tests with worked examples |
| Calendar with the enrolled class schedule | integrated | `main` (`renderer/CalendarPage.tsx`, `7b9bdf9`) | 48 focused tests; a copied-data Electron run ([desktop handoff](design-handoff.md)) |
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
| Grounded ask with checked quotes; "not in your materials" | integrated (through the chat pane's read-only intent) | `main` (`packages/core/src/intent/ask.ts`, `renderer/chat`) | tests; answer sentences are not yet bound to their cited quotes (open) |
| Course facts and the course brief as a stable prefix | tested in isolation | `main` (#45) | tests; no screen after the design integration |
| Scoped queries and change cursor (summary, pages, changes) | tested in isolation | `main` (`core.query`) | 30.6 MB snapshot → 17.5 KB summary (MT1, synthetic); the renderer still polls the full snapshot |

## AI

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Client detection on any install layout | integrated | `main` (`packages/runner`, fix/client-detection) | 64/64 targeted; live on Windows with the real clients |
| Instant mode, no tools, env allowlist, stream tripwire | integrated | `main` (`packages/runner/src/process.ts`, `tripwire.ts`) | input tokens 3,021 → 1,298 (Claude Code), 21,424 → 6,373 (Codex) (#29); live on Windows: both instant runs answer, a forced Bash run is stopped |
| Warm pool, byte-stable prefix, content-hash cache | integrated | `main` (`packages/runner`, `packages/packs/core`) | 5.8–7.4 s cold → 1.7–2.2 s warm per call on one laptop; a repeat costs 0 tokens (`tests/packs.test.ts`) |
| AI efficiency: cacheable chat prefix, one ask per session, counts honoured, abbreviated quotes restored by code | built | PR #53 (`fix/ai-efficiency`) | a five-ask burst no longer re-sends the conversation (was 1,607 then 3,891 input tokens); "what changed" and grade what-ifs at 0 tokens |
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
| Course mastery and "Build my strategy" | tested in isolation | `main` (`packages/learning/src/mastery`) | 23 ms median on 5,000 resources (synthetic); no screen after the design integration |
| Practice analytics | tested in isolation | `main` (`packages/learning/src/analytics`) | tests |
| Home "Study & Learn" | integrated | `main` (`renderer/Home.tsx`) | opens the linked saved material ([desktop handoff](design-handoff.md)) |
| Study prep per assessment (`study.prep`, KaTeX) | built | branch `feat/study-prepper` | ~23 ms warm on a 5,000-resource store (synthetic) |
| Item space per work item | built | branch `feat/study-prepper` | code types items with a reason: 40/40 synthetic cases |
| Course Analytics tab | built | branch `feat/course-analytics` | SVG charts over a synthetic term in the sample course |

## Notes, mail and documents

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Lecture-note scaffolds (0 tokens), "fill from slides" | tested in isolation | `main` (`packages/notes`) | `tests/notes-*.test.ts`; no notes page on main |
| Notes sync to Word or Google Docs | integrated (setup in onboarding) | `main` (`packages/notes`, `renderer/onboarding`) | fakes; not run live |
| Notes to a local OneDrive, Google Drive or iCloud folder | built | PR #53 (`feat/notes-local-drive`) | 31/31 tests; never deletes or overwrites the student's edits |
| Document window (notes open in Word or Docs, signed in) | integrated | `main` (`apps/desktop/src/doc-window.ts`, #31) | reviewed; tests pass |
| Outlook and Microsoft 365 through the app's own sign-in | integrated (connect row in onboarding) | `main` (`packages/connectors/src/graph.ts`, `apps/desktop/src/outlook.ts`) | fakes only; never run against Microsoft or UW: it needs a registered client ID ([Outlook setup](outlook-setup.md)) |
| Published Outlook calendar link | integrated | `main` (`renderer/App.tsx`) | synthetic; not tried against a live UW calendar |

## Privacy and consent

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Consent, egress gate, grants, preview, protection, receipts | integrated | `main` (`packages/core/src/privacy`, `egress.ts`) | teaching characters changed 0 of 696,516; personal canaries leaked 0 of 14 (#25, synthetic) |
| Remember my sign-in (opt-in; never touches Duo) | integrated | `main` (`apps/desktop/src/remember-signin.ts`, #40) | 30/30 tests; security review, 9 findings fixed; not run live; fit with the Duo rule is open (H2) |
| Known gaps from code reading | open | `connectors/graph.ts`, `core/site-triage.ts`, Jev triage | outside mail naming a course code labelled course staff; Jev can promote an unknown sender to urgent; a student-posted link can become a synced course site |

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
| Stall audit harness | built | branch `perf/stall-audit` (`evals/perf/stalls.ts`) | full snapshot poll every 2 s: 6.4 MB and 56 ms of worker time per poll; views p99 444 ms while syncing (1,000 synthetic resources) |
| Views reply with results only and paint their last answer | built | branch `wave/backend-0927b` | learning views resolve anchors in one pass |
| Replace the snapshot poll with change-driven updates and per-page slices | proposed | [architecture §12](architecture.md#12-performance-where-the-time-goes) | the backend summary and change cursor exist; the renderer still polls |
| Semester cost model vs a typical AI study tool | built (modelled) | branch `bench/semester-model` | ours $1.91–2.24 per student per semester (modelled, $0 spent); not a measurement |
| Ingestion benchmark vs base Claude Code / Codex | built | branch `bench/base-claude` | zero-cost dry run only; live runs not done |
| Fresh-system end-to-end harness | tested in isolation | `main` (`pnpm test:e2e`) | green on Windows |

## Distribution and accounts

| Feature | Status | Where | Evidence |
|---|---|---|---|
| Desktop app | integrated | `main` (`apps/desktop`) | development build; no signed installer |
| Website (Home, Pricing, About, FAQ, account) | built | `main` (`apps/web`, `vercel.json`) | deployment not claimed here |
| Accounts and payments (email sign-in, Supabase, Lemon Squeezy webhook) | tested in isolation | `main` (`api/lemon-webhook.ts`, `supabase/`) | stand-ins only; not connected to a live store; price is an open team decision ([accounts and payments](accounts-and-payments.md)) |

## Teammates' open pull requests (not reflected above)

`sean/signin-diagnostics` (#54), `sean/page-scope-clock` (#52) and `sean/sync-timeout-fix` (#48) address Canvas downloads, page-scope timeouts, stale sign-in and worker responsiveness during a first sync. Their state is in each PR.
