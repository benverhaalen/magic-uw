# Magic Canvas: product direction

**Status:** direction as of 2026-09-26 late. It describes what we're building and where it's going, and labels what exists. **Nothing is demonstrated on a real student account yet.**
**Companion:** [course backend architecture](course-backend-architecture.md) holds the technical facts: processes, storage, channels, measurements, and [where the build stands](course-backend-architecture.md#2-where-we-are). The full specification is the [course-backend spec](plans/2026-09-26-course-backend/spec.md). The visual design follows the team's [DESIGN.md](../DESIGN.md); every surface below adopts it, and none of this document is a visual design.

**Status labels:** *integrated* (merged and running in the app on the feature branch), *tested in isolation* (merged with tests, not yet called by the app), *built* (code on a lane branch, not merged), *in progress* (being built now), *proposed* (specified, no code), *researched* (evidence only). Definitions: [architecture §1](course-backend-architecture.md#1-summary).

## 1. In one paragraph

Magic Canvas is a desktop study app for UW–Madison students. The student signs in once. Code collects every course from the sources their own UW sign-in can already read, and stores it on their computer. Each course becomes a notebook that's already organised: every assessment carries what it covers, with the instructor's own words quoted, and the materials for it. Study material (flashcards, quizzes sectioned by module, guides) is written by the student's own AI in one checked call, and every quote and date is checked by code. Studying itself costs no model tokens. **AI writes, code decides.**

## 2. What the student gets, end to end

| Step | What happens | Status |
|---|---|---|
| **1. Your AI** | The app detects the installed AI clients with local version checks only, with no network request: Claude Code and Codex today, Gemini CLI planned. The student picks one and sees that provider's consent: who receives what, and how to revoke it. | detection tested in isolation; the flow in progress (T81) |
| **2. Connect** | The app creates its own isolated profile for that client, separate from the student's own settings, and opens a built-in terminal. The student signs in there through the provider's own login. The app confirms with the client's own status command and never reads a credential. | in progress (T80; plan D45) |
| **3. UW** | One checkbox (Jev, the UW session note, and the disclosure that reading Canvas can register page views), then the student's own NetID and Duo in the app's window. | consent and sign-in integrated; not demonstrated |
| **4. Populating** | Canvas connects automatically. Code inventories every place each course keeps content, reads what it can, and shows what needs a sign-in. | inventory built; sync on `main` |
| **The course map** | Sessions, topics and assessments. Each assessment shows its stated scope with the quote, and its materials in capped tiers (Core ≤8, Also useful ≤6, Practice ≤5). The system settles each scope; the student can correct it in one click (open decision H4). | proposed (T21, T22) |
| **Notebook** | A notebook per course: Sources, Notes, Studio. Chat answers only from the course's sources, and every citation is a verbatim quote checked by code. "Couldn't find support" is a valid answer. | proposed; the quote validator is built |
| **Generation** | Flashcards, quizzes, a study guide, a practice exam, a timeline, a concept map, an audio overview in local voices. Code plans and verifies; the model writes only what code can't. | proposed; checking engines built |
| **Study** | Flashcards on FSRS, quizzes sectioned by the assessment's chapters and modules, the topic shown on every question, per-topic levels, "Quiz me on…" chosen topics, and study analytics. No XP, streaks or leaderboards: a study tool, not a game (plan D20). | engines built; surfaces proposed |
| **One schedule** | Canvas dates, dates stated in course prose, calendar feeds, the Today rail's day plan and planning dates in one timeline, each entry with its source. Proposed study sessions are placed before each real exam date. Nothing is written back to Canvas or Outlook. | proposed (spec D8) |
| **Notes** | A `.docx` folder tree per term and course, one templated note per lecture, assignment, exam and reading, kept current by code and linked to its sources. A note the student edited is never overwritten. | proposed (T59) |
| **Dictation** | **Ctrl+Shift+Space** (Windows) or **⌘⇧Space** (macOS): hold to talk into the command bar. Speech is recognised on the device; the transcript is shown, editable, and runs only on Enter. Audio is never stored or sent. | proposed (plan D43; after the core study features) |
| **Outlook** | Professor and TA emails as a gist and a link, filed to their course; a moved date shows as a change. Never message bodies. Mail appears inside course pages, the Briefing and Today, not as its own tab. | researched and proposed (plan D44); depends on UW's tenant allowing consent |

**No AI client?** The student can add their own key, use Ollama if installed, or continue without AI. Study, and mapping by code and Jev, still work; generation waits.

## 3. Frontend: everything we're building

Every surface follows [DESIGN.md](../DESIGN.md) and the near-approved Home. A new visual family or consequential workflow change goes to Ben as a concrete comparison first. The exact channels and commands each surface calls are in [architecture §5](course-backend-architecture.md#5-frontend-surfaces-the-backend-serves).

| Surface | What it does | Backend it uses | Status | Design note |
|---|---|---|---|---|
| **Onboarding** (T81) | Welcome → Your AI → Connect → UW → Populating | client detection (T40), isolated profile and terminal (T80), consent (T06), sign-in (T05c) | in progress; the consent setup screen is integrated | reuse the Home's type and spacing; no new visual family |
| **Workspace, command bar and live activity line** (plan D40) | Ctrl/⌘+K for chat and commands; code resolves a command first; a line shows the client working | the `workspace` command (seam built); the runner and session pool | proposed | open H7 against the near-approved Home |
| **Course map and assessment dossier** | the settled scope with its quote; capped tiers with a reason per item; "All in scope (n)" collapsed | course pass and mapping (T21, T22); `map` and `correct` | proposed | caps live in configuration |
| **Access chips and "Connect this course"** (plan D41) | "2 sources need a sign-in"; UW single-sign-on hosts in one click; other platforms open in the browser | inventory and access check (built on a lane) | built (backend); UI proposed | never blocks study; never asks twice |
| **Notebook with grounded chat** | Sources, Notes, Studio; chat scoped to an assessment | retrieval the app runs; the chat pack (T42); the quote validator | proposed | citation shows page, slide or recording time |
| **Artifacts** | study guide, briefing, FAQ, timeline, concept map, audio overview | packs (T44, T74, T52); the concept map is built by code | proposed (guide schemas built) | the audio uses the operating system's voices |
| **Flashcards and quizzes** | sectioned by the assessment's modules and chapters; topics on every question; instructor questions first | items and flashcard packs (T45, T41), the assessment quiz builder (T53), FSRS | engines built; packs and UI proposed | Quizlet-like modes, without game mechanics |
| **Per-topic levels and the mastery display** | a level per topic, moving with each answer; a bar per assessment, defined by evidence rules and never a grade prediction | the knowledge model (built), T54 | engine built; display proposed | open H8: the wording against "No invented mastery" |
| **Analytics** | accuracy by module and chapter, the review forecast against real exam dates, true retention, calibration | computed by code from the raw reviews (H7, T67) | calibration built; the rest proposed | every figure recomputable from raw data |
| **"Quiz me on…"** | pick topics, or describe them in words; editable chips | resolved by code, then Jev, then a small pack (T47) | proposed | |
| **Notes tree** | the `.docx` tree and each session's note, opened in the student's editor | T59 | proposed | |
| **Today rail integration** | lectures, events, the day plan and today's study sessions | the team's day-plan work (PR #2, pending merge) and the unified schedule | the rail is the team's, in progress; our schedule proposed | the rail's structure is kept |
| **Planning (My UW)** | enrollment, holds, appointments, DARS, Course Search & Enroll | the planning adapters on `main` | built on `main` (the team's) | local only; never to AI, Jev or MCP |
| **Settings** | AI clients and keys; "Keep me signed in"; "Remember my sign-in"; consent and agreements; purge | onboarding (T40), session (T05c), consent (T06), D39 | "Keep me signed in", consent and agreements integrated; clients and keys proposed; "Remember my sign-in" proposed (open H2) | |

## 4. NotebookLM, Quizlet and Anki: parity, and where we aim to outperform

The full capability map, 25 rows with each reference product's own help page, is [spec §1c](plans/2026-09-26-course-backend/spec.md). **Nothing in the "aim" column is claimed publicly until its measurement has run** (plan D22), and rows we lose are published too.

| Capability | The reference product | Ours | Status | How we aim to do better, and the measurement |
|---|---|---|---|---|
| Getting sources in | NotebookLM: uploaded by hand; the free plan allows 50 sources per notebook ([help](https://support.google.com/notebooklm/answer/16215270), [limits](https://support.google.com/notebooklm/answer/16213268)) | every course read by code through the student's own sign-in; no uploads | sync on `main`; inventory built | 0 manual steps after sign-in (MT7a) |
| Grounded chat | NotebookLM cites direct quotes ([help](https://support.google.com/notebooklm/answer/14276569)) | every quote checked by code against the exact source version; scoped to an assessment | validator built; chat proposed | quote validity and claim support (MT3); ≥50% fewer tokens than a long-context baseline on the same model (MT7b) |
| Study guide and briefing | NotebookLM Studio reports ([help](https://support.google.com/notebooklm/answer/16206563)) | outline built by code; the model writes only each section's prose | schemas built; pack proposed | tokens per guide (MT7b) |
| Timeline and mind map | NotebookLM Studio | dates from Canvas fields and checked quotes; the concept map built by code | engines built | 0 tokens; no date outside its source |
| Flashcards and quizzes | NotebookLM ([help](https://support.google.com/notebooklm/answer/16958963)); Quizlet Learn and Test ([help](https://help.quizlet.com/hc/en-us/articles/360030841732)) | instructor questions first, then generated items with checked keys; sectioned by what the exam covers | engines built; packs proposed | time to first question ≤20 s (MT7b); seeded-error catch (MT4) |
| Spaced repetition | Anki's FSRS ([deck options](https://docs.ankiweb.net/deck-options.html)) | `ts-fsrs`, with a pre-exam review against the course's real exam dates | FSRS adapter built | decay and scheduling validation (P20, P21) |
| Statistics | Anki's statistics ([stats](https://docs.ankiweb.net/stats.html)) | the same figures per topic and per assessment, forecast against real exam dates | proposed | every figure equals a recomputation from raw reviews |
| Progress | Quizlet tracks answers for Plus subscribers ([help](https://help.quizlet.com/hc/en-us/articles/360048803491)) | per-topic levels from real answers, local, 0 tokens | engine built | P18–P21 offline validation |
| LMS connection | Quizlet documents a Google Classroom add-on, no direct Canvas integration ([help](https://help.quizlet.com/hc/en-us/articles/45955621176589)) | the student's own Canvas session; no school deployment needed | sync on `main` | MT7a |
| Not planned | video overviews, slide decks, infographics, Match, streaks, cross-device sync | | | no named study job needs them, or a study tool doesn't want them (D20) |

## 5. How we optimise: measured versus target

The measurements are ours, on synthetic data on one Windows laptop, unless stated otherwise. The full tables and protocol are in [architecture §8](course-backend-architecture.md#8-measurements).

| Technique | What it does | Evidence so far | Target | Status |
|---|---|---|---|---|
| **Zero tokens during study** | quizzes, reviews, grading, levels and analytics run on code | by design; the ledger will show it | 0 model tokens per study session, unless a labelled top-up ran | engines built |
| **Code first, then Jev, then one checked model call** | code answers what has one right answer; Jev picks from small candidate sets; the model gets one call with tools off | the runner's argument lists are checked by tests | code classifies most items; one Jev request per item | runner tested in isolation |
| **Cache by content hash** | a result is reused until its inputs' text changes | pack cache keys built (T13) | never re-ask an unchanged question | tested in isolation |
| **Per-course change detection** (D37) | only courses that moved are re-read | today a re-sync with nothing changed still makes 69 of a full sync's 79 requests (MT1) | new dated item ≤5 min; undated material ≤15 min | built on a lane |
| **Warm CLI sessions** (D38) | one warm session per open course instead of a new process per call | a new `claude -p` took 5.8–7.4 s; a warm follow-up 1.7–2.2 s; our system prompt cut fixed tokens from 11.3k to 2.8k (measured on this laptop, plan D38) | spikes decide whether it's the default | tested in isolation |
| **Store vs link, compressed summaries** (D40, D44) | text is stored as passages; tools and platforms are links; mail is a gist and a link | by design | mail about 0.5 KB per message (estimated) | proposed |
| **Passage search** | OR + BM25 over passages, with a "not found" gate | found 10/10 planted answers where today's prefix-AND found 0/10 (spike, synthetic) | recall@5 ≥0.90; correct "not found" ≥0.80 | built on a lane |
| **Contentless full-text index** | stores the text once, not twice | the duplicate copy was 31% of the database (spike, synthetic) | ≤11 MB per 1,000 resources (−30%) | built on a lane |
| **The ingest bottleneck** | found: each re-index scanned the whole search table, about 88% of ingest time | 78 resources/s at 5,000 today (MT1) | ≥750 resources/s at 5,000 (≥10×) | fix built on a lane |
| **Presence-gated background reads** | signed-in reads only while the student is at the computer; no request keeps a session alive | tested (T05d) | 0 signed-in requests while away | integrated |
| **Batch pricing on the key route** | background work sent through a provider's batch API when the student uses a key | providers price batch jobs below interactive calls ([Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing), [OpenAI](https://platform.openai.com/docs/guides/batch)) | adopted only if M7 measures a real saving | proposed (measure first) |

## 6. The two-part launch

### 6.1 The open academic data platform (plan D42), for Badger developers

The operator's framing: "an academic autonmous database layer for agentic operation that we open source as a platform for badger developers to build their own study tools" (Nathaniel, 2026-09-26). What developers get ([spec F3](plans/2026-09-26-course-backend/spec.md)):
- **A versioned read contract:** named SQL views over the one local database, with a schema handshake, and a typed SDK.
- **A read-only MCP course bank** that a student's own AI client can use. It never drives the app.
- **Scoped, revocable tokens,** one per tool, rechecked on every call, with a receipt per call.
- **A narrow write path for student-owned artifacts only** (decks, cards, notes, study records), each write checked by code and undoable. Never a school action, never coursework or evidence, and planning data is never exposed.
- **MIT licence.** The framework packages build with zero imports from the desktop app, the gateway or licence code.

Status: proposed. What exists on `main` is the MCP server with per-client grants and receipts.

### 6.2 Our product on top

**Our lane's business model** ([business model](notes/business-model.md); plan D30; Nathaniel, 2026-09-26):
- Open source (MIT), and **free with the student's own AI**: their Claude Code, Codex or Gemini CLI, or an OpenRouter key.
- **$5 for life** for early adopters who want our hosted Jev service instead of bringing their own Jev access.
- **After launch only:** a UW–Madison campus licence proposed at $1–2 per student. No partnership exists, and none is claimed.

**The team's recorded resolution differs.** [Decisions](decisions.md) records a **$5 one-time app licence** that covers the service and company-funded Jev, with a paid AI plan or key as a setup prerequisite. Both record that OpenRouter users pay for Jev through their own key. **Which applies is open decision H1, between Nathaniel and Ben.** Setup, the licence task (T62) and the submission text depend on it.

**Also before any public release:** the team accepts Anthropic's Commercial Terms, which running Claude Code in a product requires ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). The route where the student's own Claude subscription runs the app's work is verified in the provider's terms for Claude Code, pending live testing; it's open decision H5. We don't promise it until then.

## 7. Where it's going

The detailed state and build order are in [architecture §2](course-backend-architecture.md#2-where-we-are). In phases:

| Phase | What | Depends on |
|---|---|---|
| **Now, through the submission** (Sunday 2026-09-27, 11:00 CT) | the running lanes land (data layer, per-course sync, learning engines); D45 onboarding starts; a demo branch is frozen at about 09:30 CT and the scripted demo runs on whatever exists, with skipped steps labelled; the team's release cleanup, then our docs and code go up | the release cleanup (G0) before any push |
| **After the submission** | phase 1, the backend finalised and measured against public tools; phase 2, the course pass, mapping and generation packs; phase 3, the study surfaces; phase 4, the course bank, the data platform, licence, signed installers, then legal | T02 (the AI boundary sign-off) before phase 2; H1–H8 as each becomes blocking |
| **After launch** | a conversation with UW–Madison (DoIT) about a sanctioned connection and a campus licence | a launched product with measured results; never claimed before |

## 8. What's true today

- **Integrated on the feature branch:** the one-checkbox consent and egress gate, sign-in and session handling with "Keep me signed in", and presence-gated background reads. The whole suite passes 359/359.
- **Tested in isolation:** the model runner, the warm session pool, the pack core and client detection.
- **Built on lane branches, not merged:** the new storage schema and passage search, per-course inventory and freshness, and the learning engines.
- **Proposed:** the course map, generation, every study surface, the schedule, notes, dictation, Outlook, the data platform and the licence.
- **Demonstrated:** nothing yet. The live trial has started; no NetID sign-in has been completed in it.
