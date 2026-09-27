# Spec: connect everything, map it right, build the notebook on top

**Status: Specification v7.1, reconciled with `main` at `9302865`.**
- **Storage:** `main` already uses schema 4 for planning, so our migrations are **v5 and v6**.
- **Already on `main`:** My UW and planning (holds, appointments, enrollment windows, DARS, degree plan, Course Search & Enroll public reads) are built by the planning workstream; this spec reuses them.
- **Consent:** it follows the accepted flow in `docs/decisions.md` and `docs/ai-and-privacy.md`.

**v7:** v7 settles four things:
- **consent:** one checkbox
- **pricing:** free with the student's own keys
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
| D | The notebook in the app | primary |
| E | AI execution | primary |
| F | The optional MCP course bank and remote access | **secondary, never drives the app** |
| H | The study system: Quizlet-like practice, per-topic understanding, mastery by assessment, "quiz me on…" | primary |
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
5. **One typed academic API** for the app, the student's own AI clients (the optional course bank) and developers (the open framework, F3).
6. **Study intelligence grounded in that graph:** per-topic understanding from real answers, and quizzes sectioned by exactly what the assessment covers.

**Build priority** (the operator, 2026-09-26 late; plan D19):
1. **The backend, fully finalized and optimized:** Parts A and B, plus the measured optimizations B5 and the in-app handler layer.
2. **The system-driven and LLM-token features:** Parts C and E: the course pass, the mapping, and the packs that generate items, cards, quizzes and guides.
3. **The Open Notebook and Quizlet-like study system:** Parts D and H.
4. **Secondary and close:** Part F (course bank, relay, open framework), Part I (licence, installers), then legal (Part G) last.

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
| **Consent** | privacy prefs (`local_only` default) with `maySend` gating Jev and hosted sends; MCP grants; receipts. Provider onboarding and the first-use sensitive preview are "accepted, not implemented" (doc) | one checkbox that sets consent for the chosen provider and Jev; a context chip and receipt per request; a one-time preview per new sensitive category; the planning no-egress boundary | implements the accepted flow with the fewest clicks | T06 spy test: zero egress before consent |
| **Commands and IPC** | every command returns a full `snapshot()` (`core/index.ts:37`), which grows with use | scoped queries (paged, course-scoped, with a change cursor) (O1) | payloads stop growing with the data | MT1: command payload bytes, before and after |
| **Storage** | schema 4, planning included; FTS5 prefix-AND over whole documents; a `field_observations` query per row (`readResource`); inline `prepare` in loops | v5 and v6 in the same file: passages with offsets and passage FTS (OR for questions); the course map; life items; job subjects; statement cache; WAL NORMAL; `text_hash`; backup before migrating; purge that enumerates every table | exact citations; fewer statements per ingest; judgments that survive grade changes | MT1: ingest throughput, query p50/p95 and database size, before and after |
| **Canvas sync** | **per course already works:** course selection (scores, term filter, student overrides in `canvas-selection.ts`), `courseInclusion` gating every read, per-course capture scopes (`canvas:<account>:<course>:<scope>`) and sync-run history. **Missing:** per-course change *detection*. The activity-summary probe has no course field, so any change triggers a **full read of every course** every 10 min; concurrency 8 (unmeasured) | **reuse** the per-course selection, inclusion and scopes; **add** per-course change detection (course-keyed probes: `upcoming_events`/`todo` IDs for dated items, and a per-course content probe for undated materials, plan D37; Canvas documents no per-course `updated_at`), so only changed courses re-read; a cadence table; concurrency, GraphQL and ETag measured and kept at thresholds | fewer requests; freshness ≤5 min | requests per sync, the zero-change re-sync, freshness on a live item |
| **Extraction** | PDF by page, PPTX by slide, DOCX by section, with **no character offsets**; reuse keyed on Canvas `updatedAt` | offsets on every passage; reuse by content hash; captions as timestamped passages | every quote can be checked verbatim; no re-extraction | passage exactness tests; re-extraction count on unchanged files |
| **Jev** | one question (`assignment.kind.v1`); ingest queues `enrich.resource` for every saved item (`storage/index.ts:736`), but the drain only classifies assignments and needs a gateway plus `maySend`; the gateway allows 20 calls a day per device and 100 total | code-first classification, then **one batched request per item** for role, lecture, topics and exam prep; links and item gates as Nouls; cached by hash; versioned endpoints and limits (T20b) | code answers most items for free; Jev only on what's left; never re-asked | the share classified by code; Jev calls per course (internal) |
| **The student's AI** | local Ollama coaching; paid routes accepted but "not built" (doc) | a runner that calls the student's CLI in **one call with tools off**, a JSON schema, a stable prefix, cache, a ledger and a background budget | fewer tokens than agent loops; no tool risk | MT6 ablation; the ledger |
| **Agent access (MCP)** | an MCP server that **opens the database itself** (a second process); search scans every resource in memory; up to 8,000-character windows, 20 items, ~40k tokens worst case | in-process typed handlers with token caps for the app; MCP only as an optional course bank through a read-only reader (no database path handed out) | one writer; bounded outputs; no path exposure | agent-api tests; the socket spy; caps held on real data |
| **Understanding the course** | assignment-kind classification only | the course pass (one call per course) and mapping: sessions, topics, assessments with quoted scope, materials in capped tiers, settled by the system and correctable by the student (plan D33) | nobody else knows what's on the exam; checked by code | scopes settled on real courses, checked against the operator's labels; the correction count |
| **Generation** | none | Jev + the model, assisted by code: analyzers, a planner, verifiers (numeric recompute, a WASM code sandbox, dedupe), reuse first | fewer tokens per valid item; wrong keys caught | valid items per 1,000 tokens against same-model baselines (MT7b) |
| **Study** | an `attempts` table with no consumers | the knowledge model, FSRS, Quizlet-like modes, assessment quizzes by section, level bars and the mastery bar, "quiz me on", the notes tree | study runs at 0 tokens; evidence-defined progress | the P17 journey; P18–P21 validation |
| **Planning (My UW)** | built: native UW adapters, DARS, holds, appointments, Course Search & Enroll, schema 4, no egress | **reused as is**; its records never enter AI | already working; keep it | its own tests |
| **Measurement** | none against other tools | the MT1 baseline, optimizations measured before and after, a head-to-head against NotebookLM with fixed targets | claims only from measured rows | MT7a, MT7b |

