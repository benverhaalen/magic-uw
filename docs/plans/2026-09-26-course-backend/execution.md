# Execution playbook: how the course-backend build runs

**Status: Final for 2026-09-26.** It runs [tasks.md](tasks.md) (revision 8) under [spec.md](spec.md) v7 and [plan.md](plan.md) D1–D30.

**Its purpose:** the orchestrator works **piece by piece** (P0–P14, below): it reviews each architectural piece against the current code, starting with sign-in, before building it. The work is also split into **units**. Each unit is a delegatable, multi-agent run with a research pass that validates its decisions first, then a parallel implementation fleet, then review, then real trials and measurement.

## The loop every unit follows

1. **Research pass (validate before building).** Retriever agents check the unit's open facts, each against its source: docs, repos, page bytes or a live probe. Each fact is labelled `sourced`, `inferred` or `not-found`. The lead updates the spec, plan or task lines only where a finding changes them, then re-runs `node docs/plans/2026-09-26-course-backend/check-tasks.mjs`.
2. **Decide.** Findings that change an interface, the AI boundary (spec §2) or a public claim go to the operator. Everything else, the lead decides and records in the plan.
3. **Plan the run.** The lead writes `plan.json` for the unit's tasks, following the `/plan-run` carrier contract (the global plan skill's `references/plan-json.md`):
   - **ids:** the task IDs
   - **owns, dependsOn and check** from the task line
   - **accepts:** in the brief
   - **isolation:** `worktree` for parallel writers
4. **The fleet runs** the unit's graph with `/plan-run`: topological order, one lock per owned path, a failed task blocking its dependents. The seats:
   - **the `feature-implementer` agent** for most tasks, with the `feature-slice` and `eval` skills preloaded
   - **`implementer-deep`** where the task line says the design must be worked out
   - **`executor`** for fully specified tasks
5. **Verify.** The carrier runs each check, and the writer never grades its own work. The reviewer tasks named in the unit read the diff and the brief:
   - **R1 and R2:** the unit's review tasks
   - **`grounding-reviewer`:** retrieval and citations
   - **`integrity-auditor`:** anything that generates study content
   - **`learning-reviewer`:** items, cards and the mastery logic
6. **Integrate** each accepted worktree into the unit branch, run `pnpm check && pnpm test`, then `check-tasks.mjs`.
7. **Real trials and measurement** (operator present where marked). These use the real app, the real UW sign-in and the student's real AI, following the local `live-trial` procedure. Numbers go to `.data/`, never into git; only aggregates go into docs.
8. **Record.** The unit's outcome, measurements and decisions go to the plan (decisions) and to the handoff (state). Commits are ordinary `docs:`, `feat:`, `fix:` and `test:` commits. **Nothing is pushed until gate G0 clears, and every push is asked.**

**Standing rules** (from `AGENTS.md`, `CLAUDE.local.md` and the spec):
- Never automate Duo, never store the NetID password except by the student's opt-in "Remember my sign-in" (D39), and never start a Canvas quiz attempt.
- Never read AI-CLI credential files, and never use `--dangerously-skip-permissions` or `--bare` on a subscription.
- No real course, mail or message content in the repo. No Jev figures in public files.
- One writer per path. Shared-file blocks are taken over only as each task line names them.

## The units

**Reading the table:**
- **Research pass:** the facts checked before the fleet starts.
- **Fleet:** the tasks, with the parallel lanes separated by "∥".
- **Live and measured:** the real trial.
- **Exit:** the condition that ends the unit.

