# My Magic UW: the course backend and an open academic data platform

**Status:** as of 2026-09-26 late, branch `feat/course-backend` at `33b1827`. The whole suite passes 540/540 there (Windows 11). Every part below carries a status label: *researched*, *proposed*, *built*, *tested in isolation* (merged with passing tests; the running app doesn't call it yet) or *integrated* (wired into the running app's path). The labels are defined in [architecture §1](course-backend-architecture.md#1-summary).
**Canonical homes:** the build status per piece is [architecture §2](course-backend-architecture.md#2-where-we-are); the measurements, tests and live trial are in [the build record](course-backend-build-record.md); the product surfaces and pricing are in [the product direction](magic-canvas-direction.md). This document links to them rather than repeating them.

## 1. What it is

**A local-first, agent-first academic database that assembles a student's whole course world automatically.** The student signs in to UW once. Code inventories every place each course keeps content, reads what the student's own sign-in can already read, and stores it in one SQLite file on the student's computer: materials split into passages with exact offsets, assessments with their stated scope, links between them, and the access state of every course space. Code checks every quote, ID and date. The student's own AI client (Claude Code or Codex, in a profile the app owns) is called only where language has to be read or written, one checked call at a time. Study itself runs on code at zero model tokens.

It is two things at once:
- **The backend of the My Magic UW desktop app.** Every My Magic UW feature reads from it.
- **A platform other developers can build on.** The code is MIT. The packages are TypeScript over `node:sqlite`, and the store, retrieval, job drain, runner, prompt packs and learning engines can be used in-process today.

**What's been shown on a real account** (the operator's, 2026-09-26; counts only, [build record §6](course-backend-build-record.md#6-live-trial-results)): sign-in to connected in 16.5 s including typing; a first read of 6 current courses in 125 requests, 65 s and 3.3 MB; zero AI or Jev requests during sync. A parallel sync targeting ≤10 s is being built; that target is not met yet.

## 2. Why build on it

| Part | What a developer gets | Where | Status |
|---|---|---|---|
| **Typed contracts** | zod schemas and TypeScript types for captures, resources, commands and scoped queries, plus the course core: passages, assessments and scopes, map links, course spaces, extraction recipes, course briefs, material facts, the ledger | [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts), [`course-core.ts`](../packages/contracts/src/course-core.ts) | integrated |
| **The store, schema v7** | one file, one writer; v5 course intelligence; v6 course core (passages, `passage_fts`, course sessions, assessments, `assessment_scope`, `map_links`, `course_spaces`, `extraction_recipes`, `course_briefs`, `material_facts`, `ledger`, job subjects); v7 learning and practice tables. Every new table cascades from its source, so purge is complete | [`packages/storage`](../packages/storage/src/index.ts): `createStore(path)` | integrated (the worker opens it; migrations run on open) |
| **Passages** | materials split into passages with character offsets, and page, slide or time where known; indexed on every ingest | `store.passages(id)`, `store.passage(pid)` | integrated |
| **Retrieval** | contentless passage FTS5; questions run as OR + BM25 with a term-coverage gate, so "not in your materials" is a real answer; a `lookup` mode that matches every term by prefix; scoped to chosen courses | `store.searchPassages({ query, courses?, k?, mode? })`; [`packages/retrieval`](../packages/retrieval/src/index.ts) | tested in isolation (no app surface calls it yet) |
| **Scoped queries** | a 17.5 KB summary, paged course views, one resource, and a change cursor, instead of a 30.6 MB snapshot | `runQuery` in [`packages/core/src/queries.ts`](../packages/core/src/queries.ts), the `magic:query` channel | integrated as a channel; the UI still reads the full snapshot |
| **Course map writes** | assessment scopes and briefs whose quotes are validated against the exact resource version; a student correction wins | `putAssessmentScope`, `putCourseBrief`, `putMapLink` | tested in isolation; the course pass that fills them is proposed (T21, T22) |
| **Course spaces and access** | every tab, module item, external tool and linked platform per course, each with an access state (readable, needs UW sign-in, own login, link-only, blocked) | computed in [`apps/desktop/src/ingestion.ts`](../apps/desktop/src/ingestion.ts); `putCourseSpace`, `courseAccessSummary()` | computed on every sync (integrated, held in memory); persisting to `course_spaces` is tested in isolation |
| **The job drain** | jobs with subjects (resource, course, assessment, source, pack); the drain leases only kinds that have a handler, so nothing spins | [`packages/core/src/drain.ts`](../packages/core/src/drain.ts): `createDrain`; `store.enqueueSubject` | tested in isolation (the worker still runs the earlier registry path) |
| **The runner** | drives the student's own Claude Code or Codex one-shot (tools off, JSON schema, prompt on stdin), an API key or a local model; retry, then escalation; a background token budget; a warm session pool | [`packages/runner`](../packages/runner/src/index.ts): `createModelRunner`, `createClaudeBackend`, `createCodexBackend`, `createApiBackend`, `createLocalBackend`, `createSessionPool` | tested in isolation |
| **Isolated client profiles** | the app runs the student's client under its own `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, signed in by the student in a built-in terminal; the student's own settings are untouched | [`apps/desktop/src/clients/`](../apps/desktop/src/clients/profiles.ts), onboarding screens | integrated; isolation verified on Claude Code and Codex 0.156.1 and 0.144.1 ([build record §5](course-backend-build-record.md#5-scores-and-measurements)) |
| **Prompt packs** | a versioned pack: role text, template, strict output schema, checks, Jev gates, cache key, data categories. Every quote is checked against the passages the call was given | [`packages/packs/core`](../packages/packs/core/src/index.ts): `definePack`, `quotesGrounded`, `buildPrompt`, `packCacheKey`; `runPack`, `readPackArtifact` in [`packages/core/src/jobs/pack.ts`](../packages/core/src/jobs/pack.ts) | tested in isolation; not yet run on real course content |
| **Learning engines** | FSRS scheduling on `ts-fsrs` with pre-exam reviews against real exam dates; a knowledge model (Elo plus rules R1–R6, bands with hysteresis); typed-answer grading with key ideas; Learn and Write modes; a session builder; calibration; the coverage map per assessment | [`packages/learning/src`](../packages/learning/src/fsrs.ts) (no barrel; import each module) | tested in isolation; the app's `learning` command answers `not_built` until its router is wired (N25) |
| **Read-only MCP course bank** | six stdio tools for the student's own AI client: `search`, `due_soon`, `recent_changes`, `course_overview`, `get_item`, `answer_course_question`; per-client grants, a token, a receipt per call | [`apps/desktop/src/mcp-server.ts`](../apps/desktop/src/mcp-server.ts), [`packages/core/src/mcp.ts`](../packages/core/src/mcp.ts) | integrated (on `main`); moving it behind a read-only reader is proposed (T50b) |
| **The versioned platform (D42)** | see below | [plan D42](plans/2026-09-26-course-backend/plan.md), [spec F3](plans/2026-09-26-course-backend/spec.md) | **proposed**; `packages/agent-api` is a placeholder with no code |

**The planned platform shape (D42, proposed).** Today a developer uses the packages in-process, inside this repository. The external platform adds:
- **A versioned read contract:** named SQL views `v<major>_<name>` and a typed SDK. The client states the contract version it wants, and a schema handshake answers whether it's supported. A view never changes shape within a major version; a missing field arrives as a new minor version.
- **Scoped, revocable, per-tool tokens** that reuse the MCP grants, rechecked on every call, with a receipt per call. Localhost is not authorization.
- **A narrow, atomic write path for student-owned artifacts only:** `deck.create`, `card.add`, `card.edit`, `note.save`, `review.record`. Each write is checked by code and reversible. Coursework and evidence tables are never writable, and planning data is never exposed.
- **MIT**, with the framework packages importing nothing from the desktop app, the gateway or licence code.

The evidence behind each choice (Zotero's version requests, AnkiConnect's "localhost alone is not authentication", Obsidian's atomic `process()`, Logseq's schema handshake) is recorded in [plan D42](plans/2026-09-26-course-backend/plan.md).

## 3. Developer quickstart

Node 24 and pnpm 10.29.2.

```sh
git clone https://github.com/benverhaalen/magic-uw.git
cd magic-uw
pnpm install
pnpm test        # the whole suite: 540/540 at 33b1827
pnpm check       # TypeScript across apps, packages and evals
```

**Where things live:** `packages/contracts` (types) → `domain` → `core` (queries, drain, pack job, MCP, egress) → `storage` (the store) → `retrieval`, `connectors`, `ai`, `runner`, `packs/core`, `learning`. The desktop app is `apps/desktop` (main process, utility worker, renderer). Aliases such as `@magic/storage` are in `tsconfig.json` `paths`; a new package needs its alias there, or `pnpm check` fails with TS2307.

**Read the store in-process and register a job handler.** Save this as `.data/try.ts` (git ignores `.data/`) and run `pnpm exec tsx .data/try.ts` from the repository root. It uses the synthetic sample course; it ran cleanly at `33b1827`.

```ts
import { readFileSync } from "node:fs";
import { createStore } from "@magic/storage";
import { createDrain } from "../packages/core/src/drain.ts";

const store = createStore(":memory:"); // or a file path; migrations run on open
store.ingest(JSON.parse(readFileSync("fixtures/course.json", "utf8")));

for (const r of store.resources()) console.log(r.kind, r.title);
const found = store.searchPassages({ query: "when is the essay due", k: 5 });
console.log(found.notFound ? "not in your materials" : found.hits.map((h) => `${h.title}: ${h.excerpt}`));

// A job: enqueue it against a subject, then drain with a handler for its kind.
store.enqueueSubject(
  { kind: "demo.count", subjectKind: "source", subjectId: "sample-course", sourceId: "sample-course", inputHash: "v1" },
  new Date().toISOString(),
);
const drain = createDrain({
  store,
  handlers: { "demo.count": async (job) => console.log(job.kind, job.subjectId) },
});
console.log(await drain.run()); // { done: 1, failed: 0, skipped: 0 }
store.close();
```

A handler throws to fail; the store retries with backoff, then gives up. A job whose subject changed before it finished is skipped, not applied.

**Add a prompt pack.** A pack is data plus checks; `definePack` refuses a schema that strict structured output can't accept. This snippet runs and type-checks at `33b1827`.

```ts
import { z } from "zod";
import { definePack, quotesGrounded } from "@magic/packs";

const cards = z.object({
  cards: z.array(z.object({ front: z.string(), back: z.string(), sourceId: z.string(), quote: z.string() }).strict()).min(1),
}).strict();
type Cards = z.infer<typeof cards>;

export const conceptCards = definePack<{ topic: string }, Cards>({
  id: "concept-cards",
  version: "v1",
  tier: "pass",
  system: "You write study cards from the passages. Quote the passage you used.",
  template: (i) => `Make cards on: ${i.topic}`,
  schema: cards,
  checks: [quotesGrounded((o: Cards) => o.cards.map((c) => ({ sourceId: c.sourceId, quote: c.quote })))],
  cacheKey: (i) => ({ topic: i.topic }),
  categories: ["course_text"], // data categories for the consent decision (spec G)
});
```

`runPack` runs it: the cache first (a hit costs 0 tokens), then the consent check, then one call through the runner, then the checks, with a ledger row per call. `readPackArtifact` reads a stored result without a runner. [`tests/packs.test.ts`](../tests/packs.test.ts) runs a pack end to end against a fake CLI; start from it.

## 4. The decisions, with evidence

| Decision | What we did | Why it wins | Evidence |
|---|---|---|---|
| **AI writes, code decides** ([spec §2](plans/2026-09-26-course-backend/spec.md)) | Code does whatever has one right answer (dates, IDs, permissions, quotes); Jev makes small typed judgments; the student's AI gets one checked call only where language must be read or written | The answers that must be exact never depend on a model; model calls are few and checkable | The quote checks in `putAssessmentScope`, `putCourseBrief` and `quotesGrounded`; runner tests check the tools-off argument lists (`tests/runner.test.ts`). Tested in isolation |
| **Zero tokens during study** | `readPackArtifact` takes no runner, so a study-time read can't call a model; the learning engines have no runner dependency | Studying never spends the student's AI allowance or waits on a provider | `packages/core/src/jobs/pack.ts`; the learning suites. Tested in isolation; no study UI exists yet to show it end to end |
| **The student's own AI in an isolated profile** (D35, D36, D45) | Detect the installed CLI with local version checks, run it under an app-owned `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and let the student sign in through the provider's own flow in a built-in terminal | No developer key and no hosted model spend on our side; the student's own Claude Code or Codex settings are untouched; the app never reads a credential | The isolated profile reports "Not logged in" and `~/.claude`, `~/.claude.json` and `~/.codex` stay untouched ([build record §5](course-backend-build-record.md#5-scores-and-measurements)); `CLAUDE_CONFIG_DIR` per [Claude Code env vars](https://code.claude.com/docs/en/env-vars) (checked 2026-09-26). Integrated. The subscription route itself is open decision H5 |
| **Byte-stable prefix plus content-hash cache** | The role text and course frame form an identical prefix across calls for a course; results are keyed by a hash of the pack, prompt, input and passages | A repeat costs 0 tokens; the stable prefix lets the provider's own prompt cache hit | A cache hit writes a `cache_hit` ledger row with no model call (`tests/packs.test.ts`). Tested in isolation; the provider-side hit rate isn't measured |
| **Warm sessions** (D38) | One warm CLI session per open course instead of a new process per call, with our own short system prompt | Seconds saved on every ask, and fewer fixed tokens | Measured on one laptop: about 2 s warm against 6–7 s cold; fixed tokens 11.3k → 2.8k ([plan D38](plans/2026-09-26-course-backend/plan.md)). Tested in isolation; spikes S1–S10 decide whether it's the default |
| **Store vs link, and compressed summaries** (D40, D46) | Text that can be quoted becomes passages; tools and platforms with their own login become link cards opened in the browser; new payloads are compressed; a summary tier per material is planned | Stores what can be checked, never scrapes a third-party login, and keeps model context small | Size per 1,000 resources 15.6 → 10.3 MB (MT1, synthetic). Payload compression integrated; the summary tier is proposed |
| **Per-course change detection from Canvas's own stream semantics** (D37) | A hot tick on `todo` and `upcoming_events`; a per-course content probe every 15 minutes and on focus; warm reads only of courses that moved | The account-wide activity stream doesn't carry files, pages or module items, so it can't see a quietly added lecture file | The stream's item types are listed in [canvas-lms `lib/api/v1/stream_item.rb`](https://github.com/instructure/canvas-lms/blob/master/lib/api/v1/stream_item.rb) (checked 2026-09-26). A hot tick costs 1–1.7% of a full sync; a new undated file was found within 15 minutes and only its course re-read (synthetic). Integrated |
| **Access state per course space** (D41) | Every place a course keeps content gets a state: readable, needs UW sign-in, needs its own login, link-only or blocked | The student sees what the app can't reach instead of silent gaps; the app never launches an LTI tool | Live: 5 hidden Pages lists came back 404 and were marked inaccessible, not signed out ([build record §6](course-backend-build-record.md#6-live-trial-results)). Integrated in the sync; persistence tested in isolation |
| **Consent before any network request** (T06) | One setup checkbox writes a consent record per recipient; main's gate and the worker's own public clients refuse every network channel without it; a new sensitive category is held for a preview bound to the payload's hash | The fewest clicks that still keep every send inspectable, with a receipt | A spy test counts 0 requests before the checkbox (`tests/egress.test.ts`). Integrated |
| **Expiry confirmed before "Sign in again"** (T05c) | Only a login redirect, a login page, or a 401 whose body says `unauthenticated` counts as expiry; a permission error marks only that area | No false "Sign in again" when one course area is merely forbidden | `tests/session.test.ts`; the live trial's 404s were not treated as sign-outs. Integrated |
| **Extraction recipes written once by a model, then replayed by code** (D32) | For a course platform code doesn't know, a model writes an extraction recipe keyed by host and layout hash; code replays it and records hits and misses | A layout costs one model call, not one per page | The `extraction_recipes` table and `putExtractionRecipe`, `extractionRecipe`, `recordRecipeUse`. Tested in isolation; the recipe-writing step is proposed |
| **Contentless passage FTS** (D46) | FTS5 in contentless-delete mode keyed by passage rowid; excerpts cut by offset from the one stored copy | The text is stored once, and deletes stop scanning the table | The FTS content copy was 31% of the database in the spike; ingest 78 → 1,431 resources/s at 5,000 (MT1, synthetic); [SQLite contentless-delete tables](https://www.sqlite.org/fts5.html#contentless_delete_tables). Integrated |
| **One-transaction migrations with a backup** | A `VACUUM INTO` copy first, then every pending step in one `BEGIN IMMEDIATE` that re-reads the version; restore through `node:sqlite` | A failure can't leave the file at an intermediate version | v5 → v7 with backup in 1.60 s with 0 rows lost (MT1, synthetic); [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto). Integrated |

### 4b. Retrieval efficiency and cost against the original architecture

Synthetic MT1 at 5,000 resources, one Windows laptop:

| Metric | Before → after |
|---|---|
| Ingest | 78 → 1,431 resources/s |
| Search p50/p95 | 56/197 → 3.3/4.8 ms |
| Size per 1,000 resources | 15.6 → 10.3 MB |
| Purge | 8.7 → 0.48 s |
| Question recall@5 (52 planted questions) | 0 → 1.00 |
| Correct "not found" (26 questions) | 0.96 |
| UI payload | 30.6 MB snapshot → 17.5 KB summary query |

Two secondary rows still miss their targets, and the planted questions were written by the builder. The full table, its caveats and the AI cost structure are in [build record §7](course-backend-build-record.md#7-retrieval-efficiency-and-cost-versus-the-original-architecture).

## 5. Scorecard

**How to read it.** Competitor cells come from each vendor's own pages, checked 2026-09-26; the reference numbers point to the sources list below. "Not stated" means we found no statement; it doesn't mean "no". Our cells carry their build status.

**Where we lead on evidence today:**
- **Canvas connects automatically for a student alone,** with no admin setup. Every other tool that connects to Canvas needs an institution to enable it, or doesn't document Canvas at all.
- **Local-first and open source, with Canvas.** Open Notebook and Anki are open and local, but have no LMS connection.
- **No study-time token cost and no daily artifact quotas.** Studying runs on code; generated results are cached, so a repeat costs 0 tokens.
- **Code-verified quotes.** Others cite sources; none states that the quote is checked against the source text.

**Where quality is not yet measured.** We make no claim that our answers or questions are better than anyone's. The blind quality benchmark (spec B6; blind scoring on a public MIT OpenCourseWare course against a rubric fixed before the run; see [benchmarking](notes/benchmarking.md)) is **protocol fixed, run pending**. We found no published accuracy figures from any of the ten vendors below, so that run would be the first public measurement of its kind.

### My Magic UW

| Criterion | My Magic UW | Status |
|---|---|---|
| Price for a student | Code MIT and free; generation runs on the student's own AI plan or key. The product price is open decision H1 ([plan §9](plans/2026-09-26-course-backend/plan.md#9-open-human-calls)): $5 lifetime for the hosted Jev service, or a $5 one-time licence | proposed |
| Automatic Canvas connection for a student alone | yes: the student's own UW sign-in; no school deployment | integrated; shown on one live account |
| Quoted, code-verified citations | every quote checked by code against the exact source version | validator tested in isolation; grounded chat proposed |
| Exam-scope grounding | each assessment's scope stored with the instructor's quote, validated against the resource version | storage tested in isolation; the mapping pass proposed |
| Spaced repetition | FSRS (`ts-fsrs`), with reviews placed before real exam dates | tested in isolation; UI proposed |
| Per-topic progress analytics | per-topic knowledge states, calibration and a coverage map per assessment, all recomputable from raw answers | tested in isolation; display proposed |
| Local or offline | one SQLite file on the student's computer; study works offline; generation needs the student's AI or a local model | integrated |
| Open source | MIT ([LICENSE](../LICENSE)) | integrated |
| Usage quotas | none set by the app; the student's provider limits apply; a daily background token budget protects their plan | tested in isolation |
| Cost during study | 0 model tokens | tested in isolation |
| Published benchmarks | backend performance before and after, with the misses ([build record §5](course-backend-build-record.md#5-scores-and-measurements)); quality: protocol fixed, run pending | measured (performance); pending (quality) |

### AI assistants and notebooks

| Criterion | NotebookLM (Gemini Notebook) | ChatGPT Study Mode | Claude learning mode | Gemini study notebooks |
|---|---|---|---|---|
| Price for a student | free tier; higher limits on paid Google AI plans [1] | free and paid plans [8] | free; Pro $20/mo ($17 billed annually) [9] | Google AI Pro for Education, $20–24 per user [10] |
| Canvas for a student alone | no: Gemini LTI imports Canvas files only after the institution's admin sets it up [5] | not found [8] | only through an institution's admin [9] | Gemini LTI needs Canvas and Google admins [5], [10] |
| Quoted citations | "uses direct quotes… from your sources as citations"; checking not stated [3] | not stated [8] | "proper citations" (literature reviews) [9] | not specified [10] |
| Exam-scope grounding | not stated | not stated | not stated | not stated |
| Spaced repetition | not stated | not stated [8] | not stated [9] | not stated [10] |
| Per-topic progress analytics | progress tracking on flashcards and quizzes; per topic not stated [4] | not stated [8] | not stated [9] | "track your proficiency" [10] |
| Local or offline | no: a hosted service [1] | no [8] | not stated [9] | no [10] |
| Open source | no | no [8] | no [9] | no [10] |
| Usage quotas | compute-based limits from 2026-09-02, refreshing every 5 hours up to a weekly limit [2]; 50 sources per notebook on Free [6] | "does not add extra messages, bypass rate limits" [8] | plan limits [9] | up to 600 sources, by plan [10] |
| Cost during study | chats, quizzes and flashcards count against the limits [1], [2] | messages count against plan limits [8] | plan limits [9] | not stated |
| Published benchmarks | none from Google found; one third-party clinical study [7] | none found | none found | none found |

### Study apps and open tools

| Criterion | Quizlet | StudyFetch | Knowt | RemNote | Anki | Open Notebook |
|---|---|---|---|---|---|---|
| Price for a student | Plus $35.99/yr; Plus Unlimited $44.99/yr [11] | free start; paid "as low as" $8/mo [15] | free; Ultra $199.99/yr [16] | free; Pro $8/mo; Pro+AI $18/mo [18] | free desktop version [19] | free, self-hosted [22] |
| Canvas for a student alone | no: a Google Classroom add-on, no direct Canvas integration documented [14] | not stated [15] | "LMS Integration (Canvas, Google Classroom, etc.)" on the plan for schools [17] | not stated [18] | not stated | none [22] |
| Quoted citations | not stated | "citations back to your original materials" [15] | not stated | not stated | n/a (no generation) | "Basic references (will improve)" [22] |
| Exam-scope grounding | not stated | not stated | not stated | not stated | not stated | not stated |
| Spaced repetition | adaptive Learn [12] | yes (Again/Hard/Good/Easy) [15] | yes [16] | yes [18] | FSRS, 90% default desired retention [20] | not stated [22] |
| Per-topic progress analytics | Progress, Plus only [13] | covered topics [15] | a teacher-side hub (mastery per card and per file) [16] | not stated [18] | reviews, forecast, true retention, FSRS stability and retrievability [21] | not stated [22] |
| Local or offline | not stated | not stated | not stated | "work fully offline" [18] | a desktop app; sync optional [19] | "100% local" [22] |
| Open source | no | no | no | no | AGPL-3.0 or later [23] | MIT [22] |
| Usage quotas | Plus: 3 practice tests and 20 Learn rounds per month [11] | not stated | "unlimited rounds of our free learn mode" [16] | Pro+AI: 50 AI runs per month [18] | not stated | depends on the model provider [22] |
| Cost during study | Learn rounds and tests capped on Plus [11] | not stated | not stated | AI runs capped [18] | not stated | each model call is paid to the student's provider [22] |
| Published benchmarks | none found | none found | none found | none found | not checked (Anki doesn't generate answers) | none found |

### Sources (all checked 2026-09-26)

1. NotebookLM plans, limits and data use: https://support.google.com/notebooklm/answer/16213268
2. Gemini Notebook compute-based usage limits: https://support.google.com/gemininotebook/answer/17670842
3. NotebookLM chat citations: https://support.google.com/notebooklm/answer/14276569
4. NotebookLM flashcards and quizzes: https://support.google.com/notebooklm/answer/16958963
5. Gemini LTI for Canvas (institution setup): https://support.google.com/edu/assignments/answer/15672329
6. NotebookLM sources: https://support.google.com/notebooklm/answer/16215270
7. Third-party grounding study (86% vs 39% on lung-cancer staging): https://pubmed.ncbi.nlm.nih.gov/39585559/
8. ChatGPT Study Mode: https://help.openai.com/en/articles/11780217
9. Claude for Education: https://www.anthropic.com/news/introducing-claude-for-education
10. Gemini study notebooks: https://support.google.com/gemini/answer/16972047
11. Quizlet plans: https://quizlet.com/upgrade
12. Quizlet Learn and Test: https://help.quizlet.com/hc/en-us/articles/360030841732
13. Quizlet Progress: https://help.quizlet.com/hc/en-us/articles/360048803491
14. Quizlet and LMSs: https://help.quizlet.com/hc/en-us/articles/45955621176589
15. StudyFetch flashcards: https://www.studyfetch.com/use-case/flashcard
16. Knowt: https://knowt.com, https://knowt.com/plans, and its help centre, https://help.knowt.com (teacher progress hub, article 10721997)
17. Knowt for teachers: https://knowt.com/teachers
18. RemNote offline mode and plans: https://www.remnote.com/feature/offline-mode
19. Anki downloads: https://apps.ankiweb.net/ and sync: https://docs.ankiweb.net/syncing.html
20. Anki deck options (FSRS): https://docs.ankiweb.net/deck-options.html
21. Anki statistics: https://docs.ankiweb.net/stats.html
22. Open Notebook (v1.14.0, MIT): https://github.com/lfnovo/open-notebook
23. Anki licence: https://github.com/ankitects/anki/blob/main/LICENSE

The earlier two-product comparison, with its honest reading of where each competitor is ahead, is in [competitive comparison](notes/competitive-comparison.md).

## 6. Open source for Badger developers

**Licence:** MIT ([LICENSE](../LICENSE)).

**What you could build on it:**

| Tool | What it reads | Works today | Needs |
|---|---|---|---|
| A lab-report checker | the lab's assignment text and rubric passages, `searchPassages` for the stated requirements, a pack whose checks quote the rubric | in-process, inside this repo | D42 to run outside it |
| A group-project planner | assessments, dates and weights, course sessions | in-process (`assessments()`, `courseSessions()`) once the course pass fills them (T21, T22) | T21/T22; D42 |
| A flashcard exporter to Anki | the student's cards and reviews (v7 learning tables) | not yet | D42's read contract (`v<major>_` views) |
| A course-schedule bot | due dates, events and changes through the scoped queries and the change cursor | in-process (`runQuery`) | D42 plus a scoped token to run as its own process |

**How to contribute:** fork, branch as `feat/<name>`, keep `pnpm check` and `pnpm test` passing, add tests beside the existing ones in `tests/`, and open a pull request to `main`. Shared-package changes (contracts, storage, core) are reviewed as a team because the app and every tool depend on them. A schema change goes through `packages/storage` only, as a new version with its purge coverage.

**Rules every tool must keep** (from [AGENTS.md](../AGENTS.md)):
- **No school actions.** Nothing submits, enrols, posts or marks anything complete. Reading may register a page view, and the app discloses that.
- **Planning data is never exposed.** My UW records (enrolment, DARS, holds) never go to AI, Jev, MCP or the platform.
- **Never automate Duo or bypass expiry;** use the app's own sessions, never a personal browser profile.
- **Private coursework, credentials, sessions and unredacted captures stay out of Git and logs.** Test with synthetic fixtures.
- **Page content is untrusted** and can't authorize an action; a model is never an authorization.
- **Exact facts stay in code:** dates, IDs, permissions and budgets.

## 7. Roadmap

The build order is [architecture §2](course-backend-architecture.md#2-where-we-are). Next, in short:
- **Sync speed:** the parallel first read (target ≤10 s), `include[]=items` for module items, and one sync per sign-in ([build record §6](course-backend-build-record.md#6-live-trial-results)).
- **Wire what's tested in isolation:** the drain and the pack job in the worker with real course content, the learning router (N25), and course spaces persisted.
- **Understand and generate:** Jev item cards (T20), the course pass and mapping (T21, T22), then the generation packs and the study surfaces.
- **The platform:** the typed academic API (T50a), then the read contract, SDK, scoped tokens and write path (D42: T68, T69, T55).
- **Measure:** the public comparison and the blind quality run (spec B6, MT7a/MT7b), with the rows we lose published too.