**Recorded decisions that differ from our evidence or direction** (each to settle with the humans, with evidence, per the coordination guide):
- **Email:** it's deferred as a surface, while the operator wants the mail gist and link.
- **"No invented mastery":** vs our evidence-defined mastery bar.
- **The OpenRouter price:** whether those users also pay the $5.
- **The gateway's small limits:** vs item cards at course scale (D16).

## 2. The AI boundary: system-driven, Jev, or the student's AI (decided before building; gate T02)

**The principle: AI writes, code decides.**
- **Tokens are spent when study content is created**: once, cached by hash, and checked by code.
- **They're never spent during study.** A quiz, a flashcard review, grading, levels, the mastery bar and the prep list all run on code, at zero tokens. The one exception is topping up a thin question pool, which happens in the background and within consent.

**Method key:**
- **System:** code on structured fields, patterns and math; 0 tokens.
- **Jev:** a typed judgment (a Choice or a Noul) on a small candidate set that code builds, batched and cached; paid by us.
- **AI:** one catered call on the student's own AI (a prompt pack), checked by code.

**"Our tools"** means lookups the **app** runs for the model: the scoped context assembled up front, and in chat, up to 3 typed lookups the model asks for through the `need` field. The model is never handed tools directly, so untrusted course text can't trigger anything.

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
| Assessments (exams, quizzes, projects) and dates | system (assignment groups, names, dates; syllabus HTML tables) | **AI** course pass for exams stated only in prose or PDF | prose schedules need reading |
| An assessment's scope statement | system patterns ("covers lectures 10–18", "chapters 4–6", "weeks 5–9", "cumulative", "since the midterm") | **AI** course pass when unmatched or conflicting; the system settles it and the student may correct it (plan D33) | MB1 measures how often patterns suffice |
| Materials per assessment (Core, Also useful, Practice) | system (scope range → sessions → items; explicit links; module membership); caps and ranking by code | Jev: one Noul per remaining candidate (≤30) | closed yes/no |
| Chapter and module sections of an assessment quiz | system (from the settled scope) | — | structure |
| An assignment's relevant resources | system (links in its text, its module, prior lectures) | Jev: a Noul per candidate | closed yes/no |
| Mail filing (course, club, advising, careers, admin, noise) | system (sender rules, course staff names, duplicates) | Jev: area Choice; "action needed" Noul; affected assessment Noul per candidate | closed sets |
| Mail gist | system: the subject; with the `Mail.Read` opt-in, the 255-character preview | **AI**: an optional daily one-line digest for action-flagged mail | free text |
| A date moved by an email or announcement | system reads dates | Jev: which assessment; applied when it matches Canvas; otherwise shown as a conflict, and planning uses the earlier date until Canvas agrees (plan D33) | dates stay in code |
| The course AI policy | system triggers (policy phrases) | Jev: a strict Noul (can only tighten; loosening needs the student) | integrity |

