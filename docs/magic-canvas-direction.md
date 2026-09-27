# My Magic UW: product direction

**Status:** direction as of 2026-09-26 late. It describes what we're building and where it's going, and labels what exists. **One live trial has run on a real student account** (sign-in and the first Canvas read; [build record §6](course-backend-build-record.md#6-live-trial-results)); nothing else is demonstrated yet.
**Companion:** [course backend architecture](course-backend-architecture.md) holds the technical facts: processes, storage, channels, measurements, and [where the build stands](course-backend-architecture.md#2-where-we-are). The full specification is the [course-backend spec](plans/2026-09-26-course-backend/spec.md). The visual design follows the team's [DESIGN.md](../DESIGN.md); every surface below adopts it, and none of this document is a visual design.

**Status labels:** *integrated* (merged and running in the app on the feature branch), *tested in isolation* (merged with tests, not yet called by the app), *built* (code on a lane branch, not merged), *in progress* (being built now), *proposed* (specified, no code), *researched* (evidence only). Definitions: [architecture §1](course-backend-architecture.md#1-summary).

## 1. In one paragraph

My Magic UW is a desktop study app for UW–Madison students. The student signs in once. Code collects every course from the sources their own UW sign-in can already read, and stores it on their computer. Each course becomes a notebook that's already organised: every assessment carries what it covers, with the instructor's own words quoted, and the materials for it. Study material (flashcards, quizzes sectioned by module, guides) is written by the student's own AI in one checked call, and every quote and date is checked by code. Studying itself costs no model tokens. **AI writes, code decides.**

## 2. What the student gets, end to end

| Step | What happens | Status |
|---|---|---|
| **1. Your AI** | The app detects the installed AI clients with local version checks only, with no network request: Claude Code and Codex today, Gemini CLI planned. The student picks one and sees that provider's consent: who receives what, and how to revoke it. | detection and the flow integrated (T40, T81) |
| **2. Connect** | The app creates its own isolated profile for that client, separate from the student's own settings, and opens a built-in terminal. The student signs in there through the provider's own login. The app confirms with the client's own status command and never reads a credential. | integrated (T80; plan D45); isolation verified on Claude Code and Codex |
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

Every surface follows [DESIGN.md](../DESIGN.md) and the near-approved Home. A new visual family or consequential workflow change goes to Ben as a concrete comparison first. The exact channels and commands each surface calls are in [architecture §11](course-backend-architecture.md#11-frontend-surfaces-the-backend-serves).

| Surface | What it does | Backend it uses | Status | Design note |
|---|---|---|---|---|
| **Onboarding** (T81) | Welcome → Your AI → Connect → UW → Populating | client detection (T40), isolated profile and terminal (T80), consent (T06), sign-in (T05c) | integrated (T81 merged); not demonstrated | reuse the Home's type and spacing; no new visual family |
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
| **Settings** | AI clients and keys; "Keep me signed in"; "Remember my sign-in"; consent and agreements; purge | onboarding (T40), session (T05c), consent (T06), D39 | "Keep me signed in", consent and agreements integrated; clients and keys proposed; "Remember my sign-in" built and tested in isolation, its Forget row under Sources ▸ UW Canvas (open H2) | |

## 4. NotebookLM, Quizlet and Anki: parity, and where we aim to outperform

The sourced scorecard against ten study tools (price, Canvas access, citations, quotas, study-time cost, benchmarks) is [academic data platform §5](academic-data-platform.md#5-scorecard); this table keeps only the per-capability measurement plan. The full capability map, 25 rows with each reference product's own help page, is [spec §1c](plans/2026-09-26-course-backend/spec.md). **Nothing in the "aim" column is claimed publicly until its measurement has run** (plan D22), and rows we lose are published too.

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
| Not planned | video overviews, slide decks, infographics, Match, streaks, cross-device sync | | | no named study job needs them, or a study tool doesn't want them (D20) |

## 5. How we optimise: measured versus target

The techniques, each with what we did, why it wins and its evidence, are in [academic data platform §4](academic-data-platform.md#4-the-decisions-with-evidence). The measured before-and-after numbers (MT1, synthetic, one Windows laptop) and the AI cost structure are in [build record §5 and §7](course-backend-build-record.md#5-scores-and-measurements). Batch pricing on the key route stays proposed, adopted only if M7 measures a real saving.

## 6. The two-part launch

### 6.1 The open academic data platform (plan D42), for Badger developers

The operator's framing: "an academic autonmous database layer for agentic operation that we open source as a platform for badger developers to build their own study tools" (2026-09-26). What developers can use today, the planned versioned read contract, scoped tokens and write path (proposed), a quickstart and the rules every tool keeps are in [academic data platform](academic-data-platform.md).

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

The canonical status per piece is [architecture §2](course-backend-architecture.md#2-where-we-are), and the status per platform part is [academic data platform §2](academic-data-platform.md#2-why-build-on-it). In one line, at `33b1827` with 540/540 tests: storage, sync, sign-in, consent and onboarding are integrated; retrieval, the drain, the runner, packs and the learning engines are tested in isolation; the course map, generation, every study surface and the data platform are proposed; one live trial has run on a real account.
