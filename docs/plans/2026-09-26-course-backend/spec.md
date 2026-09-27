# Spec: connect everything, map it right, build the notebook on top

**Status: Specification v8, reconciled with `main` at `8e3cf98` (2026-09-26 late).**
- **Storage:** `main` uses schema 4 (planning) and 5 (course intelligence), so our migrations are **v6 and v7**.
- **Already on `main`:** My UW and planning (holds, appointments, enrollment windows, DARS, degree plan, Course Search & Enroll public reads) are built by the planning workstream; this spec reuses them. So are the course-intelligence compiler (schema 5) and the Today rail's `dayPlan`.
- **The team's work on `integration/backend-features`, pending merge,** which this spec reuses rather than rebuilds: deadline claims extracted from course prose with a literal span per claim and a tiered resolver; fuzzy supporting-material candidates proposed after each sync; a known-identity scrubber for hosted payloads plus citation-span validation (`validate-citations`); a Madgrades adapter; a judgment queue that pauses on gateway budget refusals.
- **Consent:** it follows the accepted flow in `docs/decisions.md` and `docs/ai-and-privacy.md`.
- **Open human calls** are marked `(open: H<n>)` and listed in [plan §9](plan.md#9-open-human-calls). The operator's decision stays stated as the operator's until the call is settled.

**v8** (the operator, 2026-09-26 late) makes this the spec for the whole product, not only the backend: "It needs to be fully fledged, to be able to replicate note book lms abilities to understand info and generate artifacts, quizlets quiz and notecard tracking analytics, all unified, empowering an integrated and connected course schedule, skills and tools harnessed to the users client configured by our system, all made to out perform." It adds:
- the capability map against NotebookLM, Quizlet, Knowt and Anki (§1c)
- study analytics (H7), the unified course schedule (D8), the command bar's dictation (D9)
- one section for the student's client configuration (E6)
- the open academic data platform (F3), Outlook with compressed summaries (A3), and retrieval over compressed summaries (B7)

**v7:** v7 settles four things:
- **consent:** one checkbox
- **pricing:** free with the student's own keys (open: H1, see plan §9)
- **the benchmark:** NotebookLM first
- **generation:** assisted by code, plus the integrated notes system

**v6:** v6 adds **§2, the AI boundary**, decided before building, and applies the final review: a consent gate from phase 1, the Canvas side-effect disclosure, a mastery bar that moves with each answer, and fair benchmark targets. v5 added the benchmark, the innovation claims, the open framework, licensing and distribution. **Earlier: v4.** v3 added Part H and dropped the deferred phases. v4 makes Part H a study tool (no game mechanics), adds assessment quizzes and the mastery bar, and **orders the build backend first**. Written 2026-09-26 against `27782e9`, plus `main` docs through `2df5a9c`.
**Supersedes** where they differ:
- [agent data-layer proposal](../2026-09-26-agent-data-layer/proposal.md)
- [sync and actions design](../2026-09-26-sync-and-actions/design.md)
- [accuracy](../2026-09-26-sync-and-actions/accuracy.md)
- [course compile](../2026-09-26-sync-and-actions/course-compile.md)

**Learning mechanics** (FSRS, the knowledge model, practice rules) are specified in detail in [notebook and study tracking](../2026-09-26-notebook-and-study-tracking/spec.md) and [practice and insights](../2026-09-26-notebook-and-study-tracking/practice-and-insights.md). **Part H adopts the study parts of them into this build, with no deferred phase.** The game mechanics are dropped (Part H).

**Where the two task lists overlap, this spec's task and path win.** The losing N-tasks are superseded:

| Notebook-and-study-tracking task | Replaced by | Path that wins |
|---|---|---|
| N01 passages and quote validator | T11 (passages), T13 (checks) | `packages/retrieval`, `packages/packs` |
| N02 retrieval | T11 | `packages/retrieval` |
| N03 grounded answers | T42 | `packages/core/src/chat.ts` |
| N13 exam coverage | T21, T22 | `packages/packs/course-pass`, `packages/core/src/map.ts` |
| N18 Magic tools handlers | T50 | `packages/agent-api` |
| N20 agent runtime | T12 | `packages/runner` |
| N24 SQL LearningStore migrations | T10L (tables); N24 keeps `sql-store.ts` | `packages/storage`. **The storage package is the only owner of `user_version`** |
| N26 MCP bridge | T50 | `apps/desktop/src/reader.ts` |

N14 (FSRS scheduling) stays with the learning spec, and T41 depends on it. This spec supplies the data, the mapping and the notebook they run in. The build is in [plan.md](plan.md) and [tasks.md](tasks.md).

## 1. Outcome and priority

**The outcome:** a student signs in once. Every source of their academic life is collected by code and stored on their machine. Each course becomes a notebook that is already organised:
- every assignment carries its relevant sources
- every assessment carries its reference and study material
- every module is laid out by session

It stays current as professors post. Every AI feature is a written prompt pack that runs in one checked call on the student's own AI. It's shaped by NotebookLM and Open Notebook, and positioned to beat both.

**Priority, in this order:**

| Part | What | Status |
|---|---|---|
| A | Connect and collect | primary |
| B | Store | primary |
| C | Understand and map | primary |
| D | The notebook in the app, the unified course schedule (D8), the command bar and its dictation (D9) | primary; dictation after the core study features |
| E | AI execution, on the student's own client configured by the app (E6) | primary |
| F | The optional MCP course bank, remote access, and the open academic data platform (F3) | **secondary, never drives the app** |
| H | The study system: Quizlet-like practice, per-topic understanding, mastery by assessment, "quiz me on…", study analytics (H7) | primary |
| I | Licence, payment, signed installers, accessibility | needed for the complete app |
| G | Privacy and legal | cross-cutting |

**Why this is infrastructure, not a script** (each claim is proven by B6's benchmark, and published only when it's measured):
1. **One authenticated, system-driven academic layer:**
   - **Sources:** Canvas, the calendar feeds, Outlook (gist and link), Kaltura, external course sites, GitLab, Course Search & Enroll and campus feeds.
   - **Access:** collected by code through the student's own persistent UW sign-in, with no uploads.
   - **Freshness:** kept current incrementally.
2. **A verified course graph:**
   - assessments → their stated scope → chapters, modules and materials → topics, with **every quote, ID and date checked by code**
   - built by code, then Jev, then **one** catered model pass per course
3. **A cost cascade with a ledger, and generation that code assists:**
   - code prepares, plans and verifies every card, question, exam and guide
   - the model writes only what code can't (§2, "Generation, assisted by the system")
   - code for facts, Jev for typed judgments, and the student's own AI only for writing and reasoning, in one call per feature
   - cached by hash, and every call accounted for
4. **Local, student-owned, and complete to purge,** with a receipt for every byte that leaves.
5. **One typed academic API** for the app, the student's own AI clients (the optional course bank) and developers: the open academic data platform (F3, plan D42), "an academic autonmous database layer for agentic operation that we open source as a platform for badger developers to build their own study tools" (the operator).
6. **Study intelligence grounded in that graph:** per-topic understanding from real answers, and quizzes sectioned by exactly what the assessment covers.

**Build priority** (the operator, 2026-09-26 late; plan D19):
1. **The backend, fully finalized and optimized:** Parts A and B, plus the measured optimizations B5 and the in-app handler layer.
2. **The system-driven and LLM-token features:** Parts C and E: the course pass, the mapping, and the packs that generate items, cards, quizzes and guides.
3. **The Open Notebook and Quizlet-like study system:** Parts D and H, including the schedule (D8) and analytics (H7); dictation (D9) comes after the core study features.
4. **Secondary and close:** Part F (course bank, relay, the open data platform), Part I (licence, installers), then legal (Part G) last.

Nothing is dropped from the order; each phase starts once its dependencies are done.

**The rule that decides every step:**
1. Code does what has one right answer.
2. Jev makes small typed judgments.
3. Only when neither can do it well does the student's AI make one quick, catered pass: Sonnet 5, GPT-6 Sol or Gemini 3.5 Flash, with our tools (lookups the app runs; §2) and system prompts, checked by code.

## 1b. What's on `main` today vs what we're building, and why ours should work better

**The stance:** `main`'s code and its docs are the starting point. They aren't the constraint.
- Its recorded decisions and status notes are **claims to verify**.
- Where our evidence says a different design is more accurate or cheaper, our design stands, recorded with its evidence ([where we differ](../../notes/where-we-differ.md) and plan D-entries).
- A true human disagreement goes to the humans.
- **Nothing is built on an assumption:** each piece first proves it will work (research, documentation lookups, a throwaway spike where behaviour is uncertain), then is built, then is measured against its target.

Legend for the "main today" column (read in code at `9302865` unless marked): "(doc)" means a claim in the repo's docs, not re-verified.

| Area | `main` today | What we build | Why it should be more accurate or cheaper | Proven by |
|---|---|---|---|---|
| **Sign-in and session** | embedded window with `persist:uw` and a profile check (`main.ts` `magic:signin`); planning's `signInUW`; app-owned SSO and expiry recovery "remain open" (doc) | the same base, plus measured expiry recovery (one "Sign in again") and the one-checkbox setup | keeps what works; closes the open expiry gap | P1 live trial: time to connected, and the observed session lifetime |
| **Consent** | privacy prefs (`local_only` default) with `maySend` gating Jev and hosted sends; MCP grants; receipts. Provider onboarding and the first-use sensitive preview are "accepted, not implemented" (doc) | the chosen provider's consent at the "Your AI" step, then one checkbox for Jev and the Canvas disclosure (G1, plan D45); a context chip and receipt per request; a one-time preview per new sensitive category; the planning no-egress boundary | implements the accepted flow with the fewest clicks | T06 spy test: zero egress before consent |
| **Commands and IPC** | every command returns a full `snapshot()` (`core/index.ts:37`), which grows with use | scoped queries (paged, course-scoped, with a change cursor) (O1) | payloads stop growing with the data | MT1: command payload bytes, before and after |
| **Storage** | schema 5 (planning at v4, course intelligence at v5); FTS5 prefix-AND over whole documents; a `field_observations` query per row (`readResource`); inline `prepare` in loops | v6 and v7 in the same file: passages with offsets and contentless passage FTS (OR + BM25 with a term-coverage gate); a summary tier per material (B7); the course map; life items; job subjects; statement cache; `synchronous` stays FULL unless M10 adopts; `text_hash`; backup before migrating; purge that enumerates every table | exact citations; compressed context first; fewer statements per ingest; judgments that survive grade changes | MT1: ingest throughput, query p50/p95 and database size, before and after |
| **Canvas sync** | **per course already works:** course selection (scores, term filter, student overrides in `canvas-selection.ts`), `courseInclusion` gating every read, per-course capture scopes (`canvas:<account>:<course>:<scope>`) and sync-run history. **Missing:** per-course change *detection*. The activity-summary probe has no course field, so any change triggers a **full read of every course** every 10 min; concurrency 8 (unmeasured) | **reuse** the per-course selection, inclusion and scopes; **add** per-course change detection (course-keyed probes: `upcoming_events`/`todo` IDs for dated items, and a per-course content probe for undated materials, plan D37; we found no per-course `updated_at` in Canvas's courses API docs, an absence that can't be confirmed), so only changed courses re-read; a cadence table; concurrency, GraphQL and ETag measured and kept at thresholds | fewer requests; freshness ≤5 min for dated items, ≤15 min for undated materials | requests per sync, the zero-change re-sync, freshness on a live item |
| **Extraction** | PDF by page, PPTX by slide, DOCX by section, with **no character offsets**; reuse keyed on Canvas `updatedAt` | offsets on every passage; reuse by content hash; captions as timestamped passages | every quote can be checked verbatim; no re-extraction | passage exactness tests; re-extraction count on unchanged files |
| **Jev** | one question (`assignment.kind.v1`); ingest queues `enrich.resource` for every saved item (`storage/index.ts:736`), but the drain only classifies assignments and needs a gateway plus `maySend`; the gateway allows 20 calls a day per device and 100 total | code-first classification, then **one batched request per item** for role, lecture, topics and exam prep; links and item gates as Nouls; cached by hash; versioned endpoints and limits (T20b) | code answers most items for free; Jev only on what's left; never re-asked | the share classified by code; Jev calls per course (internal) |
| **The student's AI** | local Ollama coaching; paid routes accepted but "not built" (doc) | a runner that calls the student's CLI in **one call with tools off**, a JSON schema, a stable prefix, cache, a ledger and a background budget | fewer tokens than agent loops; no tool risk | MT6 ablation; the ledger |
| **Agent access (MCP)** | an MCP server that **opens the database itself** (a second process); search scans every resource in memory; up to 8,000-character windows, 20 items, ~40k tokens worst case | in-process typed handlers with token caps for the app; MCP only as an optional course bank through a read-only reader (no database path handed out) | one writer; bounded outputs; no path exposure | agent-api tests; the socket spy; caps held on real data |
| **Understanding the course** | assignment-kind classification only | the course pass (one call per course) and mapping: sessions, topics, assessments with quoted scope, materials in capped tiers, settled by the system and correctable by the student (plan D33) | nobody else knows what's on the exam; checked by code | scopes settled on real courses, checked against the operator's labels; the correction count |
| **Generation** | none | Jev + the model, assisted by code: analyzers, a planner, verifiers (numeric recompute, a WASM code sandbox, dedupe), reuse first | fewer tokens per valid item; wrong keys caught | valid items per 1,000 tokens against same-model baselines (MT7b) |
| **Study** | an `attempts` table with no consumers | the knowledge model, FSRS, Quizlet-like modes, assessment quizzes by section, level bars and the mastery bar, "quiz me on", the notes tree | study runs at 0 tokens; evidence-defined progress | the P17 journey; P18–P21 validation |
| **Planning (My UW)** | built: native UW adapters, DARS, holds, appointments, Course Search & Enroll, schema 4, no egress | **reused as is**; its records never enter AI | already working; keep it | its own tests |
| **Measurement** | none against other tools | the MT1 baseline, optimizations measured before and after, a head-to-head against NotebookLM with fixed targets | claims only from measured rows | MT7a, MT7b |

**Recorded decisions that differ from our evidence or direction** (each to settle with the humans, with evidence, per the coordination guide; the open ones are in [plan §9](plan.md#9-open-human-calls)):
- **Email:** Ben's navigation keeps Email out of the primary tabs ("Email later", `docs/decisions.md:96`). The mail gist and link land inside the course pages, the Briefing and Today, not a new tab (plan D44).
- **"No invented mastery":** vs our evidence-defined mastery bar (open: H8).
- **The price and setup prerequisites,** including whether OpenRouter users also pay the $5 (open: H1).
- **The gateway's small limits:** vs item cards at course scale (D16).

## 1c. Capability map: parity with NotebookLM, Quizlet, Knowt and Anki, and where we outperform

**Evidence:** the reference behaviour comes from Exa Agent inventories run 2026-09-26 (`research/validation/exa-runs-scope.md`, runs A and A2, private), each row with the vendor's own page. NotebookLM's limits are its free-plan figures from the usage table Google says changes "Starting on September 2, 2026" ([answer/16213268](https://support.google.com/notebooklm/answer/16213268)). Nothing in the "outperform" column is claimed publicly until its measurement row (B6, MT) has run (D22).

**Status labels:** *researched* (evidence only) · *proposed* (specified here, no code) · *built* (code exists in a lane worktree, not merged) · *tested in isolation* · *integrated* (merged into `feat/course-backend`) · *demonstrated* (shown on a real account). The status names the task that carries it, as of 2026-09-26 late; the live state per task is in [execution.md](execution.md#build-mode-from-2026-09-26-about-2200-ct-the-operators-direction), the one canonical place. Integrated: T12, T13's pack core, T40 and the D38 session pool (merge `efc6604`). Built in lane worktrees, not integrated: the learning engines (N00, N05–N12, N14, N29, P01, P05, P07, P08, P11, P14, P16), the data layer (T10, T10L, T11a, T11b) and the sync seams (T05b, T23, T25/T33, the access check of T28).

**Method key** as in §2: *system* (code, 0 tokens), *Jev* (typed judgments), *AI* (one checked call on the student's own client). Every AI output passes the code checks: quotes verbatim against the exact source version (T11a), IDs exist, dates re-resolved in code.

| # | Capability | The reference product: behaviour and limits (source, date) | Ours: method and grounding checks | Status | How ours should outperform, and the measurement |
|---|---|---|---|---|---|
| **NotebookLM** | | | | | |
| 1 | Sources and quotas | Audio, text, Docs/Slides/Sheets, images, Office, PDF, CSV, PPTX, URLs, ePub, public YouTube; ≤500k words or 200 MB per source; free plan 50 sources per notebook and 100 notebooks, uploaded by hand ([answer/16215270](https://support.google.com/notebooklm/answer/16215270), [answer/16213268](https://support.google.com/notebooklm/answer/16213268); 2026-09-02 table) | system: every course space inventoried and read by code through the student's own sign-in (A5, D32); no upload, no per-notebook cap; stored locally (B) | sync built on `main`; inventory built (sync lane) | 0 manual steps after sign-in, and a course appears without uploads. **MT7a:** manual steps; sign-in → all sources in vs hand upload |
| 2 | Grounded chat with citations | Answers from all or selected sources, with citations: "Las citas son citas directas" ([answer/14276569](https://support.google.com/notebooklm/answer/14276569)); free plan 50 chats a day ([answer/16269187](https://support.google.com/notebooklm/answer/16269187)) | AI (chat pack T42) over retrieval the app runs: summaries first, passages on need (B7), ≤3 lookups a round, ≤2 rounds; every quote checked by code against its version; "couldn't find support" is an answer | quote validator and passage search built (T11a, T11b; data lane); chat proposed | Scoped to the assessment automatically, with code-checked quotes. **MT3:** quote validity and claim support. **MT7b:** answer p50/p95, and tokens against the long-context baseline (≥50% fewer) |
| 3 | Reports: study guide and briefing | Studio reports, free plan 10 a day ([answer/16206563](https://support.google.com/notebooklm/answer/16206563)) | system outline (sections, key terms, formulas, dates) + AI prose per section; unsupported claims removed (T44; N12 schemas) | N12 built (learning lane); T44 proposed | Fewer tokens, since the model writes only prose. **MT7b:** tokens per guide; claim support from a human sample |
| 4 | Reports: FAQ | Studio report, same quota ([answer/16206563](https://support.google.com/notebooklm/answer/16206563)) | AI (FAQ pack, T74) over the scope's summaries (B7); each answer quote-checked | proposed | Scoped to an assessment. **MT7b:** tokens per report (reported, not a claimed row) |
| 5 | Reports: timeline | Studio report ([answer/16206563](https://support.google.com/notebooklm/answer/16206563)) | system: the unified schedule (D8) plus dated passages; dates from Canvas fields and extracted claims, never from a model; N12 checks each timeline date inside its quote | N12 built (learning lane); T66 proposed | Every date is exact and cited, at 0 tokens. **Check:** a replay test finds no date that isn't in its source |
| 6 | Mind map | Concept maps, free plan 10 a day (blog.google, the Studio upgrade post, 2025-07-29) | system: the concept map from `learning_concepts` and sessions, linked to assessments' scopes (T43; N05 builder) | N05 built (learning lane); T43 proposed | 0 tokens, and tied to what each exam covers. **Ledger:** 0 model tokens (internal row) |
| 7 | Audio overview | AI-hosted discussion, interactive, 80+ languages; free plan 3 a day (blog.google, 2025-08-25) | AI script pack; played by the OS voices through Chromium's `speechSynthesis`, "via the device's speech synthesizer" (chromium `docs/accessibility/browser/tts.md`); no text leaves the device for speech (T52) | proposed | **Not claimed to outperform:** one narrator with OS voices, no interactive mode. It's a narrower feature, kept for privacy |
| 8 | Video overview | Narrated slides, free plan 3 a day (blog.google, the Studio upgrade post, 2025-07-29) | — | **not planned** | No study job we've named needs video. Rendering and narration add cost and a second speech path. Revisit if students ask |
| 9 | Slide deck | Generated presentations, tiered quota (blog.google, 2025-12-16) | — | **not planned** (later, if asked) | The study guide covers the study job. An export of its outline to slides would reuse T44 |
| 10 | Infographic | Visual summaries, tiered ([answer/16213268](https://support.google.com/notebooklm/answer/16213268)) | — | **not planned** | No named study job |
| 11 | Flashcards | Difficulty, explanations, progress tracking, retake, hints, CSV export; free plan 10 a day ([answer/16958963](https://support.google.com/notebooklm/answer/16958963)) | system first: term and cloze cards from extracted definitions (T57, MB2); AI only for concepts without a clean definition; quote-verified; FSRS scheduling (N14); CSV export through the data platform's read contract (F3) | FSRS adapter built (learning lane); T41, T57 proposed | Scheduled against the course's real exam dates; the inventory names no spaced-repetition scheduler for NotebookLM. **MB2**, **MT4** item quality, **MT7b** tokens per card set |
| 12 | Quizzes | Difficulty, explanations, progress tracking, retake, hints; free plan 10 a day ([answer/16958963](https://support.google.com/notebooklm/answer/16958963)) | instructor questions first (T1, MB3), then the items pack (T45) with verifiers (T64); the assessment quiz sectioned by its chapters and modules (T53); topic tags per question | N06 checks built (learning lane); T45, T53, T64 proposed | Sectioned by what the exam covers, with checked keys. **MT7b:** time to first question ≤20 s and ≤ NotebookLM's; tokens per 10-question quiz. **MT4:** seeded-error catch |
| 13 | Progress and diagnostics (Gemini study notebooks) | Diagnostic quizzes, bite-sized lessons, progress tracking, with Keep Activity on ([Gemini help 16972047](https://support.google.com/gemini/answer/16972047)) | system: per-topic states (N07) and study analytics (H7), 0 tokens, local | N07 built (learning lane); H7 proposed | Evidence-defined and local. **P18–P21:** offline validation of the thresholds |
| **Quizlet and Knowt** | | | | | |
| 14 | Learn | Quizlet: adaptive path; custom paths, Progress and smart grading for subscribers ([Quizlet 360030841732](https://help.quizlet.com/hc/en-us/articles/360030841732)). Knowt: "unlimited rounds of our free learn mode" ([knowt.com](https://knowt.com)) | system: Learn (N09: MC → typed, the mistakes queue); typed answers graded by a code key-idea checklist, Jev per key idea only when code can't decide (N08) | N08, N09 built (learning lane) | Items come from the assessment's scope, at 0 tokens during study. **MB4:** grading agreement ≥90%; **P17** journey |
| 15 | Test | Quizlet: Plus only; free users get one practice test per set ([360030841732](https://help.quizlet.com/hc/en-us/articles/360030841732)). Knowt: practice tests ([knowt.com](https://knowt.com)) | system: Test with fidelity tiers T1–T4 (P09), the practice exam (T46), the sectioned assessment quiz (T53) | proposed | Not paywalled beyond the student's own AI plan (open: H1). **MT7b:** quiz rows |
| 16 | Match | Quizlet game (Gravity retired); Knowt matching ([360030841732](https://help.quizlet.com/hc/en-us/articles/360030841732)) | — | **not planned** (D20: a study tool, not a game; PI-13 dropped) | — |
| 17 | Flashcards with spaced repetition | Knowt: spaced repetition ([knowt.com](https://knowt.com)). Quizlet: flashcards | as row 11, FSRS per card with per-concept retrievability (N14) | FSRS adapter built (learning lane) | **P20/P21:** decay and scheduling against the srs-benchmark and HLR baselines |
| 18 | AI study guides from uploads | Quizlet: "Upload or paste your course materials to generate a study guide … outline, flashcard set" ([18312306436365](https://help.quizlet.com/hc/en-us/articles/18312306436365)). Knowt: uploads (PDF, slides, lecture video, YouTube) become notes, guides, cards and quizzes; Ultra $199.99 a year ([knowt.com/plans](https://knowt.com/plans)) | as rows 3 and 11, from synced materials; nothing is uploaded | proposed | 0 uploads. **MT7a:** manual steps; **MT7b:** tokens per guide |
| 19 | Progress | Quizlet: "tracks your answers across activities", Plus only, not tracked in games ([360048803491](https://help.quizlet.com/hc/en-us/articles/360048803491)). Knowt's teacher hub: time per mode, mastery per card and per file (help.knowt.com, article 10721997) | system: per-topic levels and the assessment bar (H4, T54), study analytics (H7, T67) | N07 built (learning lane); T54, T67 proposed | Progress per topic of a real assessment, not per set. **P18–P21**; **the ledger:** 0 tokens during study |
| 20 | Streaks | Quizlet Answer Streaks: "After five correct answers in a row, your streak begins." ([40011154960653](https://help.quizlet.com/hc/en-us/articles/40011154960653)) | — | **not planned** (D20: no streaks; the P16 lint rejects streak copy) | — |
| 21 | AI helper for missed questions | Knowt's Kai explains missed questions ([knowt.com](https://knowt.com)). Quizlet's Q-Chat was "completely turned off … after June 30th, 2025" ([18811152410125](https://help.quizlet.com/hc/en-us/articles/18811152410125)) | explanations written once at generation, quote-checked, served at 0 tokens (ST-11); chat (T42) for open questions | proposed | An explanation costs nothing at study time. **The ledger** |
| 22 | LMS connection | Quizlet: Google Classroom add-on, no direct Canvas integration documented ([45955621176589](https://help.quizlet.com/hc/en-us/articles/45955621176589)). Knowt: "LMS Integration (Canvas, Google Classroom, etc.)" for schools ([knowt.com/teachers](https://knowt.com/teachers)) | system: the student's own Canvas session, no school deployment needed (A) | sync built on `main` | Works for one student without a school contract. **MT7a** |
| **Anki** | | | | | |
| 23 | FSRS | An alternative to SM-2; default desired retention 90% (docs.ankiweb.net, deck options) | system: `ts-fsrs` (N14), desired retention in the versioned configuration, a pre-exam review against the course's real exam dates (D8) | FSRS adapter built (learning lane) | The schedule knows when the exam is. **P20/P21** |
| 24 | Statistics | Reviews, future-due forecast, card counts, review time, true retention, FSRS stability, difficulty and retrievability ([docs.ankiweb.net/stats](https://docs.ankiweb.net/stats.html)) | system: the same statistics per topic and per assessment, the forecast set against the real exam dates (H7, T67) | proposed | Grouped by what each exam covers. **Check:** every figure equals a recomputation from the raw reviews (T67); 0 tokens |
| 25 | Sync across devices | AnkiWeb sync ([docs.ankiweb.net/syncing](https://docs.ankiweb.net/syncing.html)) | — (local, one device; the relay F2 is a read-only pass-through) | **not planned** | Local ownership (plan D12) |

## 2. The AI boundary: system-driven, Jev, or the student's AI (decided before building; gate T02)

**The principle: AI writes, code decides.**
- **Tokens are spent when study content is created**: once, cached by hash, and checked by code.
- **They're never spent during study.** A quiz, a flashcard review, grading, levels, the mastery bar and the prep list all run on code, at zero tokens. The one exception is topping up a thin question pool, which happens in the background and within consent.

**Method key:**
- **System:** code on structured fields, patterns and math; 0 tokens.
- **Jev:** a typed judgment (a Choice or a Noul) on a small candidate set that code builds, batched and cached; paid by us.
- **AI:** one catered call on the student's own AI (a prompt pack), checked by code.

**"Our tools"** means lookups the **app** runs for the model: the scoped context assembled up front, and in chat, up to 3 typed lookups per round, at most 2 rounds, that the model asks for through the `need` field. The model is never handed tools directly, so untrusted course text can't trigger anything.

**Collect** (all system):

| Function | Method | Fallback | Why this method |
|---|---|---|---|
| Sign-in and session | system (the student does NetID + Duo) | "Sign in again" | policy: never automate Duo; the NetID password is stored only by the student's opt-in "Remember my sign-in" (plan D39) |
| Canvas, calendar feeds, Kaltura, external sites, GitLab, Course Search & Enroll, campus feeds | system | partial scopes stay partial | structured APIs and feeds |
| Outlook mail sync | system (Graph delta) | the on-demand code read of the inbox (T35) | a documented API |
| Text extraction (PDF, slides, docs, HTML, captions) | system | OCR for empty pages only | deterministic parsers |
| Change detection, duplicates, "what changed" | system | — | hashes, IDs, URLs |

**Organize** (system first, Jev for the leftovers, AI only for language):

| Function | Method | Fallback | Why |
|---|---|---|---|
| Course structure: modules, order, dates, points, types, assignment groups | system | — | Canvas fields |
| Material role (slides, reading, spec, rubric, practice exam…) | system rules (Canvas type, file type, title patterns) | Jev: a two-level Choice | closed set; code covers most |
| Which lecture or session an item belongs to | system (numbers, dates, recording dates, unlock dates) | Jev: Choice among ±2 candidate sessions | closed set |
| The topic list per course | system seed (module and lecture titles, slide headings) | **AI** course pass names and merges units and topics; student edits win | naming topics is language |
| Assessments (exams, quizzes, projects) and dates | system (assignment groups, names, dates; syllabus HTML tables; **the team's deterministic prose extraction** of due, lock and exam dates from assignment, announcement, syllabus and page text, each claim with a validated literal span, and its tiered resolver, on `integration/backend-features`, pending merge) | **AI** course pass only for what that extraction doesn't read: PDFs, discussions, section-specific dates, non-English text | prose schedules need reading; the team's extraction reads the English prose code can |
| An assessment's scope statement | system patterns ("covers lectures 10–18", "chapters 4–6", "weeks 5–9", "cumulative", "since the midterm") | **AI** course pass when unmatched or conflicting; the system settles it and the student may correct it (plan D33) | MB1 measures how often patterns suffice |
| Materials per assessment (Core, Also useful, Practice) | system (scope range → sessions → items; explicit links; module membership); caps and ranking by code | Jev: one Noul per remaining candidate (≤30) | closed yes/no |
| Chapter and module sections of an assessment quiz | system (from the settled scope) | — | structure |
| An assignment's relevant resources | system (links in its text, its module, prior lectures; **the team's fuzzy supporting-material candidates**, proposed after each sync by lexical scoring within the same course, rule `link.fuzzy.v1`, on `integration/backend-features`, pending merge) | Jev: a Noul per remaining candidate (open: H4) | closed yes/no; the team's candidates are the input, not a second candidate generator |
| Mail filing (course, club, advising, careers, admin, noise) | system (sender rules, course staff names, duplicates) | Jev: area Choice; "action needed" Noul; affected assessment Noul per candidate | closed sets |
| Mail gist and facts (plan D44) | system: the subject; with the `Mail.Read` opt-in, a code-extracted gist and facts (course, dates, action) from `uniqueBody` read in memory and discarded | **AI**: an optional daily batched digest for action-flagged mail, from the stored gist and facts | free text |
| A date moved by an email or announcement | system reads dates | Jev: which assessment; applied when it matches Canvas; otherwise shown as a conflict, and planning uses the earlier date until Canvas agrees (plan D33) | dates stay in code |
| The course AI policy | system triggers (policy phrases); the course-intelligence profile's cited policies on `main` ("Unknown policy is not permission", `docs/course-intelligence.md`) | Jev: a strict Noul (can only tighten; loosening needs the student) (open: H6) | integrity |

**Create study content** (AI once, cached and checked; system where it can):

| Function | Method | Fallback or check | Why |
|---|---|---|---|
| Questions from **instructor** practice quizzes and exams (T1) | system extraction (numbering, options, answer-key patterns in files and pages) | Jev tags topics (Noul per candidate); **AI** structures only files code can't split | the instructor's own questions beat generated ones |
| **Generated** questions: MC, T/F, typed, cloze, numeric | **AI** (items pack) from mapped passages | checked by code (verbatim quote, flaw rules, numeric recompute) and Jev (one correct option) | writing questions is language |
| Topic tags on generated questions | **AI** proposes at generation | code validates (an existing concept, same course, 1–3) | the question's intent is known when it's written |
| Explanations, hints, "why it's tempting" | **AI** at generation, stored | quote-checked | written once, served free |
| Flashcards | **system first:** term and cloze cards from the extracted definitions | **Jev + AI** for concepts without a clean definition, then the verifiers; MB2 sets the split per course | code where it can, the model where it must |
| Study guide, briefing, FAQ | **AI** | every claim quote-checked; unsupported claims removed | synthesis is language |
| Timeline | system: the unified schedule (D8) and dated passages | every date inside its quote (N12) | dates stay in code |
| Material summaries (B7) | system: an extractive gist and key facts with offsets | **AI** abstractive gist, batched in the background within budget, quote-checked | compressed context for every later call |
| Practice exam | system blueprint (coverage weights, sections, tiers) | items as above | structure |
| Audio overview | **AI** script | system playback with local OS voices | speech stays local |
| Chat and explain | **AI**, with the context assembled by the system | citations checked by code | open questions |
| "Quiz me on…" described in text | system (ranges, filters, labels, aliases) | Jev concept Noul, then an **AI** rescope pack (rare); accepted answers saved as aliases | code gets better with every use |

**Generation, assisted by the system** (plan D28). Cards, questions, practice exams, quizzes and guides need **Jev + the model**. Code does everything around the model so it writes less, and writes it right:
1. **Content analyzers** (code, at ingest; T57). Each finding is tagged to its topics:
   - key terms and definitions: bold or italic terms, "X is / refers to / is defined as" sentences, glossary pages
   - formulas and worked examples; code snippets; ordered processes and lists; figure captions
   - **instructor emphasis signals:** a topic repeated across lecture, reading and assignment; "important" or "on the exam"; review sheets; summary slides
2. **A generation planner** (code; T58):
   - **What to make:** questions and cards per section and topic, from the coverage weights and, once the knowledge model exists, the student's weaker topics.
   - **The question type for each piece of content:**

     | Content | Question type |
     |---|---|
     | a definition | cloze or typed |
     | a process | ordering |
     | a formula | numeric, with the answer recomputed by code |
     | code | output tracing, verified by running it |
     | two confusable topics | MC with distractors from the other topic |
   - **What the model gets:** only the passages for its cells, in **one batched call per section**, with a byte-stable prompt prefix.
3. **Code-first artifacts:**
   - term cards and cloze cards come straight from the extracted definitions (MB2)
   - the study-guide outline (sections, key terms, formulas, dates) is built by code, and the model writes only each section's prose, with quotes
4. **Verifiers** (T64):
   - **by code:**
     - every quote validated verbatim
     - numeric answers recomputed
     - code questions **executed in a WASM sandbox** (Pyodide for Python, QuickJS for JavaScript), with no network, no file system and a time limit. quickjs-emscripten states "Safely evaluate untrusted Javascript" and has a deadline interrupt ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)); Pyodide's no-network and no-file-system behaviour isn't established, so a spike proves both before code questions ship
     - near-duplicates removed across instructor and generated items
   - **by Jev:** exactly one correct option (a Noul per option), and key-idea coverage
   - **learned from use:** each item's difficulty, from students' answers (Elo)
5. **Reuse before generation:** instructor questions (T1) and existing checked items fill the plan first. The model generates **only the missing cells**, and regenerates only when a passage's text hash changes.
6. **Measured** (MT6, MT7b): valid items per 1,000 tokens, tokens per quiz and per guide, and time to first question, against a NotebookLM-style long-context baseline and Open Notebook, both on the same model.

**Study time** (all system, 0 tokens):

| Function | Method |
|---|---|
| Assembling and sectioning a quiz, the session builder, the mistakes queue, filters, starred items | system |
| FSRS scheduling and the pre-exam review | system (ts-fsrs) |
| Grading MC, T/F and numeric answers | system (exact and numeric tolerance) |
| Grading typed answers | system (key-idea checklist with synonyms), with a Jev Noul per key idea only when code can't decide (N08) |
| Understanding levels, the mastery bar, the prep list, the coverage map, error patterns, calibration | system (the versioned evidence rules) |
| Study analytics (H7): accuracy by module and chapter, the review forecast, true retention, stability and difficulty, time studied | system |
| Study sessions placed on the schedule against exam dates (D8) | system |
| Topping up a thin pool | **AI** items pack: background-first, within consent and the background budget |

**Planning** (My UW, grades, holds, DARS): system only, local only; it never goes to AI, Jev or MCP (team boundary).

**Platform** (all system): the one-checkbox consent and receipts, onboarding detection and the client configuration (E6), the ledger, purge, licence activation, the data platform's read contract and write checks (F3), and dictation's local speech-to-text (D9), whose transcript then runs like a typed command.

**Notes** (spec D7):
- **system:** the `.docx` tree, organisation, links and updates
- **Jev:** picks each session's template
- **the AI, optional:** pre-fills an outline from that session's materials, with checked quotes

**Measure-first, where code might replace AI** (each can only move a row toward "system"):
- **MB1:** the share of real assessments whose scope code patterns resolve. Adopt as the default path when ≥60% match with ≥95% precision against the student's labels.
- **MB2:** code-built cloze cards vs AI cards. Adopt where their validity is within 5 points.
- **MB3:** instructor-question extraction by code. Adopt per file type at ≥90% correctly split questions.
- **MB4:** typed-answer grading without Jev. Adopt when it agrees with human grading at ≥90%.

**Verified by the ledger:** a study session shows **0 model tokens** unless a top-up ran, which is labelled.

## Part A. Connect and collect (the established connection to every source)

**A1. Sign-in: the built flow, kept.**
- An embedded window (`magic:signin`) with the persistent `persist:uw` session. The student enters NetID and Duo.
- **The NetID password is stored only when the student opts in** to "Remember my sign-in" (off by default; plan D39): encrypted on that computer by `safeStorage`, filled only on UW's NetID login page. UW's standard (KB 59262) applies to "applications or systems for UW-Madison business" and says "Storing one's personal NetID and NetID password in a password management application is permitted."
- It never reads browser cookie stores and never automates Duo.
- **No request is ever sent to keep a session alive.** Signed-in background reads (Canvas, GitLab, My UW, Enroll) run only while the student is present: input within the last 30 minutes, the screen unlocked, outside quiet hours and not suspended. While the student is away, only credential-free calendar feeds refresh, so the session ends on UW's own clock (P1-D2). A read made in that window can still refresh Canvas's idle clock; the P1 trial measures how often (M12).
- **Quitting signs out.** `canvas_session` and the UW login's cookies are session cookies, and Electron drops them on quit (measured, Electron 44.4.5). The app never saves or restores them across a quit; UW KB 4302 calls browser session restore "a serious security concern".
- **"Keep me signed in," on by default** (P1-D1):
  - closing the window keeps the app running in the tray, and the app starts with the computer
  - a sign-in is needed only after a reboot, a Quit, Sign out, or UW's own expiry
  - Quit and Sign out in the tray menu end the session
- **When a sign-in is needed, the app opens the UW window by itself;** there's nothing to click (D33) (open: H3, see plan §9). With "Remember my sign-in" on, the app fills the NetID sign-in itself, and only Duo appears, when Duo requires it (D39) (open: H2, see plan §9).
- **Duo "Remember me":**
  - KB 85205 (updated 2025-06-01) says it "remembers your current browser for 7 days"; the it.wisc.edu change notice (published 2025-06-02) says "extending the 'Remember Me' function from 12 hours to 7 days"
  - the it.wisc.edu student FAQ (modified 2026-07-17) still says 12 hours; 7 days is most likely current
  - it skips only the Duo step, and only if its cookie persists. Whether it does in `persist:uw` isn't stated by UW or Duo; KB 85205 says it may not work "If you close your browser"
  - the P1 live trial lists the `duosecurity.com` cookies after a remembered sign-in (names, `session` and `expirationDate` only, never values)
- We found no passwordless NetID login; no UW page says either way.
- **Expiry:**
  - a 401 whose body `status` is `"unauthenticated"`, confirmed by one profile read (Canvas's docs don't state these bodies; the P1 live trial records them)
  - a permission error (`"unauthorized"`, or a 403 that isn't a rate limit) marks only that area inaccessible
  - on a relaunch, a missing `canvas_session` shows **Sign in again** within 2 s, with no network request
- **The My UW and Enroll sign-ins confirm themselves** with the existing `session.json` or `student-info` read.
- **Persistent cookies, including Duo's, are encrypted on disk** in packaged builds, by Electron's cookie-encryption fuse (T63).

**A2. Sources and their decided routes:**

| Source | Route | Signed out? | What's kept |
|---|---|---|---|
| Canvas (courses, modules, pages, files, assignments, quizzes, announcements, discussions, syllabus) | REST through main's session (the Canvas connector) | no | full course content, with passages (Part B) |
| Canvas calendar feed | ICS URL captured while signed in | **yes** | events, dates |
| Kaltura recordings | links and recording dates from module items and embeds; captions when present and readable (probe K1) | no | link, date, title; caption segments with timestamps |
| External course sites | the external-site connector (robots.txt, same-folder crawl) | yes (public) | pages and documents, as passages |
| GitLab | the GitLab connector | its session or token | project files, issues |
| **My UW and planning** (built on `main`: [planning](../../planning-upgrade.md)) | native UW adapters through the app-owned UW session: student summary, enrollment, degree-plan history, appointments, holds and advisors, saved DARS; **Course Search & Enroll public reads** (search, packages, meetings) | public reads yes; private no | planning records in their own tables. **Planning never goes to hosted AI, Jev, tutoring context or MCP** (the team boundary) |
| **Outlook mail** | **Microsoft Graph, delegated:** `Mail.ReadBasic`, plus the opt-in `Mail.Read` for any summary (plan D44); signed in through Microsoft's own page, with the UW account, in an app-owned window | no | **compressed:** sender, subject, received time, labels, `webLink`, and with `Mail.Read` a code-extracted gist and facts (course, dates, action). Never bodies |
| Outlook calendar | the ICS link the student publishes (UW KB 73250; reuse the Today rail's `setOutlookCalendar` on `main`), or Graph `Calendars.ReadBasic` once consent exists (not verified) | yes (ICS) | events, on the unified schedule (D8) |
| Campus events | `today.wisc.edu/events.ics` (verified) | yes | gist + link |
| Campus news | `badgerherald.com/feed/`, `news.wisc.edu/feed/` (verified) | yes | gist + link |
| Clubs, advising, careers | **via email** (WIN, advising offices and Handshake all email students; advising appointments and holds come from planning). WIN and Handshake aren't scraped | — | gist + link |

**A3. Outlook: collected by code, stored compressed** ([plan D44](plan.md); the operator's feature: professor and TA emails, schedule changes; the operator: "THe outlook is also enhanced with efficient in cost and time retreival and smart compressed summary storage"). Status: researched and proposed; probe E1 hasn't run.
- **Why Graph is the route:** it's the documented automated route. Scripted reading of Outlook on the web relies on undocumented interfaces, and no terms allowing it were found.
- **Permissions:**
  - `Mail.ReadBasic` excludes "body, previewBody, attachments and any extended properties" ([Graph permissions reference](https://learn.microsoft.com/graph/permissions-reference), 2026-09-14; M2). Under it, the gist **is the subject line**.
  - **Any real summary needs `Mail.Read`**, requested only when the student opts in.
- **Consent (M3, M4, M5):**
  - Under the Microsoft-managed default, users can consent to delegated permissions "EXCEPT: … Mail.Read … Mail.ReadBasic" ([manage app consent policies](https://learn.microsoft.com/entra/identity/enterprise-apps/manage-app-consent-policies), 2026-06-17). So both likely need an admin, whatever the publisher (inferred, high).
  - Publisher verification needs a Partner One ID and takes 3–5 business days ([publisher verification](https://learn.microsoft.com/entra/identity-platform/publisher-verification-overview)); it doesn't by itself unblock these permissions.
  - UW allows OAuth approvals and asks students to review and remove access ([KB 139025](https://kb.wisc.edu/139025)).
  - **Probe E1 in UW's tenant decides.** It tests `Mail.ReadBasic` and `Mail.Read` separately, and records which fields arrive.
- **Sign-in (M7):** MSAL Node as a public client, authorization code with PKCE ([MSAL Node desktop tutorial](https://learn.microsoft.com/entra/identity-platform/tutorial-v2-nodejs-desktop)). The tutorial signs in through the system browser. We use MSAL's interactive flow in an **app-owned window** instead, because AGENTS.md says "Use app-owned sessions; do not silently attach to personal browser profiles." The token cache is OS-encrypted, and the token never leaves main; main proxies Graph calls for the worker.
- **Sync (M1):** delta per folder, the Inbox first, with the `deltaLink` saved and `Prefer: odata.maxpagesize`; a filtered delta returns at most 5,000 messages ([delta query for messages](https://learn.microsoft.com/graph/delta-query-messages)). Every 5 min while the student is present.
- **Throttling (M6):** 10,000 requests per 10 minutes and 4 concurrent requests per app and mailbox ([Graph throttling limits](https://learn.microsoft.com/graph/throttling-limits), 2026-02-06). The connector keeps one request in flight, honours `Retry-After`, and backs off on a 429.
- **Compressed storage, per message:**
  - kept: sender, subject, received time, labels, `webLink` ("The URL to open the message in Outlook on the web"), the filing area and course
  - with `Mail.Read`: a **code-extracted gist** (one sentence, at most 160 characters, name-scrubbed) and **extracted facts**: the course (sender map, course codes), dates (the code date parser), and an action label (due, moved, cancelled, office hours, reply requested)
  - read to make them: `uniqueBody` through `$select`, the part of the body unique to this message ([message resource](https://learn.microsoft.com/graph/api/resources/message), 2025-10-23; M8). It's processed in memory and **discarded**: never stored, logged, sent or put in a receipt. `bodyPreview` is its first 255 characters, and isn't stored either.
  - about 0.5 KB per message, so 10,000 messages is about 5 MB (inferred)
- **The AI digest:** for messages flagged "action needed", one **batched** call a day on the student's AI, within the background budget, writes one line per message from the subject, gist and facts, never from a body. The payload is identity-scrubbed first (G1).
- **Fallback if UW's tenant blocks consent:**
  1. A **code** read of the rendered inbox list in the app's own signed-in Outlook web window (sender, subject, date, preview line, link), run on demand. Microsoft's terms for this are checked before it ships.
  2. Or an on-demand "import recent email" pack run by the student's AI with a browser.

  Neither runs in background sync.
- **Filing:**
  - Canvas, Piazza and Gradescope notifications are matched to synced items and stored as `duplicate_of`.
  - Senders map to areas: instructors and TAs from course rosters → that course; Handshake → careers; WIN → clubs; advising offices → advising; list headers → lists.
  - Jev answers the rest: an area Choice (a two-level tree), an "action needed" Noul, and "affects which assessment" as one Noul per candidate. Code reads dates.
  - **Jev can raise a message's visibility but never hide one.** A student's correction teaches the sender map.
- **Where mail shows:** Ben's navigation call stands: "Primary navigation: **Home / Courses / My UW / Calendar** … Email later" (`docs/decisions.md:96`). Mail appears inside the course pages, the Briefing and Today, and moved dates appear on the schedule (D8). It isn't its own tab unless that call changes.
- **TA and instructor matching:**
  - Canvas course users with teacher and TA enrollments, by display name. The endpoint is documented ([Canvas courses API](https://canvas.instructure.com/doc/api/courses)); whether students see email addresses wasn't established, so matching doesn't rely on them.
  - The Canvas connector adds `/courses/:id/users?enrollment_type[]=teacher&enrollment_type[]=ta` to its allowlist (T34).
  - Names that don't match fall to Jev.
- **Course effects:** a professor or TA email that moves a lecture, exam or due date shows as a **change** on that course and assessment, linked to the message. Code applies a date when it matches a Canvas change. Otherwise both dates show as a conflict, and planning uses the earlier one until Canvas agrees; the student is never asked to confirm (plan D33).

**A4. Tracking new additions.**
- **Hot cadence, every 5 min:**
  - the calendar feeds
  - one `upcoming_events`/`todo` probe, whose IDs carry their course, so a change maps to specific courses
- **Content probe, every 15 min and on app focus, per course** (plan D37): the course's own activity summary, a hash of its module items, and the newest file and page where the student can list them. Warm reads go only to the courses whose probe moved.
- **Warm reads:** only those courses.
- **Full refresh:** keeps its 10 min ±20% interval.
- Refresh already runs calendar feeds → a Canvas summary probe → a full read only on change → documents → external sites, every 10 min ±20%.
- **Added:**
  - warm reads limited to **changed courses**
  - a Graph mail delta every 5 min
  - public feeds hourly
- Every change lands in `resource_changes`, with a monotonic cursor, and drives Part C's incremental mapping.

**A5. The course space inventory, then targeted reads** ([plan D32](plan.md)). Code first lists every place a course keeps content: navigation tabs and external tools, module items by type, the syllabus, and links found in bodies. Each space is then read by the cheapest route that works: an API, a public fetch, or a browser-driven read in the app's own session, where a model-written extraction recipe runs once per page layout and code runs it after that. Each course shows each space's access state (readable, needs UW sign-in, needs own login, link-only, blocked; plan D41) as a course chip. The inventory and the access check are built in the sync lane's worktree (T23, T28), not yet integrated; the recipe step is proven in P3's feasibility pass before it's built.

## Part B. Store (one local SQLite file)

**B1.** Stay on `node:sqlite`. `main` is at schema 5 (planning at v4, course intelligence at v5). Add **v6** (the course core) and **v7** (learning and practice) in the same file. The planning and course-intelligence tables are preserved, and purge coverage is extended.
- **Keys:** every new table is keyed to `sources(id) ON DELETE CASCADE`, directly or through `resources`. There's no `courses` table; a course is `sources.course_id`.
- **Purge (the one canonical list; other docs link here):** `purge()` adds explicit `DELETE`s for everything not reached by cascade: `passage_fts`, `compile_runs`, `ledger`, `ui_events`, `map_links` rows whose from-side isn't a resource, subject jobs with a null `resource_id`, `course_spaces` and `extraction_recipes` (D32), `course_briefs` (D34), `material_facts` and `material_summaries` (B7), and `platform_writes` (F3). It also removes every app-owned file: pre-migration backups, the per-course client folders (E6), the extraction cache (T16) and the remembered sign-in (D39, through main). The purge test enumerates every table in `sqlite_schema` and those files.
- **Life sources** (Outlook, feeds) use the sentinel `course_id` `"_life"`, because `sources.course_id` is `NOT NULL`.
- **Jobs:** they gain a subject (`subject_kind`, `subject_id`, a nullable `resource_id`), with a staleness rule per kind, and `lease(kinds[])`. Course, assessment and pack jobs then live beside resource jobs, and the existing drain leases only its own kinds.

**B2. New tables:**

| Group | Tables |
|---|---|
| Passages | `passages` (resource, version, text hash, order, start and end offsets, page, slide, `t_start`, `t_end`, heading, token estimate, redacted), `passage_fts` |
| Course map | `course_sessions`, concepts in `learning_concepts` (Part H2), `assessments` (own ID, optional `resource_id`, so an exam named only in the syllabus exists), `assessment_scope`, `map_links` (from → to, kind, tier core / supporting / practice, reason, rung code / jev / pass / student, status). **Jev links live here too**; `links` doesn't gain `covers` |
| Life items | `life_items` (source, area, course?, sender or publisher, title, date, labels, link, `duplicate_of`, gist, facts: course, dates, action; A3) |
| Inventory and access (D32, D41) | `course_spaces` (course, kind, host, found in, access route, access state, checked at), `extraction_recipes` (host, layout hash, recipe, validated at) |
| Course brief (D34) | `course_briefs` (course, syllabus resource, text_hash, pass_version, brief JSON, prefix hash), or a course-intelligence revision in v5's tables (open: H6, see plan §9) |
| Material records (B7, D35) | `material_facts` (resource, version, kind: term, definition, formula, example, code, date, emphasis; offsets; topics), `material_summaries` (resource, version, text_hash, gist, key facts with offsets, outline, token estimate, method: code or pack) |
| Data platform (F3) | `platform_writes` (token, action, artifact, before and after, receipt, undone at) |
| Learning and practice | the learning spec's §7.2 tables (concepts, items with sources, concepts and checks, cards, reviews, attempts, self-ratings, disputes, artifacts, coverage, sessions, concept state, prefs) and the practice addendum's §6 tables (stars, option tags, views), as the v7 migration. `learning_passages`, `learning_passage_search` and `learning_jobs` are replaced by `passages`, `passage_fts` and the extended `jobs` |
| AI runs and use | `compile_runs`, `learning_artifacts` (pack results, D17), `ledger`, `ui_events` (expand "All in scope", move between tiers, open, correct) |

**B3.** Existing `jobs` (subject columns), `judgments`, `links`, `attempts` and `receipts` are extended, not replaced.

**B5. Optimized and measured** ([backend optimization plan](../2026-09-26-backend-optimization/plan.md), [measurement plan](../2026-09-26-measurement/plan.md)):
- **First, a baseline:** sync requests and time, ingest throughput, query p50/p95, command round trip and snapshot bytes, and cold start. It's recorded by the perf harness (MT1) at the current commit.
- **Then the decided optimizations,** each reported before and after on the same harness:
  - **O1:** scoped queries instead of full snapshots
  - **O2:** a prepared-statement cache
  - **O3:** moved to measure-first as M10 (the P2 review; `synchronous` stays FULL, the WAL default)
  - **O4:** passages and contentless passage FTS (B2, B7)
  - **O5:** `text_hash` so text judgments survive submission changes
  - **O6:** extraction cached by file hash
  - **O7:** job kinds and priority (B1)
  - **O9:** one Jev request per state
  - **O11:** Canvas throttling (built)
- **Measure-first,** with their adopt and kill numbers:
  - **M1:** Canvas concurrency
  - **M2:** watermarks (A4)
  - **M3:** contentless-delete passage FTS: **adopted, measured 2026-09-26** in the P2 review (B7). External content was rejected, because `passages` holds offsets, not text
  - **M4:** `mmap_size`/`cache_size`
  - **M5:** embeddings
  - **M8:** Canvas GraphQL batching (adopt at −40% request cost)
  - **M9:** ETag/304 on Canvas REST (adopt if any endpoint returns 304)
  - **M10:** `synchronous = NORMAL`: adopt if commits are ≥5% of the wall time of a user-visible path on MT1 (the drain, a practice answer write); kill otherwise. Ingest already commits once per batch, so NORMAL would save about 46 ms of 66 s at 5,000 resources (inferred, P2 review), and FULL protects student-authored rows (attempts, corrections, day plans, the ledger)

**B4. Storage stays small:**
- Full text only for course materials.
- Mail is subject, gist, facts and link (A3); news is gist + link.
- Recordings are a link + caption segments, when captions exist.

**B6. Benchmark against public-facing tools, with targets fixed before anything runs.**
- **Compared: NotebookLM (Gemini Notebook) first.** Then whatever else can be measured when it's built:
  - Open Notebook, self-hosted with **the same model as ours**
  - Quizlet
  - ChatGPT or Claude Projects
  - any Canvas-integrated AI tool UW offers (not verified)
- **NotebookLM's own token use can't be observed,** so the architecture comparison also runs a **NotebookLM-style long-context baseline**: every scoped source placed in context, on the same model as ours.
- **The model each tool uses** is recorded per run.
- **Same material for all:** one MIT OCW course imported locally, plus the operator's own course (locally only; published results are aggregate).
- **The public tools are timed by hand,** following a written protocol: the same **30 questions**, the same order, and a stopwatch or screen-recording timestamps. Scraping their UIs is out.
- **Comparative rows (claims are made only from these):**

  | Metric | Our target, fixed now | Compared against |
  |---|---|---|
  | Manual steps to get a course in | **0 after sign-in** for Canvas content; D41's optional "Connect this course" clicks are counted and published | uploads per source (NotebookLM, Open Notebook); set creation (Quizlet) |
  | Sign-in → first course map (5 courses) vs hand upload of the same sources | **ours faster**; measured in MT7b, since it needs the course pass | the hand-upload time, per tool |
  | Grounded answer end to end, p50 and p95, 30 questions | **p50 ≤ Gemini Notebook's**, and p95 reported | Gemini Notebook, ChatGPT or Claude Projects, Open Notebook |
  | On-demand 10-question quiz, time to first question | **≤20 s**, and ≤ NotebookLM's | NotebookLM quiz, Quizlet Learn |
  | A new Canvas item visible, while the student is present | **dated item ≤5 min; undated material ≤15 min** (T33, T25; plan D37) | a manual re-upload in every other tool |
  | Model tokens per grounded answer and per 10-question quiz vs the **NotebookLM-style long-context baseline** on the same model | **≥50% fewer**, with claim support within 5 points and quote validity no lower | the long-context baseline (our run, labelled as such) |
  | The same, vs **Open Notebook on the same model** (token use read from OpenRouter) | **≥30% fewer**, at the same quality bar | Open Notebook, same model |
  | Valid items per 1,000 tokens (after all checks) | reported, and compared on the same model | the long-context baseline, Open Notebook |
  | Price to the student | the operator's decision: **Free and open source with their own keys** (their AI; an OpenRouter key also pays Jev through `typesafe/jev-router`); **$5 lifetime** for our hosted Jev service (early adopters) (open: H1, see plan §9) | NotebookLM free / AI Pro $19.99/mo; Quizlet free / Plus $35.99/yr |
  | Model spend per term on the student's own keys | the ledger's measured tokens × list price, per route | the same tasks on the long-context baseline |
  | Local data and purge | complete purge, verified by the enumerated-table test; data stays on the device | hosted tools: their stated retention |

- **Internal rows** (reported, never claimed against others): local query ≤15 ms p95 through the store API at 5,000 resources (the P2 review's target; contentless OR + BM25 measured 5.1 ms p95 in its spike); precomputed artifacts served instantly; tokens against our own agent-loop ablation (MT6); our Jev cost per student (private).
- **Quality, reported beside speed and cost:**
  - quote validity: 100% by construction, checked
  - claim support, from a human sample
  - item correctness on a seeded-error set
  - scope accuracy against the student's labels
- **Rules:** paired comparisons, raw counts, the git SHA and versions, and **the rows we lose published too** ([benchmarking](../../notes/benchmarking.md)). A missed target is reported as missed, and its claim isn't made.

**B7. Efficient retrieval over compressed storage** ([plan D46](plan.md); the operator: "efficient in cost and time retreival and smart compressed summary storage"). Status: the P2 decisions are taken and measured in spikes; T11a and T11b (contentless passage FTS with not-found) are built in the data lane, not integrated; the summary tier is proposed.
- **One record per material** (plan D35.1), all on the same keys and rebuilt only when the text hash changes:
  - its item card (T20)
  - the analyzers' findings, in `material_facts` (T57)
  - passages with offsets (T11)
  - its place in the inventory (D32)
- **Store or link** (plan D40): text-bearing content is stored as passages. Tools and platforms that need their own login are link cards that open in the default browser.
- **A summary tier per material,** in `material_summaries`:
  - a gist of at most two sentences, key facts each carrying the passage offsets they came from, the heading outline, and a token estimate
  - **built by code first, at 0 tokens:** headings, each section's first sentence, the analyzers' definitions, formulas and dates
  - an optional **abstractive gist** from a batched background pack, within the background budget and consent; every fact in it is quote-checked, and a failed one is dropped
  - rebuilt only when the material's text hash changes
- **Compressed context first, passages on need:**
  1. typed lookups for known scopes (plan D3)
  2. the summaries of the scoped materials: the "cached summary" of D3's context levels, used for Also useful
  3. passages only for Core materials within the pack's budget, or for what the model asks for through `need` (D4)
- **Passage search** (the P2 review's decisions, `research/piece-P2/synthesis.md`, "Operator decisions" 1–3, applied by the data lane):
  - `passage_fts` is FTS5 contentless-delete (`content=''`, `contentless_delete=1`) with rowid = `passages.pid`, tokenizer `porter unicode61 remove_diacritics 2`
  - excerpts of at most 240 characters are cut in code from the version text by offsets
  - `resource_search` is dropped in v6, and resource-level search groups passage hits
  - questions: stopwords removed, OR, BM25, `LIMIT` ≤20, one query per page of results
  - **the term-coverage gate:** not-found when the top hit covers fewer than half the query's content terms, calibrated on the labelled set. OR returned at least one hit for all 24 of MT1's queries, so OR alone can never say "not in your materials"
  - `synchronous` stays FULL unless M10 adopts (B5)
- **Measured (spikes in the P2 review, 2026-09-26, 5,000 resources):** the FTS content copy was 24.2 MB of a 78 MB database (31%), which contentless removes. Contentless OR + BM25 ran p50/p95 0.9/5.1 ms against 1.2/5.6 ms. Targets: ≤15 ms p95 through the store API (N1). Tokens per grounded answer with summaries first against passages only: an MT6 ablation row.

## Part C. Understand and map (the core, done right)

**C1. Code first, per item:**
- the structure Canvas gives: module, position, type, dates, assignment group, points
- explicit links: exact URLs, file references in assignment text, module membership
- lecture numbers and dates in titles
- recording dates

**C2. Jev item card** per new or changed item that code couldn't classify: role (a two-level Choice), substantive, candidate session, topics, exam prep.
- All of an item's questions go in **one** batched gateway request.
- Results are cached by content hash, so an item is never recomputed unless it changes.
- **Gateway limit:** the gateway today serves one question, with defaults of 20 calls a day per device and 100 a day in total (`apps/gateway/src/gateway.ts`). Item cards need versioned endpoints and limits sized to the operator's budget; this is a gateway change (plan D16).
- **Until then:** items queue by priority (upcoming assessments first), and the course pass (C3) runs on structure alone.

**C3. One quick catered pass per course, on the student's AI,** when code and Jev leave language to interpret.
- **Where that happens:** scope statements ("Midterm 2 covers everything since the first midterm, except the guest lecture"), schedules in PDFs or external sites, and the ranking of materials.
- **One call** gets a compact course manifest (one line per item: ID, type, title, module, position, dates) plus the syllabus, schedule pages and assessment texts. The syllabus comes out of it as the course's checked brief (plan D34) (open: H6, see plan §9).
- **It returns, in a strict schema:**
  - sessions (date → topic)
  - units and topics
  - each assessment's scope (stated: quote + source, or an inferred window)
  - each assessment's and assignment's mapped materials, **each with a tier and a one-line reason**
- **Models:**

  | Student's AI | First pass | If code's checks fail |
  |---|---|---|
  | Claude | **Sonnet 5** | Opus 5.5 |
  | Codex | **GPT-6 Sol** | Sol at high effort |
  | Gemini | **Gemini 3.5 Flash** | Gemini 3.1 Pro |

  Why Sol over gpt-5.6-terra: terra is older and costs more ($2.50/$15 against Sol's $2/$10).
- **Code checks every claim:** quotes verbatim in their source; IDs exist; dates inside the term; week and lecture ranges re-resolved in code. A failure retries once with the errors, then escalates, then is kept as **provisional** with its quote, never turned into a question for the student (plan D33).

**C4. Jev links the rest.** For each upcoming assessment, candidates the pass didn't place (built by code from dates, sessions and topics, capped at 30) get one Noul each, and the result is applied as settled (open: H4, see plan §9). The candidates reuse the team's fuzzy supporting-material proposals where they exist (§2).

**C5. What the student sees: not too much, not too little.**

| View | Shows | Caps |
|---|---|---|
| **Assessment dossier** | date, format, weight, the stated scope with its quote (or "not stated by the instructor"); **Core**, **Also useful**, **Practice** (past exams, quizzes, problem sets) | Core ≤8, Also useful ≤6, Practice ≤5, each with its reason. Everything else in scope sits under a collapsed "All in scope (n)" |
| **Assignment work view** | the spec, the rubric, and the lectures and readings it builds on | ≤5 resources, plus the tools to open |
| **Module view** | items grouped by session, with a role tag | no auto-summaries unless asked |
| **Home, Study & Learn** | concrete, already-chosen activities (the Home direction) | ≤3 |

- **Ranking when a tier overflows:** tier, then rung (student > code > pass > Jev), then how close the item's date is to the assessment.
- **The floor:** if Core is empty, for example when Jev is down and the pass ran on structure alone, the dossier says "Scope not stated by the instructor" and shows the top 5 items by date window as **provisional**.
- **Tuning:** the caps live in the versioned configuration. `ui_events` records expansions and tier moves; when a view's expansions pass a set rate, the configuration raises that cap (T22).

**C6. Settled, not confirmed** (plan D33: no required student input) (open: H4, see plan §9).
- The system settles each assessment's scope from checked evidence and shows it with its quote. The student may correct it in one click, but is never asked to confirm.
- A settled scope, and above all a corrected one, is truth. Later changes, such as a new announcement, a new module or a TA email, show as **"2 new materials may belong to Midterm 2"**, never as a silent rewrite.

**C7. Incremental mapping:**

| Change | What runs |
|---|---|
| a new item | its card (C2), then candidate links (C4) for upcoming assessments |
| a new scope statement, or a changed assessment | the pass (C3) **for that assessment only**: a small call |
| a new module | session and topic attachment by code, then Jev |

## Part D. The notebook in the app (NotebookLM- and Open Notebook-inspired, positioned to outperform)

**D1. A notebook per course, built automatically.** The course page in the left sidebar is the notebook:
- **Sources:** everything synced, organised by module and session.
- **Notes:** the student's own notes, plus the code-built `.docx` tree.
- **Studio:** generated study artifacts.

No uploads are needed. Gemini Notebook needs manual sources, with up to 50 per notebook on the free plan. Its Canvas import (Gemini LTI) needs a Workspace for Education account, admin enablement and instructor setup, so an individual student adds sources by hand (`research/validation/competitors.md`, private: "Gemini LTI currently only supports Instructure's Canvas…"). Open Notebook also needs manual sources.

**D2. The assessment dossier is a scoped notebook.** Chat and Studio default to that assessment's settled materials (C5).

**D3. Context levels per source,** after Open Notebook's "FULL CONTENT / SUMMARY ONLY / NOT IN CONTEXT", set automatically by scope and budget:
- Core → full passages within the budget
- Also useful → the material's stored summary (B7)
- the rest → off

The student can change any of them.

**D4. Chat with checked citations.**
- It answers only from the scoped sources. Every citation is a verbatim quote **checked by code** against the exact source version, with page, slide or recording time.
- "Couldn't find support in what I searched" is a valid answer.
- NotebookLM "uses direct quotes… as citations", but they aren't independently checked. Open Notebook's own README lists its citations as "Basic references (will improve)".
- Retrieval is run by the app: code assembles the context, and the model may request up to 3 typed lookups through a `need` field. At most 2 rounds per turn, with no tools given to the model.
- A "Learning guide" style (Socratic, one question at a time) follows the learning spec.

**D5. Studio, as prompt packs (Open Notebook's "transformations" made course-aware).** The artifact catalogue and what transfers from Open Notebook are in the team's [Open Notebook artifact inventory](../../notes/open-notebook-artifacts.md) (on `northcutt-frontend`, not yet on `main`). Packs carry a version. Open Notebook's transformations are prompt templates; whether they're versioned wasn't established ([open-notebook](https://github.com/lfnovo/open-notebook), `docs/3-USER-GUIDE/transformations.md`).

| When | Artifacts |
|---|---|
| In the build | flashcards (FSRS), items for Learn, Write and practice quizzes, the practice exam (tiers T1–T4), study guide and briefing, the FAQ (T74) and the code-built timeline (T66), rescope, the mail digest, the code-built concept map, Notes, and an **audio overview** played with the operating system's local speech voices, so no text leaves the device for speech (T52) |
| In the build | **packs the student writes and saves** (Open Notebook's transformations): versioned, checked like ours, and run on the student's AI (T56) |

- **The concept map** is built by code from `learning_concepts` and sessions. It needs no model call.
- **Every artifact:**
  - is scoped to a settled scope
  - is precomputed for assessments due within 14 days (the learning spec's window), with consent
  - is cached by input hashes
  - cites its sources
  - keeps a card only if its quote verifies

**D6. Where things surface, following the Home direction:**
- **Briefing:** changes and preparation, with source links, including relevant professor and TA emails.
- **Upcoming:** opens the assignment work view's resources together.
- **Study & Learn:** ≤3 chosen activities.
- **Today:** lectures, events, the day plan and today's study sessions, from the unified schedule (D8).
- **Mail:** inside the course pages, the Briefing and Today, not its own tab (A3).

**D7. Notes, organised and managed by the system** ([notes](../../notes/notes.md), [notes targets](../../notes/notes-targets.md)).
- **Built by code:** a `.docx` folder tree per term → course → {Lectures, Assignments, Exams, Readings}, one templated note per session, assignment, exam and reading. It's built with the `docx` package (MIT) and **kept current by the system**: a new lecture gets its note file, pre-linked to its sources.
- **Linked both ways:**
  - every note links to its Canvas items and passages
  - the notebook shows each session's note, and opens it in Word, Pages, LibreOffice or Google Docs
- **Where notes go:**
  1. a local folder (the default; no approval)
  2. a detected Google Drive or OneDrive sync folder (offered; no approval)
  3. **optionally**, the Google Drive API (`drive.file`, non-sensitive) or Microsoft Graph, each behind its own consent screen

  It's the only notes prompt, and only for students who want notes in the cloud.
- **Jev** picks the template per session type (lecture, discussion, lab, reading, worked problems). **The student's AI** optionally pre-fills the outline, with checked quotes.
- **Negatives:**
  - a note the student edited is never overwritten (edits are detected by hash; a new version is written beside it)
  - the app stores only each note's path and hash

**D8. One unified course schedule** ([plan D47](plan.md); the operator: "an integrated and connected course schedule"). One timeline serves the Calendar view (Ben's week and month views on `main`), each course page and the Today rail. Status: proposed; most inputs already exist.

| Entry | Where it comes from | Code or judgment |
|---|---|---|
| Canvas due, lock and event dates | Canvas fields | code |
| Exams and dates stated in prose | the team's deterministic extraction, with a literal span per claim and its tiered resolver (Canvas `due_at` authoritative, an announced change shown as a conflict, title dates lowest), on `integration/backend-features`, pending merge; the course pass (C3) only for what it can't read, such as PDF schedules | code first; the pass's dates are re-resolved in code |
| Calendar feeds: the Canvas ICS, `today.wisc.edu`, the Outlook calendar ICS | the calendar connector; the Today rail's `setOutlookCalendar` on `main`; recurring events expanded within a bounded window (the team's work, pending merge) | code |
| Dates moved by a professor's or TA's email | D44's extracted facts; Jev picks which assessment; a mismatch with Canvas shows as a conflict (A3) | code, then Jev |
| The day plan | Sean's `dayPlan` from the Today rail (a local `preferences` entry, 14 days; the Today rail, PR #2) | the student's own entries |
| Planning: enrollment windows, appointments, holds | the planning adapters on `main` | code; **local only**: never to AI, Jev, MCP or the data platform (F3) |
| Study sessions | FSRS reviews due (N14) and the prep list (H6), placed before each assessment's real date, around the feeds and the day plan; missed topics return 1–2 days later (successive relearning) | code, 0 tokens |

- **One query:** `timeline(from, to, courses?)` returns entries with their provenance (source, version, and quote or field) and any conflict. Dates stay in code.
- **Study sessions are proposals.** The student can move or drop one, and a moved session is saved as a day-plan entry. There's no notification, no streak and no "you missed" copy (D20, the P16 lint).
- **Nothing is written back** to Canvas or Outlook.
- **Negatives:** a conflict is never resolved silently; planning entries never appear in any hosted payload; an entry never lacks its source.

**D9. The command bar and dictation** ([plan D40](plan.md), [plan D43](plan.md)) (open: H7, see plan §9). Status: proposed.
- **The command bar** (D40): **Ctrl+K / ⌘K** opens it for chat and commands, as the operator uses it ("control k which is chat"). Code resolves a command first (open a source, "quiz me on …", make cards for a scope, what's due). Only what needs language goes to the student's client, as text.
- **Dictation is microphone input into the command bar only.** The operator: "not voice mode like speaking model with voice that plays, but the ability to microphone input in commands". There's no text-to-speech reply and no voice mode, and audio is never stored or sent anywhere.
- **The shortcut:** **Ctrl+Shift+Space** on Windows and **⌘⇧Space** on macOS, in the same modifier family as Ctrl/⌘+K (the operator: "should be a short cut, something that makes sense other than control k which is chat").
  - Hold to talk, and release to stop. A tap toggles for longer dictation. Esc cancels. A mic button in the bar does the same.
  - In-window only, never a global hotkey. Rebindable in Settings.
  - Not reserved by either OS (checked 2026-09-26). macOS reserves ⌘Space (Spotlight), ⌘⌥Space (Finder search), ⌃Space and ⌃⌥Space (input sources), ⌃⌘Space (Character Viewer) and Fn-D (dictation) ([Apple, Mac keyboard shortcuts](https://support.apple.com/en-us/102650), published 2026-09-14). Windows reserves Alt+Space ("Open the context menu for the active window"), Win+H (dictation), and Win+Space, Win+Shift+Space and Win+Ctrl+Space (input languages) (Microsoft Support, "Keyboard shortcuts in Windows").
- **The transcript is shown in the bar, editable,** and runs only on Enter, exactly like a typed command.
- **Local speech-to-text:**
  - **sherpa-onnx** (Apache-2.0; `sherpa-onnx-node` 1.13.8, 2026-09-10; a Node addon or WASM) with a **Moonshine** English model or a **Whisper** model. Moonshine is MIT for its streaming and English models; its legacy non-English models are non-commercial and aren't shipped. Tiny is 34M parameters, 32 ms on a MacBook Pro by the maintainers' benchmark. Whisper's weights are OpenAI's, and their licence is checked at adoption.
  - **whisper.cpp** v1.9.3 (2026-08-20, MIT) is the alternative engine.
  - **Course-vocabulary biasing** (topic names, course codes, assessment names): the engine's own biasing option where it has one, checked in the spike; otherwise a code pass that snaps near-misses to course terms.
  - **Rejected:** Electron's `SpeechRecognition`, which fails with a network error in Electron ([electron#46143](https://github.com/electron/electron/issues/46143)); Claude Code's voice dictation, which "streams your recorded audio to Anthropic's servers for transcription" ([voice dictation](https://code.claude.com/docs/en/voice-dictation)) and isn't callable by a third-party app; Codex, which removed its TUI voice transcription ([openai/codex#16114](https://github.com/openai/codex/pull/16114), 2026-03-28).
  - The OS's own dictation (Win+H, Fn-D) already types into the bar. Ours adds on-device recognition and the course vocabulary.
- **Permission:** asked on the first press only. On macOS, `NSMicrophoneUsageDescription` plus `systemPreferences.askForMediaAccess("microphone")`. The session permission handler grants `media` only to the app's own renderer, never to UW, Canvas, Outlook or any external page.
- **Measured, with thresholds fixed now (D22),** on a synthetic set of at least 300 academic command phrases (course codes, topic terms, "quiz me on …"), read by at least three team members and kept in `.data/`, with no real course content:
  - adopt an engine only at **WER ≤8%** overall and **≥90% of course terms correct** with biasing
  - **latency:** release to transcript **p95 ≤700 ms** for utterances up to 8 s on the Windows laptop, CPU only; the first press after launch loads the model in ≤2 s
  - **footprint:** a model of ≤300 MB on disk, and peak memory ≤500 MB
- **Priority:** after the core study features (plan D19). The mic's place in the command bar needs Ben's comparison: `docs/decisions.md:40` lists "floating pill/voice activation" as still open.

## Part E. AI execution

**E1. Prompt packs.** Each is a versioned file with:
- inputs (a graph query)
- budget
- system prompt
- template
- schema
- code checks
- Jev gates
- tier
- cache key

**The packs:** course pass, rescope, flashcards, quiz, practice exam, study guide, FAQ, explain/chat, grade free response, mail digest, material summaries (B7).

**E2. The runner.** One `ModelRunner` spawns the student's CLI in a per-course folder the app owns, with the app's isolated client profile (E6). Status: integrated (T12, merge `efc6604`).

| Client | Call |
|---|---|
| Claude, one-shot (the fallback) | `claude -p --output-format json --json-schema … --tools "" --strict-mcp-config --setting-sources project,local --no-session-persistence` |
| Claude, warm session (plan D38) | `claude -p --input-format stream-json` (stream-json output) `--system-prompt-file <our prompt> --tools "" --json-schema …`; turns queue in one process |
| Codex | `codex exec - --json --output-schema … --ephemeral -s read-only --ignore-user-config` |
| Gemini (API key only) | `-o json`, with zod validation and one retry |

- **Never** `--dangerously-skip-permissions`, and never `--bare` on a subscription (bare mode "doesn't use your subscription login").
- **Keys:** a stored key is passed only as the spawned process's environment (E6). An OpenRouter key drives Claude Code as `ANTHROPIC_AUTH_TOKEN`; whether it also reaches OpenAI and Google models through Claude Code is unverified (E6).

**E3. Tiers:**

| Tier | Claude | Codex | Gemini | Used for |
|---|---|---|---|---|
| Jev | all typed judgments (item cards, links, mail areas, gates) | | | |
| Pass | Sonnet 5 | GPT-6 Sol | Gemini 3.5 Flash | course pass, rescope, flashcards, quiz, digest, grade free response |
| Strong | Opus 5.5 | GPT-6 Sol (high effort) | Gemini 3.1 Pro | escalations, practice exam, study guide, explain |

- GPT-6 Luna only takes typed classification if Jev is unavailable.
- **Detected, not assumed:** onboarding probes which models the student's plan serves.

**E3b. Fully local mode** (AGENTS.md: "Fully local mode blocks hosted Jev too"):
- the runner uses the existing local adapter (`packages/ai/src/local.ts`, Ollama)
- mapping runs code-only, with the floor rule (C5)
- item cards and links are skipped

The student sees "local mode: scopes are proposals by date".

**Ollama as the fallback isn't local mode.** When no client is found, Ollama runs generation (plan D40), but Jev stays on unless the student chooses local mode. That's shown as a mixed configuration (`docs/ai-and-privacy.md`).

**E4. Onboarding: "Your AI" first, then UW** ([plan D45](plan.md); the operator: "the onboarding process should open to a menu that is professional and intuitive … Starts with auto detecting client and wrapping it"). The screens follow `DESIGN.md`; anything beyond its recipes is (open: H7, see plan §9).
1. **Welcome, then "Your AI".** The app detects Claude Code, Codex and Gemini CLI with local `--version` checks only. There's no network request, so this is allowed before consent. Each client gets a tile: installed, with its version, or not installed, with an install link. (On the operator's laptop, 2026-09-26: Claude Code 2.1.283 and Codex 0.156.1 found; Gemini CLI not installed.)
2. **The student picks a client and sees that provider's consent:** the recipient, purpose, data categories, provider settings, how to revoke, and the usage line (open: H5). Agreeing records the consent for that provider (G1).
3. **The app creates its isolated profile for that client** (E6) and opens a **built-in terminal pane**: a separate, unmodified client session in that profile. The student signs in there through the provider's own flow (`/login` or `claude auth login`), and the app confirms with `auth status` run in the profile.
4. **Then the UW step:** the setup checkbox (Jev, the UW session note, the Canvas page-view effect; G1), then NetID and Duo. Canvas connects, and the retrievers populate the database.
5. **In the background:** the model probe (which models the plan serves) fills the tier table (E3).
- **No client:** the "Your AI" step offers a key (E6), Ollama if installed (plan D40), or "Continue without AI". Study, and mapping by code and Jev, still work; generation waits.
- **Status:** T40's detection, auth status, engine choice and model probe are integrated (merge `efc6604`). The profile, the terminal pane and this step order are being built on `wave-b/T80` and `wave-b/T81` (T80, T81), not yet integrated. node-pty and xterm.js are verified before either is adopted.

**E5. The ledger** records every call: pack, version, tier, model, tokens in, cached and out, latency, check failures, escalations, and the student's later edits.

**E6. The student's own client, configured by the app** (plan D35, D36, D38, D45: this is the one canonical section; the plan entries keep the reasons). The operator: "skills and tools harnessed to the users client configured by our system"; "intelligently wraps to their subscription client and doesnt require additional usage credits".
- **Which client:** detected (E4), in the order Claude Code, Codex, then Gemini by API key. The choice shows in Settings and can be changed; beyond the onboarding pick, it's never a prompt. Ollama is an optional setting and the fallback when no client is found (plan D40). With Jev still on, that's a mixed configuration, labelled as such, not local mode (E3b).
- **An isolated client profile, owned by the app** (plan D45):
  - Claude Code runs with `CLAUDE_CONFIG_DIR=<userData>/clients/claude`. The env-vars reference: "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path." Per the authentication docs, the login lives under that directory, and on macOS the Keychain entry is keyed to it, "so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" ([env vars](https://code.claude.com/docs/en/env-vars), [authentication](https://code.claude.com/docs/en/authentication)).
  - **The lead's spike, 2026-09-26:** with an app-owned `CLAUDE_CONFIG_DIR`, `claude auth status` reported "Not logged in", only `.claude.json` and `backups/` were created there, and the modification time of the user's `~/.claude` didn't change.
  - Codex gets the same pattern through `CODEX_HOME`, which the build verifies first. Gemini follows later.
  - **The student's own `~/.claude`, `~/.codex` and other global settings are never read or edited, and no credential file is ever read.**
- **What the app writes into its profile and per-course folders** (`<userData>/courses/<course>/`):
  - **the context file each client reads:** `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, `GEMINI.md` for Gemini. "Claude Code reads CLAUDE.md, not AGENTS.md" ([memory docs](https://code.claude.com/docs/en/memory)). It holds the course brief (D34, open: H6) and the pack instructions.
  - **a skills pack:** the pack instructions as the client's skills, in the app's profile (the location is checked per client in the P9 spike)
  - **the course bank for that session:** Claude's `--mcp-config <file>` with `--strict-mcp-config`, or `claude mcp` registration inside the app's profile; `codex mcp add` ([openai/codex#3543](https://github.com/openai/codex/pull/3543)) inside the app's `CODEX_HOME`
  - the chosen sources for the run
- **Two uses of one profile:**
  1. **The app's own runs,** headless, with tools off: the model gets no MCP or other tools inside the app (plan D5). The flags are in E2 ([CLI reference](https://code.claude.com/docs/en/cli-reference): stream-json turns queue, `--system-prompt-file` replaces the default prompt, `--tools ""` disables all tools, `--json-schema`).
  2. **The student's own session** in the built-in terminal (E4): the unmodified client in the app's profile, where the student signs in and can use the course bank and the skills pack ("a mod", plan D36). That's the student's own use.
- **The warm session pool** (plan D38): an interactive lane per open course, one background lane rotated per task batch, and an escalation lane on demand. Our system prompt replaces the default (11.3k → 2.8k fixed tokens, measured on this laptop). One-shot calls are the fallback, and Codex stays one-shot (its app-server is experimental and unmeasured, spike S9). Status: integrated (merge `efc6604`); spikes S1–S10 decide whether it becomes the default.
- **Anthropic's conditions** (`code.claude.com/docs/en/legal-and-compliance.md`, re-read by the lead 2026-09-26):
  - "preinstalling or running Claude Code in your products or services … requires agreeing to our Commercial Terms of Service and complying with the conditions below". The team accepts them before any public release (the operator's say).
  - "The Claude Code binary must not be modified." The app sets only environment variables and flags.
  - "Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential." The student signs in through Anthropic's own flow (`claude auth login`, with `--console` for API billing; CLI reference).
  - The product name must not be "Claude Code" or "Claude Code Agent" ([Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)).
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage."
- **What's prohibited, precisely.** The lead read the clause from the page bytes: "collect, store, or intermediate" covers **Claude.ai credentials or session tokens**, not the student's own API key. So:
  - the app never reads, stores or routes Claude.ai credentials or session tokens. The client's own login sits in the app-owned profile, written by the unmodified binary, and the app never reads it. Whether hosting that directory is itself "storing" is part of H5.
  - **a student's own API key, billed to the student, is allowed:** stored encrypted by `safeStorage`, passed only as the environment of the process the runner spawns, never written into a config file, log or git, and sent nowhere except its provider.
- **The routes:**
  - **The key route, the verified path:** the student's own Anthropic, OpenAI, Google or OpenRouter key. An OpenRouter key drives Claude Code as `ANTHROPIC_AUTH_TOKEN` ([OpenRouter's Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)). Whether one OpenRouter key covers OpenAI and Google models through Claude Code is unverified; on our direct API route, one OpenRouter key covers every model.
  - **The subscription route (open: H5, see plan §9):** the operator's wording, "runs on your own Claude or ChatGPT plan's normal usage limits; no separate credits". Codex on a ChatGPT plan has no documented arrangement for third-party apps (openai/codex#36886, open). Nothing about it is promised publicly until H5 is settled and the route is verified (`AGENTS.md:32`).
  - **Gemini: API key only.** "Directly accessing the services powering Gemini CLI … using third-party software, tools, or services … is a violation of applicable terms and policies" (gemini-cli `docs/resources/tos-privacy.md`).
- **The background lane:** a visible setting, within the background budget, in the ledger run by run, and at student scale (about 540 calls a term, inferred in the architecture review §4).
- **Negatives:** never `--dangerously-skip-permissions`, which its help recommends "only for sandboxes with no internet access"; never `--bare` on a subscription; no credential file read; the student's global settings never edited; no tools for the model inside the app.

## Part F. Secondary: the optional MCP course bank, remote access and the open data platform

These **never drive app features.**

**F1. The course bank.**
- **Opt-in:** registered for the student's own sessions inside the app's isolated client profile (E6): `claude mcp` or `--mcp-config`, and `codex mcp add` ([openai/codex#3543](https://github.com/openai/codex/pull/3543)) inside the app's `CODEX_HOME`. The student's own global settings are never edited; the registration runs with consent (G1).
- **Tools:** `courses`, `course`, `upcoming`, `assessment`, `materials`, `search`, `get`, `changes`. They're compact, capped, grant-checked and receipted. Output passes the identity scrubber (G1).
- **Resources and prompts:** `@` resources for courses and assessments, and pack instructions exposed as MCP prompts.
- **The shared code is the handlers:** these tools and the app use the same handlers in `packages/agent-api`, but the app calls them in-process.
- **When the app is closed,** the entry point starts the read-only reader itself and serves the last sync, with freshness stamps.
- **Status:** `main` has six local stdio MCP tools with per-client grants, live revocation and receipts (`docs/implementation-status.md`); the handler move (T50a, T50b) is proposed.

**F2. Remote access for web and phone** (a setting, off by default).
- **Why a relay:** Anthropic's MCP connector says "The server must be publicly exposed through HTTP … Local STDIO servers cannot be connected directly" ([MCP connector](https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector)), so the laptop needs a public endpoint.
- **How it works:** an outbound WebSocket from the desktop to our relay, after the pattern of `mcp-local-tunnel` (its Streamable HTTP with OAuth 2.1 is confirmed; its licence, PKCE and protected resource metadata weren't, so our relay implements PKCE and protected resource metadata itself). The relay serves a per-student Streamable HTTP MCP endpoint, and access is approved in the desktop app.
- **Pass-through only:** it stores no content. When the laptop is asleep: "Your Magic Canvas desktop is offline."
- **Default grant:** deadlines, briefs and materials.
- **Probes RP1–RP3** (run in T00): whether Claude's mobile apps can use a connector added on the web, whether MCP App views render there, and ChatGPT mobile.

**F3. The open academic data platform** ([plan D42](plan.md); the operator: "an academic autonmous database layer for agentic operation that we open source as a platform for badger developers to build their own study tools"; earlier, "we emphasize the open sourced framework that lets any developer utilize our academic backend"). Status: researched and proposed. What exists on `main` is the MCP server and its grants (F1).

**What developers get:**
- **A versioned read contract.** Named, versioned SQL views over the one database (`v1_courses`, `v1_assessments`, `v1_scope`, `v1_materials`, `v1_summaries`, `v1_passages`, `v1_schedule`, `v1_cards`, `v1_reviews`, `v1_topic_levels`), opened read-only through the reader (plan D9). A typed SDK package, `@magic/sdk`, generates its types from the same contracts.
  - The client states the contract version it wants, and there's a schema handshake. The SDK sends `{contract: "1.x"}`; the reader answers with the supported range and the database's `user_version`, and refuses a mismatch with a clear error. A migration keeps the previous major version of each view.
  - Zotero's lesson: "production code should always request a specific version" ([Zotero Web API v3 basics](https://www.zotero.org/support/dev/web_api/v3/basics)). Logseq's DB version pairs a schema handshake with a migration contract (`github.com/logseq/docs`, `db-version.md`).
- **A read-only MCP course bank as the AI connector** (F1). The lesson from local MCP servers: default AI connectors are read-only, with approval for every mutation (e.g. `github.com/lstpsche/obsidian-mcp`).
- **Scoped, revocable tokens, one per tool.** Localhost is not authorization: "localhost alone is not authentication" (AnkiConnect's README). Obsidian's Local REST API uses one vault-wide token (`github.com/coddingtonbear/obsidian-local-rest-api`); we scope instead.
  - Tokens reuse the existing MCP grants: per client, per course and per category, stored as hashes, rechecked on every call, revoked live, with a receipt per call.
  - They gain a scope set (read, write-artifacts) and an expiry. Public reads, private reads and writes are separate scopes, as in Zotero.
  - The transport is the reader's local socket, not an open TCP port.
- **A narrow, atomic write path, only for student-owned artifacts:** decks, cards, notes and study records (reviews and attempts made in an outside tool).
  - Each write is one named action (`deck.create`, `card.add`, `card.edit`, `note.save`, `review.record`), validated by code with the same checks as ours: a card that cites a source must carry a quote that verifies. Explicit, auditable mutation actions are AnkiConnect's model; Obsidian's `process(file, fn)` "Atomically read, modify, and save" is the atomicity model ([Obsidian Vault API](https://docs.obsidian.md/Reference/TypeScript+API/Vault)).
  - Each write lands in `platform_writes` with a before-image and a receipt, and can be undone.
  - Write scope is off by default, and granting it is an approval in the desktop app, per tool.
  - **Never:** a school action (submit, enrol, post, complete); a write to evidence or coursework (resources, versions, passages, the course map, judgments); planning data, which is **never exposed at all**, not even to reads.
- **The identity scrubber applies to anything leaving the machine** through the platform: the team's known-identity scrubber on `integration/backend-features`, pending merge (G1).
- **Published limits and separate secrets:** rate limits are published per token, as Readwise does (`readwise.io/api_deets`); tokens and keys live in OS-encrypted storage, apart from data, as Raycast separates secrets (`developers.raycast.com/information/security`).
- **Developer docs and one example tool:** the contract reference, the SDK guide and "build your own study tool", with one example that reads an assessment's scope and topic levels and writes a deck through the write path (T55).
- **The framework packages:** `contracts`, `storage`, `retrieval`, `connectors`, `agent-api`, `runner`, `packs/core`, `@magic/sdk`, and the `magic` developer CLI. **Boundary test:** they build and test with zero imports from `apps/desktop`, `apps/gateway` or licence code, and a sample connector plugs in with one new file.
- **Licence:** MIT (business model).

## Part H. The study system: Quizlet-like practice, per-topic understanding, mastery by assessment

**The bar (the operator, 2026-09-26 late):**
- It's **a study tool first**; a game is at most second, and isn't a focus. No XP, no streak freezes.
- Like Quizlet, the student can **see which topic each question belongs to**.
- An assessment's quiz is **built from the chapters and modules assigned to that assessment, sectioned by them**, and based on the instructor's practice quizzes and assessment details where they exist.
- The system knows which questions were answered right or wrong. That changes the student's **level of understanding in each topic**, and a **progress bar shows the way to mastery of the assessment.**
- The student can **pick specific topics to be quizzed on**, as NotebookLM allows.

**H1. Adopted from the learning spec** ([notebook and study tracking](../2026-09-26-notebook-and-study-tracking/spec.md), [practice and insights](../2026-09-26-notebook-and-study-tracking/practice-and-insights.md)):

| Set | What it gives the student |
|---|---|
| ST-1–ST-4, ST-6–ST-12 | checked items only; Flashcards with FSRS (a pre-exam review); Learn (MC → typed); Test with fidelity tiers T1–T4; the mistakes queue; the session builder; optional confidence before the reveal; flag and replace; explanations quoting the source; practice works without the provider; a logged hint ladder |
| KM-1–KM-13 | the concept map per course; items tagged to 1–3 concepts; immutable evidence; a deterministic per-concept state (Elo-style, with hysteresis); the rules R1–R6 with reasons; the states Solid · Getting there · Iffy · Not seen yet; the state drives study; "Why?"; cold start; decay; separate self-ratings; a versioned configuration; purge. **KM-6 is amended by H4** |
| PI-9–PI-12, PI-14–PI-16 | Flashcards quality of life; Learn options; Write with contest; Test with an optional timer and exam conditions; stars and filters; card editing; the student's own cards linked to sources |
| PI-5 (its guard), PI-7, PI-17–PI-21, PI-24–PI-27 | no lockout ever (50 wrong answers in a row, and the next item is still served); quick study sessions sized to the minutes the student has; insights anchored to exact passages; a coverage map per assessment; states in insights; error patterns and confusable topics; **calibration** (confidence vs accuracy, from the confidence ratings kept in ST-8); what changed; local by default; no fake urgency; no guilt copy |
| PI-2 (its relearning rule) | topics missed in an assessment quiz come back 1–2 days later (successive relearning) |

**Dropped** (the operator: a study tool first, no XP, no freezes):
- ST-5, the Duolingo-like path
- PI-1, PI-3, PI-4, PI-6, PI-8: path, daily goal, streak and freezes, XP, notifications. PI-2's game framing is dropped; its relearning rule is kept.
- PI-13 Match
- PI-22 and PI-23: time on task, weekly digest
- PI-28, the engagement switches, which are moot

There are no leaderboards (PI-29).

**H2. Data model** (plan D17):
- **Topics:** `learning_concepts` is the course's topic table. Its origins are code, model and student, and student edits survive every rebuild.
- **Coverage:** `learning_coverage` is keyed to `assessments.id`, beside `map_links`.
- **Generation:** items and cards are generated by prompt packs, and the checked-item pipeline gates them.
- **Migrations and jobs:** one migration path and one job queue.

**H3. Assessment quizzes: sectioned by the assessment's chapters and modules** (new).
- **Sections** come from the assessment's settled scope (C5/C6): its chapters, modules and lectures, in course order. Each section lists its topics.
- **Every question shows its topic tag or tags and its source** (chapter, lecture, slide or page), so the student can see what each question tests.
- **Where questions come from,** best first (the fidelity tiers of ST-4):
  - **T1:** the instructor's practice quizzes or exams for this term, from files, pages, or quiz results the student can already see. **The app never starts a Canvas quiz attempt.**
  - **T2:** the instructor's assessment details (format, topics, allowed materials) plus the mapped materials
  - **T3:** past exams, labelled with their term
  - **T4:** course materials only

  The header says which tier the quiz used.
- **Length and weighting** follow the assessment's coverage weights, with at least one question per section.
- **Results** show right and wrong **by section and by topic**, with the missed questions linked to their source passage. Every answer feeds the knowledge model.
- **Negatives:**
  - A question never lacks a topic tag or a quote-valid source.
  - A T3 question outside this term's coverage is dropped.
  - No predicted grade is shown.
  - A Canvas quiz attempt is never started, and nothing is submitted.

**H4. Understanding per topic, and the mastery bar per assessment** (new; it amends KM-6) (open: H8, see plan §9).
- **A topic's level of understanding** is its state (Not seen yet · Iffy · Getting there · **Mastered**, the student-facing name for Solid) plus a **progress bar toward Mastered**.
  - **The bar:**
    `bar_c = 1` if the topic is Mastered (Solid); otherwise `min(0.99, min(c_c / 8, 1) · min(p̂_c / 0.75, 1))`, where:
    - `c_c` is the number of **unassisted correct** scored answers in the lookback window
    - `p̂_c` is the model's point estimate
  - **It moves with every answer:**
    - a right answer raises `c_c` and `p̂_c`
    - a wrong answer leaves `c_c` unchanged and lowers `p̂_c`, so the bar goes down
  - **After each answer,** a change marker shows the topic's move as a direction and a bar step, with no percentage (the P16 lint; `docs/product.md:32` "Never invent a readiness percentage").
  - **Full only at Mastered,** which also needs the band rules: `p_low`, retrievability, recall formats and no fired rule.
  - Every fired rule (R1–R6) shows as a reason beside the bar ("Missed Q4 after getting it right on 22 Sep").
- **An assessment's mastery bar** is the coverage-weighted average of its topics' bars, labelled with counts: **"Mastered 7 of 12 topics for Midterm 2"**. It shows the change after each answer as well.
  - Tapping it lists each topic with its level, reasons and the questions behind them.
  - The label says it's **"based on your answers in Magic Canvas, not a grade prediction."**
  - The thresholds live in the versioned configuration and are labelled unvalidated until the offline evaluation (P18–P21) passes its bars.
- **Right or wrong changes it:**
  - an unassisted right answer raises the estimate
  - a wrong answer lowers it and may fire R1, R3 or R4
  - hinted or explained answers don't count as evidence
  - recognition-only records can't reach Mastered (spec §5.5)
- **Negatives:**
  - No predicted score or pass probability appears.
  - The bar never reaches full without Solid.
  - A Mastered topic that lapses (R3/R5) visibly drops.
- **Team note:** the Home direction says "No invented mastery, readiness score, or completion claim" (`docs/home-design-direction.md:62`), and `docs/product.md:32` says "Never invent a readiness percentage". This bar is defined entirely by stated evidence rules, not invented. The word "mastery" and any numeric display are H8 (plan §9).

**H5. Quiz me on the topics I choose (like NotebookLM's custom quiz).**
- **Select:** any mix of topics or concepts, chapters or modules, lectures, an assessment's scope, and a filter (starred, missed, Iffy, Not seen yet). Then choose the mode (Flashcards, Learn, Write, Test), the number of questions and the difficulty.
- **Describe** (optional): typed text resolves by code first (ranges, filters, concept labels and aliases), then Jev for ambiguous matches, then the rescope pack. The resolved topics show as editable chips before starting.
- **The pool** is checked items tagged to those topics; when it's thin, the items pack tops it up.
- **Results** show right and wrong by topic, and each chosen topic's level before and after.
- **Negative:** a session never silently widens beyond the chosen topics.

**H6. What needs prep.** For an assessment or a whole course, topics are ranked by the priority function (urgency from the assessment date × (need + fired rules)). Each row shows its level bar, reasons, evidence counts and the coverage-map status of its materials. It's the same data as H4, ordered for study.

**H7. Study analytics, Anki-grade, computed by code at 0 tokens** ([plan D48](plan.md); the operator: "quizlets quiz and notecard tracking analytics, all unified"). Status: proposed; its inputs (N07, N14, P01) are built in the learning lane. The reference is Anki's statistics: reviews, the future-due forecast, card counts, review time, true retention, and FSRS stability, difficulty and retrievability ([docs.ankiweb.net/stats](https://docs.ankiweb.net/stats.html)). Ours groups them by what each exam covers.

| Statistic | Grouped by | Computed from |
|---|---|---|
| **Level** (the topic's state and its bar, H4) | topic; assessment | the knowledge model's evidence (N07) |
| **Accuracy** | module, chapter, topic; mode (Flashcards, Learn, Write, Test); instructor vs generated items | unassisted scored attempts |
| **Review forecast:** reviews due per day up to each assessment's real date, and the pre-exam review load | course; assessment | FSRS due dates (N14) against the unified schedule (D8) |
| **True retention:** the share of reviews passed when they were due | topic; course | the review log |
| **Stability, difficulty and retrievability** | topic (the median over its cards); card | FSRS state (N14) |
| **Time studied** | per session, in the session history (P14); per assessment in this view | session start and end times |
| **Calibration:** confidence against correctness | topic; course | the optional confidence ratings (ST-8, P14) |
| **The prep list** (H6) | assessment; course | the priority function |

- **Where it shows:** the course's Insights view and the assessment dossier, within the view caps. "Why?" on any figure lists the attempts or reviews behind it.
- **The mastery display (open: H8, see plan §9).** Specified now: the evidence-defined states Not seen yet · Iffy · Getting there · Mastered (Solid) and the counts label "Mastered n of m topics". **Open under H8:** the word "mastery" and any numeric or percentage display of the bars. Until H8 is settled, the bars render without a number and the change marker shows direction only (H4).
- **Negatives:**
  - no predicted grade, pass probability or readiness percentage
  - no streaks, daily goals, leaderboards or productivity comparisons (D20; the P16 lint)
  - time studied is history, never a goal. The per-assessment total narrows P14's "no time-on-task totals"; plan D48 records it for the lead to confirm
  - every figure equals a recomputation from the raw attempts and reviews (a replay test), and the ledger shows 0 model tokens

## Part I. Licence, payment and distribution (needed for the complete app)

- **I1. Licence activation** (open: H1, see plan §9). A licence key activates on first run and **enrolls the device with the gateway,** which the gateway already supports. There's no user account, and the Jev key never ships to clients.
  - **The payment provider is the operator's decision.** The researched options are in the business model: Lemon Squeezy, Polar, Paddle and Stripe.
  - Early-adopter slots are capped. A fair-use rule sits in the Terms.
- **I2. Signed installers:**
  - macOS: notarized, through the Apple Developer Program at $99 a year
  - Windows: code-signed (Azure Artifact Signing or an OV certificate)
  - Auto-update from signed releases
- **I3. Accessibility:** keyboard navigation for every mode, and WCAG AA contrast under the customizable shell colours.

## Part G. Privacy and legal

**G1. Consent at setup, then only what the accepted consent flow and the providers require** (T06, T81; `docs/ai-and-privacy.md` "Accepted disclosure flow"; the order is plan D45's).
- **Setup, in order** (E4):
  1. **"Your AI":** the student picks a detected client and sees **that provider's consent**: the recipient, purpose, data categories, provider settings and how to revoke. Agreeing records it. Detection before this uses local `--version` checks only, with no network.
  2. The student signs in to that client in the built-in terminal, through the provider's own flow.
  3. **The setup checkbox:** Jev as a recipient, the UW session note and the Canvas page-view effect. **One checkbox** agrees.
  4. The UW sign-in (NetID and Duo), then Canvas connects automatically.
- With no client chosen, step 1 records no provider consent, and nothing goes to a provider.
- **Afterwards:**
  - each request shows its selected sources as a non-blocking context chip and creates a receipt
  - the **first** request that would send a **new sensitive category** (student work, grades, comments, communications) shows one blocking preview
  - "always preview" is an option
  - **a new provider needs its own consent**
- **Provider-owned approvals, only when used:**
  - the AI tool's own login (or an OpenRouter key)
  - Microsoft's accept screen for Outlook
  - Google or Microsoft consent for cloud notes (D7)
- **Enforced in code:**
  - nothing reaches Jev or an AI provider before consent
  - planning data never leaves the device
  - local mode sends nothing
  - **student identities are removed from outgoing free text before any hosted send** (`docs/decisions.md`, "Identity scrubbing"): the team's known-identity scrubber and `validate-citations`, on `integration/backend-features`, pending merge, applied to Jev batches, packs, the course pass, D38's asks, the mail digest, the course bank and the data platform (T29). It removes known identities and identifier patterns only; it isn't anonymization, and unknown names in free text aren't detected (`docs/pipeline-details.md`)
  - the existing category permissions stay: grades and comments are off by default, each with its own opt-in, and the first-use preview comes in addition

**G2. Legal is written last, from legal research and expert application.**
- The Terms of Service, the Privacy Policy, and an in-app data notice showing what goes where for the chosen client and for Jev.
- Based on `docs/ai-and-privacy.md`.
- They cover: lifetime-deal fair use, UW rules (NetID, recordings for class use, FERPA framing), and each provider's terms.

## Non-functional requirements

| # | Requirement | Target |
|---|---|---|
| N1 | Screens read locally | ≤15 ms p95 through the store API at 5,000 resources (B7; the P2 review) |
| N2 | New Canvas item visible, while the student is present | a dated item ≤5 min after it's published, with ≤2 requests per hot tick; an undated material ≤15 min (T33, T25; plan D37). Until they land, the existing refresh gives ≤12 min |
| N3 | A course mapped | settled scopes ≤2 min after that course's syllabus, schedule and assessments are harvested |
| N4 | One-click artifacts | a precomputed one instantly; on demand, the first cards ≤20 s on the pass tier (measure) |
| N5 | Our cost | Jev only, within the operator's private estimate; a global abuse cap |
| N6 | Student cost | plan quota only on subscriptions (open: H5), or per-token spend on a stored key; the ledger shows use per action |
| N7 | Integrity | no quote, ID or date reaches the student unchecked by code; settled scopes never change silently; Jev never hides a message |
| N8 | Purge | zero rows left in every derived table |

## Out of scope

- Storing the NetID password without the student's opt-in, or anywhere but the encrypted local vault (plan D39).
- Automating Duo.
- AI browser agents in background sync.
- Scraping Handshake or WIN. (My UW is read only through the planning workstream's app-owned session adapters.)
- Exchange Web Services.
- A second database engine.
- Graph-RAG indexing: graph methods trail plain RAG by about 2–15 F1 on simple QA (arXiv 2502.11371).
- Voice mode: spoken replies, text-to-speech for commands, and any audio sent off the device (plan D43). Dictation is microphone input into the command bar only (D9).
- Downloading recordings for local transcription.
- Using planning data (grades, holds, DARS) in AI, Jev or MCP: the team's boundary. It stays local.

## Acceptance for the whole

On the operator's signed-in account, one command:
1. syncs Canvas, Outlook (Graph) and the public feeds;
2. prints per course the sessions and the upcoming assessments' dossiers (scope with verified quote, Core / Also useful / Practice within caps) and the assignment work views;
3. **if probe E1 passed,** lists this week's professor and TA emails, filed to their course. Otherwise it runs the on-demand fallback (T35), or prints "skipped: E1 failed" until T35 exists;
4. runs the flashcard pack for one settled scope, with every citation verified;
5. builds **the quiz for one upcoming assessment, sectioned by its chapters and modules**, with every question showing its topic tag and source. It answers it with a scripted student, then prints the results by section and topic, each topic's level bar, and the assessment's mastery bar ("Mastered n of m topics"). No predicted grade appears;
6. runs **a quiz on two selected topics**, and prints their levels before and after;
7. prints the unified schedule for the next 14 days (D8), with each entry's source, and the study analytics for one course (H7), recomputed from the raw reviews;
8. prints the ledger.

A second run after a new announcement shows only the incremental changes. The perf harness prints the baseline and the after-optimization numbers side by side.

Without the gateway change (plan D16), acceptance runs with **structure-only mapping**: code plus the pass, with no Jev links. It's labelled as such.