**Create study content** (AI once, cached and checked; system where it can):

| Function | Method | Fallback or check | Why |
|---|---|---|---|
| Questions from **instructor** practice quizzes and exams (T1) | system extraction (numbering, options, answer-key patterns in files and pages) | Jev tags topics (Noul per candidate); **AI** structures only files code can't split | the instructor's own questions beat generated ones |
| **Generated** questions: MC, T/F, typed, cloze, numeric | **AI** (items pack) from mapped passages | checked by code (verbatim quote, flaw rules, numeric recompute) and Jev (one correct option) | writing questions is language |
| Topic tags on generated questions | **AI** proposes at generation | code validates (an existing concept, same course, 1–3) | the question's intent is known when it's written |
| Explanations, hints, "why it's tempting" | **AI** at generation, stored | quote-checked | written once, served free |
| Flashcards | **system first:** term and cloze cards from the extracted definitions | **Jev + AI** for concepts without a clean definition, then the verifiers; MB2 sets the split per course | code where it can, the model where it must |
| Study guide, briefing | **AI** | every claim quote-checked; unsupported claims removed | synthesis is language |
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
     - code questions **executed in a WASM sandbox** (Pyodide for Python, QuickJS for JavaScript), with no network, no file system and a time limit
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
| Topping up a thin pool | **AI** items pack: background-first, within consent and the background budget |

**Planning** (My UW, grades, holds, DARS): system only, local only; it never goes to AI, Jev or MCP (team boundary).

**Platform** (all system): the one-checkbox consent and receipts, onboarding detection, the ledger, purge, licence activation.

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
- **When a sign-in is needed, the app opens the UW window by itself;** there's nothing to click (D33). With "Remember my sign-in" on, the app fills the NetID sign-in itself, and only Duo appears, when Duo requires it (D39).
- **Duo "Remember me":**
  - KB 85205 (updated 2025-06-01) says it "remembers your current browser for 7 days"; the it.wisc.edu change notice (modified 2026-03-12) says "extending the 'Remember Me' function from 12 hours to 7 days"
  - the it.wisc.edu student FAQ (modified 2026-07-17) still says 12 hours; 7 days is most likely current
  - it skips only the Duo step, and only if its cookie persists. Whether it does in `persist:uw` isn't stated by UW or Duo; KB 85205 says it may not work "If you close your browser"
  - the P1 live trial lists the `duosecurity.com` cookies after a remembered sign-in (names, `session` and `expirationDate` only, never values)
- UW has no passwordless NetID login.
- **Expiry:**
  - a 401 whose body `status` is `"unauthenticated"`, confirmed by one profile read
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
| **Outlook mail** | **Microsoft Graph, delegated `Mail.ReadBasic`,** signed in through Microsoft with the UW account in the app's window | no | **a gist and a link only**: sender, subject, received time, labels, `webLink` |
| Outlook calendar | the ICS link the student publishes (UW KB 73250), or Graph `Calendars.ReadBasic` once consent exists | yes (ICS) | events |
| Campus events | `today.wisc.edu/events.ics` (verified) | yes | gist + link |
| Campus news | `badgerherald.com/feed/`, `news.wisc.edu/feed/` (verified) | yes | gist + link |
| Clubs, advising, careers | **via email** (WIN, advising offices and Handshake all email students; advising appointments and holds come from planning). WIN and Handshake aren't scraped | — | gist + link |

**A3. Outlook: collected by code, filed as a gist and a link** (the operator's feature: professor and TA emails, schedule changes).
- **Why Graph is the route:** it's the documented automated route. Scripted reading of Outlook on the web relies on undocumented interfaces, and no terms allowing it were found.
  - Permission text: "read email in the signed-in user's mailbox except body, previewBody, attachments…"; admin consent required: No.
  - `webLink` is "The URL to open the message in Outlook on the web". The student's click opens the full message in their default browser.
  - Delta query keeps sync incremental.
  - Limits: 10,000 requests per 10 minutes and 4 concurrent requests per app and mailbox.
  - About 0.5 KB per message, so 10,000 messages is about 5 MB (inferred).
- **Fallback if UW's tenant blocks consent** (UW's setting was not found):
  1. A **code** read of the rendered inbox list in the app's own signed-in Outlook web window (sender, subject, date, preview line, link), run on demand. Microsoft's terms for this are checked before it ships.
  2. Or an on-demand "import recent email" pack run by the student's AI with a browser.

  Neither runs in background sync.