| Unit | Research pass | Fleet | Live and measured | Exit |
|---|---|---|---|---|
| **U0: gates and seams** | Node 24 `node:sqlite`: `VACUUM INTO` and FTS5 external content in the bundled SQLite; Electron 44 `safeStorage` and `utilityProcess` behaviour on Windows and macOS; the `hostedProvider` enum and consent copy against `docs/ai-and-privacy.md` | T02 (**the operator signs off spec §2**) ∥ T05a → T05b ∥ T06 | none | T05a gives 255/255 on Windows (the suite at `9302865`, plus the harness tests); the AI boundary is signed off; the consent gate passes its spy test |
| **U1: live probes** (the operator present) | UW Graph consent (KB and Entra docs); Canvas quiz-question visibility for students; Canvas GraphQL at canvas.wisc.edu; Course Search & Enroll endpoints today | T00 (E1, K1, MD1, S1, RP1–RP3) ∥ T01 | **the real UW sign-in and sync of the operator's courses; the Graph consent attempt; a Kaltura caption read; `claude`, `codex` and `gemini` model probes (no course data sent)** | `research/probes-*.md` has a verdict for every probe; decisions updated (T30 or T35; captions on or off) |
| **U2: store and passages** | FTS5 tokenizer choice for course text; the passage size default; migration and backup on Windows file locks | T10 → (T10L ∥ T11a → T11b) ∥ T20 | a real sync into v5 and v6 (planning data preserved); passages built from the operator's files, with counts only | R1 passed; purge leaves zero rows on the real database copy |
| **U3: every source** | the Graph delta and MSAL public-client flow in Electron; the Outlook ICS publish flow; today.wisc.edu and RSS formats; Kaltura LTI embed patterns from U1 | T34 → (T30 or T35) ∥ T31 ∥ T36 ∥ T32 ∥ T33 ∥ T37 ∥ T50a | **the real Outlook sync (gist and link only), feeds, Kaltura links and captions, and Course Search, each on the operator's account; freshness timed with a new Canvas item** | each connector has a real read on record; nothing stored beyond gist and link for mail |
| **U4: measured backend** | the baseline metric definitions in the backend optimization plan §1; the benchmark protocol for hand-timing public tools | MT1 → (T15 ∥ T14 ∥ T16 ∥ T17) ∥ MT2 → MT7a | **MT1 baseline and after on real data; the live Canvas concurrency, GraphQL and ETag runs (M1, M8, M9); MT7a's hand-timed comparisons of setup and ingest against NotebookLM and others** | before-and-after table; each M-item adopted or killed at its threshold; MT7a rows published, including the ones we lose |
| **U5: model runtime and packs** | the current `claude -p --json-schema` and `codex exec --output-schema` behaviour on the operator's plans (U1 MD1); prompt-caching rules for stable prefixes; background budget defaults | T12 → T13 ∥ T40; engines N00, N27, N04, N05, N06, N11, N24, N14, N12, N15 | **real one-call pack runs on the student's AI after the consent checkbox; ledger rows checked; an interrupted run pauses cleanly at a usage limit** | R2 passed (the runner and packs part); the ledger shows tokens per action |
| **U6: course map and generation** | the Pyodide and QuickJS licences and Electron sandbox behaviour; the Jev endpoints available today (T20b pending); the course-pass schema reviewed by a second model family (the planned Codex `verify` moment) | T21 → T22 → (T57 → T58 ∥ T64) → (T45 → T53 ∥ T46) ∥ T41 ∥ T44 ∥ T42 ∥ T48 ∥ T52 | **a real course pass on the operator's courses (the student confirms scopes); a real sectioned assessment quiz; real flashcards and a guide; MB1–MB3; MT3, MT4 and MT6; MT7b against NotebookLM and the same-model baselines** | the course map confirmed on real courses; tokens per quiz and guide measured against the baselines; the MT7b table |
| **U7: study system** | the knowledge-model configuration against the learning spec §5; the P16 copy-lint patterns (no XP, streak or percentage copy) | N07 → N08 → N09 → N10; P01 → P02; P05, P07–P09, P11–P14, P16; T54 ∥ T47; T59; T43 ∥ P17 | **the operator studies a real assessment quiz: level bars and the mastery bar move per answer; quiz me on two chosen topics; notes created in the local folder, and in a detected sync folder if present** | the P17 journey passes; `learning-reviewer` and `integrity-auditor` pass a sample |
| **U8: validation** | dataset licences (pyKT, HLR, srs-benchmark) | N22 → P18 → (P19 ∥ P20 ∥ P21); MB4 | offline: knowledge model vs pyKT baselines; decay vs HLR | thresholds labelled validated or still unvalidated, with numbers in `.data/` |
| **U9: platform and release** | payment provider terms (the operator's choice); signing requirements; the relay's OAuth details (RP1–RP3 from U1) | T50b ∥ T55 ∥ T38 ∥ T56 ∥ T62 ∥ T63; T20b and T51 (the deploys need the operator's say) | a signed build installs on a clean machine; the licence activates; the course bank is answered from Claude Code | R3 passed |
| **U10: close** | legal research: consumer terms, FERPA framing, provider terms, the Jev agreement | T60 → T61 | **the acceptance run on the operator's account** | the spec's "Acceptance for the whole" passes |

**Parallelism:**
- U2 and U3 can overlap once T10 lands.
- U5 can start as soon as U0 is done (T12 needs only T05a).
- U7's pure engines (N07–N10) may start on spare capacity while earlier units are all claimed (D23).

**The 2026-09-27 11:00 CT submission:** at about 09:30 CT the lead freezes a demo branch and runs N28 on whatever exists. It records MT1 or MT7a numbers if they're ready. The operator then records the video and submits. This lane also coordinates the team's release cleanup (gate G0) before any push.

## Piece by piece: review, then build (the order the orchestrator follows)

The architecture is being updated, not written from scratch. Each **piece** is reviewed against the current code before anything is built, starting with sign-in. A piece groups the tasks of one architectural concern. The units above stay as the grouping for fleets and trials.

**Each piece follows this loop:**
1. **Read.** The current code for the piece, and its spec and plan sections.
2. **Research pass.** Retrievers validate the piece's open facts against sources, docs, repos and live probes, each labelled `sourced`, `inferred` or `not-found`. One Opus synthesis reads the code together with the findings.
3. **Piece review, shown to the operator in one message:**
   - **Today:** what exists, cited to files and lines
   - **Target:** the spec section
   - **Delta:** the changes
   - **Risks**
   - **The optimized patterns this piece applies,** with their evidence
   - **Measurement:** how it will be measured, with the threshold fixed now
   - **Decisions needed:** each with a recommendation

   Building starts on the operator's go. While the review waits, independent work from earlier pieces continues (D23).
4. **Build.** The piece's tasks go into `plan.json` and run as a `/plan-run` fleet in worktrees, with reviewers.
5. **Integrate and check:** `pnpm check`, `pnpm test`, the tasks' own tests, and `check-tasks.mjs`.
6. **Live trial and measurement.** Against the previous numbers, with the operator present where the trial touches their accounts.
7. **Record.** Decisions go in the plan; state goes in the handoff. Then on to the next piece.

**Legend for the table:**
- **Optimized patterns:** what the piece applies.
- **Measured by:** its live trial and measurement.

| # | Piece | Tasks | Optimized patterns | Measured by |
|---|---|---|---|---|
| P0 | Test harness and workspace | T05a | per-task test files; Windows-safe suite | 255/255 on Windows at `9302865`, plus the harness tests |
| P1 | **Sign-in, session and consent** | the review (`research/piece-P1/synthesis.md`); T05d (the P1 slice of T05b); T05c session state, expiry and "Keep me signed in"; T06 one-checkbox consent and the Canvas disclosure | no stored password; quitting signs out; "Keep me signed in" (tray, start at login, the sign-in window opens by itself); no request sent to keep a session alive, and signed-in background reads only while the student is present; one "Sign in again", confirmed by a profile read; consent enforced in `maySend` | the review's thresholds: launch to setup ≤3 s; back from sign-in to confirmed ≤3 s p95; first assignment ≤30 s; relaunch to "Sign in again" ≤2 s with 0 requests; 0 false "Sign in again"; 0 requests before the checkbox; 0 Jev or AI requests in local mode; the session lifetime and Duo's 7-day remember recorded with the operator |
| P2 | **The local database** | MT1 baseline → T10 (v5 after planning's v4, job subjects, backup), T10L (v6 learning tables), T14 (statement cache, WAL NORMAL, text_hash, external-content FTS, mmap/cache) | one file, one writer, a complete purge, backup before migrating; each optimization kept only at its threshold | MT1 ingest throughput, query p50/p95 and database size, before and after, on a real sync |
| P3 | **Canvas sync and freshness** | review of the existing connector and refresh; the course space inventory and targeted reads (D32; its tasks are set in the P3 review); T34, T33 (per-course warm reads), T17 (concurrency, GraphQL, ETag), T15 (scoped queries instead of snapshots) | every space inventoried by code, a model recipe once per unfamiliar layout; only changed courses re-read; request cost per sync minimized; small scoped IPC payloads | inventory recall against a hand-labelled list of the operator's course spaces; real sync and zero-change re-sync request counts; freshness of a new item (≤5 min); command payload bytes |
| P4 | **Extraction and passages** | T11a, T11b, T16 (extraction cache), T32 (Kaltura links and captions) | exact offsets; never re-extract unchanged files; captions as timestamped passages | passage exactness on real files; extraction time on unchanged vs changed files |
| P5 | **Jobs, Jev and organizing** | T20 (batched item cards, code-first rules, structure-only fallback); T20b (versioned endpoints and limits, as a PR; deploy on the operator's say) | code first; one Jev request per item; cached by hash; soonest-exam priority | Jev calls per course sync (internal); the share classified by code alone |
| P6 | **The other sources** | T01, T30 or T35, T36, T31 (Course Search & Enroll and My UW come from the planning integration on main) | the Graph delta; a gist and link only; public feeds only | real Outlook, feed and Course Search reads; bytes stored per message |
| P7 | **The typed academic API** | T50a | one handler layer, token caps, grant rechecks, receipts | handler latency; caps held on real data |
| P8 | **The backend benchmark** | MT2, MT7a | targets fixed in spec B6 before running | MT7a rows against NotebookLM and others, lost rows included |
| P9 | **Model runtime and packs** | T12, T13, T40, and the engines N00, N27, N04, N05, N06, N11, N24, N14, N12, N15 | one call, tools off, a stable prefix, cache, ledger, background budget | ledger rows on real runs; the cache-hit rate |
| P10 | **The course pass and mapping** | T21, T22 | code-first scope patterns; one pass per course; checks with retry, then escalation | scopes confirmed on the operator's courses; the edit count; tokens per course |
| P11 | **Generation** | T57, T58, T64, T45, T53, T41, T44, T46, T42, T48, T52, MB1–MB3, MT3, MT4, MT6, MT7b | analyzers, planner, verifiers, reuse before generation | valid items per 1,000 tokens; tokens per quiz and guide against the same-model baselines; MT7b |
| P12 | **The study system** | N07–N10, P01, P02, P05, P07–P09, P11–P14, P16, T54, T47, T59, T43, P17, N22, P18–P21, MB4 | zero tokens at study time; evidence-defined levels | the operator studies a real assessment quiz; the bars move per answer; validation results |
| P13 | **Platform and secondary** | T50b, T55, T51, T38, T56, T62, T63 | the course bank never drives the app; signed releases | a signed install on a clean machine; the course bank answered from Claude Code |
| P14 | **Close** | T60, T61 | legal wording matches the enforced flows | the acceptance run |

**The submission window:** at about 09:30 CT, freeze a demo branch and run N28 on whatever exists. The operator records the video and submits. Then the next piece continues.

## Where results live

| What | Where | Committed? |
|---|---|---|
| probe verdicts, reviews, live-trial notes | `research/` (local) | no |
| measurements (perf, bench, h2h raw) | `.data/perf/`, `.data/bench/` | no |
| published results (aggregates, including lost rows) | `docs/notes/benchmark-results.md` (MT7b) | yes |
| decisions | [plan.md](plan.md) | yes |
| state for the next session | `research/HANDOFF-*.md` | no |

## Build mode from 2026-09-26, about 22:00 CT (the operator's direction)

**The piece-by-piece review gate is lifted for tasks already specified.** The build now runs as a few long-lived **lanes**. Each lane is one Opus 5.5 builder that owns a coherent part of the system and works through its tasks in order, grounded in the research files. Every task gets its own commit, so the lead can integrate as work lands.

**Wave A (running):**

| Lane | Tasks, in order | Grounding |
|---|---|---|
| **Data layer** | T11a → T10 (v6 after `main`'s v5) → T10L (v7) → T11b → T14 plus the ingest bottleneck | the P2 review and measurements |
| **AI runtime** | T12 → D38 session pool → T40 → T13 | the architecture review §4, §7, §10; the provider terms |
| **Seams and sync** | T05b → D32 inventory → D37/T33 freshness → T15 | the P3 briefs; review F1 and F7 |
| **Learning engines** | N00, N11, N14, N29, P16, P01 → N05, N12, N06–N10 → P-tasks | the learning spec plus §L |

**Wave B** starts once wave A's first integration lands:
- **Course understanding and generation:** T20, T21, T22, T57, T58, T64, T45, T41 and T44.
- **Workspace UI:** T43, P17, the command bar, link cards and the activity line (D40), following `DESIGN.md`.

**Evaluation runs alongside:**
- MT1 before and after, per data change
- the P1 live trial with the operator
- the eval harness on synthetic and OCW cases
- N28's scripted demo, at the 09:30 freeze