- **Filing:**
  - Canvas, Piazza and Gradescope notifications are matched to synced items and stored as `duplicate_of`.
  - Senders map to areas: instructors and TAs from course rosters → that course; Handshake → careers; WIN → clubs; advising offices → advising; list headers → lists.
  - Jev answers the rest: an area Choice (a two-level tree), an "action needed" Noul, and "affects which assessment" as one Noul per candidate. Code reads dates.
  - **Jev can raise a message's visibility but never hide one.** A student's correction teaches the sender map.
- **The gist, stated plainly:** under `Mail.ReadBasic` the summary **is the subject line**, filed and labelled, with the link to the full message.
  - A student who wants a real one-line summary opts into `Mail.Read`. The app then stores only the 255-character `bodyPreview`, never bodies.
  - For messages flagged "action needed", one batched call a day on the student's AI writes a one-line gist from subject plus preview.
  - **Probe E1** tests whether UW lets a student consent to our app for `Mail.ReadBasic`, and separately for the optional `Mail.Read`, and records which fields arrive.
- **TA and instructor matching:**
  - Canvas course users with teacher and TA enrollments, by display name. Email addresses are usually hidden from students.
  - The Canvas connector adds `/courses/:id/users?enrollment_type[]=teacher&enrollment_type[]=ta` to its allowlist (T34).
  - Names that don't match fall to Jev.
- **Course effects:** a professor or TA email that moves a lecture, exam or due date shows as a **change** on that course and assessment, linked to the message. Code applies a date when it matches a Canvas change. Otherwise both dates show as a conflict, and planning uses the earlier one until Canvas agrees; the student is never asked to confirm (plan D33).

**A4. Tracking new additions.**
- **Hot cadence, every 5 min:**
  - the calendar feeds
  - one `upcoming_events`/`todo` probe, whose IDs carry their course, so a change maps to specific courses
- **Warm reads:** only those courses.
- **Full refresh:** keeps its 10 min ±20% interval.
- Refresh already runs calendar feeds → a Canvas summary probe → a full read only on change → documents → external sites, every 10 min ±20%.
- **Added:**
  - warm reads limited to **changed courses**
  - a Graph mail delta every 5 min
  - public feeds hourly
- Every change lands in `resource_changes`, with a monotonic cursor, and drives Part C's incremental mapping.

**A5. The course space inventory, then targeted reads** ([plan D32](plan.md)). Code first lists every place a course keeps content: navigation tabs and external tools, module items by type, the syllabus, and links found in bodies. Each space is then read by the cheapest route that works: an API, a public fetch, or a browser-driven read in the app's own session, where a model-written extraction recipe runs once per page layout and code runs it after that. Each course shows its coverage: spaces found, read, needing a sign-in, and blocked. The mechanism is proven in P3's feasibility pass before it's built.

## Part B. Store (one local SQLite file)

**B1.** Stay on `node:sqlite`. `main` is at schema 4 (planning tables). Add **v5** (the course core) and **v6** (learning and practice) in the same file. The planning tables are preserved, and purge coverage is extended.
- **Keys:** every new table is keyed to `sources(id) ON DELETE CASCADE`, directly or through `resources`. There's no `courses` table; a course is `sources.course_id`.
- **Purge:** `purge()` adds explicit `DELETE`s for everything not reached by cascade: `passage_fts`, `compile_runs`, `ledger`, `ui_events`, `map_links` rows whose from-side isn't a resource, and subject jobs with a null `resource_id`. The purge test enumerates every table.
- **Life sources** (Outlook, feeds) use the sentinel `course_id` `"_life"`, because `sources.course_id` is `NOT NULL`.
- **Jobs:** they gain a subject (`subject_kind`, `subject_id`, a nullable `resource_id`), with a staleness rule per kind, and `lease(kinds[])`. Course, assessment and pack jobs then live beside resource jobs, and the existing drain leases only its own kinds.

**B2. New tables:**

| Group | Tables |
|---|---|
| Passages | `passages` (resource, version, text hash, order, start and end offsets, page, slide, `t_start`, `t_end`, heading, token estimate, redacted), `passage_fts` |
| Course map | `course_sessions`, concepts in `learning_concepts` (Part H2), `assessments` (own ID, optional `resource_id`, so an exam named only in the syllabus exists), `assessment_scope`, `map_links` (from → to, kind, tier core / supporting / practice, reason, rung code / jev / pass / student, status). **Jev links live here too**; `links` doesn't gain `covers` |
| Life items | `life_items` (source, area, course?, sender or publisher, title, date, labels, link, `duplicate_of`, gist) |
| Learning and practice | the learning spec's §7.2 tables (concepts, items with sources, concepts and checks, cards, reviews, attempts, self-ratings, disputes, artifacts, coverage, sessions, concept state, prefs) and the practice addendum's §6 tables (stars, option tags, views), as the v6 migration. `learning_passages`, `learning_passage_search` and `learning_jobs` are replaced by `passages`, `passage_fts` and the extended `jobs` |
| AI runs and use | `compile_runs`, `learning_artifacts` (pack results, D17), `ledger`, `ui_events` (expand "All in scope", move between tiers, open, confirm) |

**B3.** Existing `jobs` (subject columns), `judgments`, `links`, `attempts` and `receipts` are extended, not replaced.

**B5. Optimized and measured** ([backend optimization plan](../2026-09-26-backend-optimization/plan.md), [measurement plan](../2026-09-26-measurement/plan.md)):
- **First, a baseline:** sync requests and time, ingest throughput, query p50/p95, command round trip and snapshot bytes, and cold start. It's recorded by the perf harness (MT1) at the current commit.
- **Then the decided optimizations,** each reported before and after on the same harness:
  - **O1:** scoped queries instead of full snapshots
  - **O2:** a prepared-statement cache
  - **O3:** `synchronous = NORMAL` with WAL
  - **O4:** passages and passage FTS (B2)
  - **O5:** `text_hash` so text judgments survive submission changes
  - **O6:** extraction cached by file hash
  - **O7:** job kinds and priority (B1)
  - **O9:** one Jev request per state
  - **O11:** Canvas throttling (built)
- **Measure-first,** with their adopt and kill numbers:
  - **M1:** Canvas concurrency
  - **M2:** watermarks (A4)
  - **M3:** external-content FTS
  - **M4:** `mmap_size`/`cache_size`
  - **M5:** embeddings
  - **M8:** Canvas GraphQL batching (adopt at −40% request cost)
  - **M9:** ETag/304 on Canvas REST (adopt if any endpoint returns 304)

**B4. Storage stays small:**
- Full text only for course materials.
- Mail and news are gist + link.
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
  | Manual steps to get a course in | **0 after sign-in** | uploads per source (NotebookLM, Open Notebook); set creation (Quizlet) |
  | Sign-in → first course map (5 courses) vs hand upload of the same sources | **ours faster**; measured in MT7b, since it needs the course pass | the hand-upload time, per tool |
  | Grounded answer end to end, p50 and p95, 30 questions | **p50 ≤ Gemini Notebook's**, and p95 reported | Gemini Notebook, ChatGPT or Claude Projects, Open Notebook |
  | On-demand 10-question quiz, time to first question | **≤20 s**, and ≤ NotebookLM's | NotebookLM quiz, Quizlet Learn |
  | A new Canvas item visible | **≤5 min** (T33) | a manual re-upload in every other tool |
  | Model tokens per grounded answer and per 10-question quiz vs the **NotebookLM-style long-context baseline** on the same model | **≥50% fewer**, with claim support within 5 points and quote validity no lower | the long-context baseline (our run, labelled as such) |
  | The same, vs **Open Notebook on the same model** (token use read from OpenRouter) | **≥30% fewer**, at the same quality bar | Open Notebook, same model |
  | Valid items per 1,000 tokens (after all checks) | reported, and compared on the same model | the long-context baseline, Open Notebook |
  | Price to the student | **Free and open source with their own keys** (their AI, plus an OpenRouter key or their own Jev key); **$5 lifetime** for our hosted Jev service (early adopters) | NotebookLM free / AI Pro $19.99/mo; Quizlet free / Plus $35.99/yr |
  | Model spend per term on the student's own keys | the ledger's measured tokens × list price, per route | the same tasks on the long-context baseline |
  | Local data and purge | complete purge, verified by the enumerated-table test; data stays on the device | hosted tools: their stated retention |

- **Internal rows** (reported, never claimed against others): local query p95 ≤50 ms at 5k resources; precomputed artifacts served instantly; tokens against our own agent-loop ablation (MT6); our Jev cost per student (private).
- **Quality, reported beside speed and cost:**
  - quote validity: 100% by construction, checked
  - claim support, from a human sample
  - item correctness on a seeded-error set
  - scope accuracy against the student's labels
- **Rules:** paired comparisons, raw counts, the git SHA and versions, and **the rows we lose published too** ([benchmarking](../../notes/benchmarking.md)). A missed target is reported as missed, and its claim isn't made.

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
- **One call** gets a compact course manifest (one line per item: ID, type, title, module, position, dates) plus the syllabus, schedule pages and assessment texts. The syllabus comes out of it as the course's checked brief (plan D34).
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

**C4. Jev links the rest.** For each upcoming assessment, candidates the pass didn't place (built by code from dates, sessions and topics, capped at 30) get one Noul each.

**C5. What the student sees: not too much, not too little.**

| View | Shows | Caps |
|---|---|---|
| **Assessment dossier** | date, format, weight, the stated scope with its quote (or "not stated by the instructor"); **Core**, **Also useful**, **Practice** (past exams, quizzes, problem sets) | Core ≤8, Also useful ≤6, Practice ≤5, each with its reason. Everything else in scope sits under a collapsed "All in scope (n)" |
| **Assignment work view** | the spec, the rubric, and the lectures and readings it builds on | ≤5 resources, plus the tools to open |
| **Module view** | items grouped by session, with a role tag | no auto-summaries unless asked |
| **Home, Study & Learn** | concrete, already-chosen activities (the Home direction) | ≤3 |

- **Ranking when a tier overflows:** tier, then rung (student > code > pass > Jev), then how close the item's date is to the assessment.
- **The floor:** if Core is empty, for example when Jev is down and the pass ran on structure alone, the dossier says "Scope not stated by the instructor" and shows the top 5 items by date window as **proposed**.
- **Tuning:** the caps live in the versioned configuration. `ui_events` records expansions and tier moves; when a view's expansions pass a set rate, the configuration raises that cap (T22).

**C6. Settled, not confirmed** (plan D33: no required student input).
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

No uploads are needed. Gemini Notebook needs manual sources, with up to 50 per notebook on the free plan, and **no LMS integration was found** in its help pages. Open Notebook also needs manual sources.

**D2. The assessment dossier is a scoped notebook.** Chat and Studio default to that assessment's settled materials (C5).

**D3. Context levels per source,** after Open Notebook's "FULL CONTENT / SUMMARY ONLY / NOT IN CONTEXT", set automatically by scope and budget:
- Core → full passages within the budget
- Also useful → a cached summary
- the rest → off

The student can change any of them.

**D4. Chat with checked citations.**
- It answers only from the scoped sources. Every citation is a verbatim quote **checked by code** against the exact source version, with page, slide or recording time.
- "Couldn't find support in what I searched" is a valid answer.
- NotebookLM "uses direct quotes… as citations", but they aren't independently checked. Open Notebook's own README lists its citations as "Basic references (will improve)".
- Retrieval is run by the app: code assembles the context, and the model may request up to 3 typed lookups through a `need` field. At most 2 rounds per turn, with no tools given to the model.
- A "Learning guide" style (Socratic, one question at a time) follows the learning spec.

**D5. Studio, as prompt packs (Open Notebook's "transformations" made course-aware).** The artifact catalogue and what transfers from Open Notebook are in the team's [Open Notebook artifact inventory](../../notes/open-notebook-artifacts.md) (on `northcutt-frontend`, not yet on `main`). Packs carry a version, which Open Notebook's transformations lack.

| When | Artifacts |
|---|---|
| In the build | flashcards (FSRS), items for Learn, Write and practice quizzes, the practice exam (tiers T1–T4), study guide and briefing, rescope, the mail digest, the code-built concept map, Notes, and an **audio overview** played with the operating system's local speech voices, so no text leaves the device for speech (T52) |
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
- **Today:** lectures and events.

**D7. Notes, organised and managed by the system** ([notes](../../notes/notes.md), [notes targets](../../notes/notes-targets.md)).
- **Built by code:** a `.docx` folder tree per term → course → {Lectures, Assignments, Exams, Readings}, one templated note per session, assignment, exam and reading. It's built with the `docx` package (MIT) and **kept current by the system**: a new lecture gets its note file, pre-linked to its sources.
- **Linked both ways:**
  - every note links to its Canvas items and passages
  - the notebook shows each session's note, and opens it in Word, Pages, LibreOffice or Google Docs
- **Where notes go:**
  1. a local folder (the default; no approval)
  2. a detected Google Drive or OneDrive sync folder (offered; no approval)
  3. **optionally**, the Google Drive API (`drive.file`, non-sensitive) or Microsoft Graph, each behind its own consent screen

  This is the only prompt beyond the setup checkbox, and only for students who want notes in the cloud.
- **Jev** picks the template per session type (lecture, discussion, lab, reading, worked problems). **The student's AI** optionally pre-fills the outline, with checked quotes.
- **Negatives:**
  - a note the student edited is never overwritten (edits are detected by hash; a new version is written beside it)
  - the app stores only each note's path and hash

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

**The packs:** course pass, rescope, flashcards, quiz, practice exam, study guide, explain/chat, grade free response, mail gist digest.

**E2. The runner.** One `ModelRunner` spawns the student's CLI in a working directory the app owns.

| Client | Call |
|---|---|
| Claude | `claude -p --output-format json --json-schema … --tools "" --strict-mcp-config --setting-sources project,local --no-session-persistence` |
| Codex | `codex exec - --json --output-schema … --ephemeral -s read-only --ignore-user-config` |
| Gemini | `-o json`, with zod validation and one retry |

- **Never** `--dangerously-skip-permissions`, and never `--bare` on a subscription (bare mode "doesn't use your subscription login").
- An OpenRouter key maps to the same models.

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

**E4. Onboarding, in one button:**
1. Detect the installed CLIs.
2. Check their auth (`claude auth status --json`, `codex login status`).
3. Probe their models.
4. Configure the packs in the app's own folder. The student's own settings are never edited.

**E5. The ledger** records every call: pack, version, tier, model, tokens in, cached and out, latency, check failures, escalations, and the student's later edits.

## Part F. Secondary: the optional MCP course bank and remote access

These **never drive app features.**

**F1. The course bank.**
- **Opt-in:** registered in the student's own clients with `claude mcp add` or `codex mcp add`.
- **Tools:** `courses`, `course`, `upcoming`, `assessment`, `materials`, `search`, `get`, `changes`. They're compact, capped, grant-checked and receipted.
- **Resources and prompts:** `@` resources for courses and assessments, and pack instructions exposed as MCP prompts.
- **The shared code is the handlers:** these tools and the app use the same handlers in `packages/agent-api`, but the app calls them in-process.
- **When the app is closed,** the entry point starts the read-only reader itself and serves the last sync, with freshness stamps.

**F2. Remote access for web and phone** (a setting, off by default).
- **Why a relay:** Claude's servers make the connection ("allowlist Anthropic's IP addresses… so inbound connections from Claude can reach your server"), so the laptop needs a public endpoint.
- **How it works:** an outbound WebSocket from the desktop to our relay (pattern: `mcp-local-tunnel`, MIT). The relay serves a per-student Streamable HTTP MCP endpoint with OAuth 2.1, PKCE and protected resource metadata. Access is approved in the desktop app.
- **Pass-through only:** it stores no content. When the laptop is asleep: "Your Magic Canvas desktop is offline."
- **Default grant:** deadlines, briefs and materials.
- **Probes RP1–RP3** (run in T00): whether Claude's mobile apps can use a connector added on the web, whether MCP App views render there, and ChatGPT mobile.

**F3. The open framework** (the operator: "we emphasize the open sourced framework that lets any developer utilize our academic backend").
- **The framework packages:** `contracts`, `storage`, `retrieval`, `connectors`, `agent-api`, `runner`, `packs/core`, and the `magic` developer CLI.
- **What they give developers:** a documented, typed academic data layer, with an examples folder and a "build your own study tool in 50 lines" guide.
- **Boundary test:** framework packages build and test with zero imports from `apps/desktop`, `apps/gateway` or licence code. A sample connector plugs in with one new file.
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

**H4. Understanding per topic, and the mastery bar per assessment** (new; it amends KM-6).
- **A topic's level of understanding** is its state (Not seen yet · Iffy · Getting there · **Mastered**, the student-facing name for Solid) plus a **progress bar toward Mastered**.
  - **The bar:**
    `bar_c = 1` if the topic is Mastered (Solid); otherwise `min(0.99, min(c_c / 8, 1) · min(p̂_c / 0.75, 1))`, where:
    - `c_c` is the number of **unassisted correct** scored answers in the lookback window
    - `p̂_c` is the model's point estimate
  - **It moves with every answer:**
    - a right answer raises `c_c` and `p̂_c`
    - a wrong answer leaves `c_c` unchanged and lowers `p̂_c`, so the bar goes down
  - **After each answer,** a change marker shows the topic's move ("Recurrences +6%" or "−4%").
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
- **Team note:** the product brief says "No invented mastery, readiness score, or completion claim". This bar is defined entirely by stated evidence rules, not invented. The word "mastery" still needs the team's agreement (plan §9).

**H5. Quiz me on the topics I choose (like NotebookLM's custom quiz).**
- **Select:** any mix of topics or concepts, chapters or modules, lectures, an assessment's scope, and a filter (starred, missed, Iffy, Not seen yet). Then choose the mode (Flashcards, Learn, Write, Test), the number of questions and the difficulty.
- **Describe** (optional): typed text resolves by code first (ranges, filters, concept labels and aliases), then Jev for ambiguous matches, then the rescope pack. The resolved topics show as editable chips before starting.
- **The pool** is checked items tagged to those topics; when it's thin, the items pack tops it up.
- **Results** show right and wrong by topic, and each chosen topic's level before and after.
- **Negative:** a session never silently widens beyond the chosen topics.

**H6. What needs prep.** For an assessment or a whole course, topics are ranked by the priority function (urgency from the assessment date × (need + fired rules)). Each row shows its level bar, reasons, evidence counts and the coverage-map status of its materials. It's the same data as H4, ordered for study.

## Part I. Licence, payment and distribution (needed for the complete app)

- **I1. Licence activation.** A licence key activates on first run and **enrolls the device with the gateway,** which the gateway already supports. There's no user account, and the Jev key never ships to clients.
  - **The payment provider is the operator's decision.** The researched options are in the business model: Lemon Squeezy, Polar, Paddle and Stripe.
  - Early-adopter slots are capped. A fair-use rule sits in the Terms.
- **I2. Signed installers:**
  - macOS: notarized, through the Apple Developer Program at $99 a year
  - Windows: code-signed (Azure Artifact Signing or an OV certificate)
  - Auto-update from signed releases
- **I3. Accessibility:** keyboard navigation for every mode, and WCAG AA contrast under the customizable shell colours.

## Part G. Privacy and legal

**G1. One checkbox at setup, then only what the accepted consent flow and the providers require** (T06; `docs/ai-and-privacy.md` "Accepted disclosure flow").
- **The setup screen** gives consent once for the chosen provider and for Jev. It states the recipient, purpose, data categories, provider settings and how to revoke, plus the Canvas page-view effect. **One checkbox** agrees. Then the UW sign-in, and Canvas connects automatically.
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

**G2. Legal is written last, from legal research and expert application.**
- The Terms of Service, the Privacy Policy, and an in-app data notice showing what goes where for the chosen client and for Jev.
- Based on `docs/ai-and-privacy.md`.
- They cover: lifetime-deal fair use, UW rules (NetID, recordings for class use, FERPA framing), and each provider's terms.

## Non-functional requirements

| # | Requirement | Target |
|---|---|---|
| N1 | Screens read locally | p95 ≤50 ms at ~5k resources |
| N2 | New Canvas deadline visible | ≤5 min after it's published; ≤2 requests per hot tick (T33; until it lands, the existing refresh gives ≤12 min) |
| N3 | A course mapped | proposed scopes ≤2 min after that course's syllabus, schedule and assessments are harvested |
| N4 | One-click artifacts | a precomputed one instantly; on demand, the first cards ≤20 s on the pass tier (measure) |
| N5 | Our cost | Jev only, within the operator's private estimate; a global abuse cap |
| N6 | Student cost | plan quota only on subscriptions; the ledger shows use per action |
| N7 | Integrity | no quote, ID or date reaches the student unchecked by code; settled scopes never change silently; Jev never hides a message |
| N8 | Purge | zero rows left in every derived table |

## Out of scope

- Storing the NetID password without the student's opt-in, or anywhere but the encrypted local vault (plan D39).
- Automating Duo.
- AI browser agents in background sync.
- Scraping Handshake or WIN. (My UW is read only through the planning workstream's app-owned session adapters.)
- Exchange Web Services.
- A second database engine.
- Graph-RAG indexing: GraphRAG-Bench (ICLR'26) found graph-structured retrieval loses 5–10 F1 on simple questions.
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
7. prints the ledger.

A second run after a new announcement shows only the incremental changes. The perf harness prints the baseline and the after-optimization numbers side by side.

Without the gateway change (plan D16), acceptance runs with **structure-only mapping**: code plus the pass, with no Jev links. It's labelled as such.
