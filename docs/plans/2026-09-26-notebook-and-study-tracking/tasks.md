# Tasks: course notebook and study tracking

**Status: proposed.** These tasks implement [spec.md](spec.md), written against `main` at `73ff7a6`. Requirement IDs (NB-*, ST-*, KM-*) refer to spec §4.

## How to read this
- **Vertical slices.** Each task delivers one testable behaviour end to end within its files.
- **One writer per file.** `owns` lists every file a task may create or edit. No two tasks own the same file. Tests import modules by relative path until N23 adds the barrel.
- **Every task has a runnable check** (`argv`, `expectExit`) and at least one negative acceptance, marked **¬**.
- **The base gate for every task:** `pnpm check` exits 0. Ben's existing tests still pass, except the known Windows failure of the `0o600` file-mode assertion in `tests/storage.test.ts` ([where we differ, row 14](../../notes/where-we-differ.md)) until B09 lands.
- **Seats:**
  - `implementer`: fully specified work
  - `implementer-deep`: work that needs judgment while it's done
  - `executor`: mechanical work
  - `design-engineer`: UI
- **Models:** Opus for judgment, Sonnet for specified work.
- **Two groups:**
  - **Part A:** new files in new packages. No approval needed beyond normal review.
  - **Part B:** changes to Ben's files (contracts, storage, core, ai, connectors, apps, root config and lockfile). Each goes to him as a PR that carries its rationale (the spec section and evidence). The decision is already made; the PR is how the code lands in packages he owns.
- **Status:** every task is proposed; none is built.

**Format**
```
<id> <title>
  seat, model, owns, dependsOn, check {argv, expectExit}, accepts[], done
```

---

## Phase 0: the demo minimum (Sunday 2026-09-27 ~10:00 CT)

It's about 17:45 on Saturday, so the demo is **headless and scripted**, not in-app.

**Material:** the course's syllabus and assignments from Canvas (what the connector reads today), or explicitly **labelled imported material**. Never presented as Canvas, and never as synthetic.

| Task | Why it's in the minimum |
|---|---|
| N00 | versioned thresholds |
| N01 | passages and quote checks |
| N27 | the course AI policy |
| N04 | the policy gate |
| N02 | retrieval |
| N03 | a grounded answer, with the model injected |
| N05 | the concept map and tags |
| N06 | checked items |
| N07 | the knowledge model |
| N11 | the in-memory store |
| N20 | the Claude route that powers the scripted run |
| N28 | the scripted headless run |
| N29 | committed synthetic smoke cases, frozen |
| N22 | smoke and demo reports |

**After the demo** (Phase 1 or later): N08, N09, N10, N12, N13, N14, N15, N16, N18, N19, N21, N23, N24, N25, N26, and **every B task**. In Phase 0 the answer composer receives passages inline (N03 with an injected `generate` backed by N20). The MCP tools arrive in Phase 1.

**The order, respecting dependencies** (steps 1–2 run in parallel):
1. N00, N01, N20 and N29 (in parallel)
2. N27 and N02 (after N01) · N05 (after N01)
3. N04 (after N27)
4. N03 (after N01, N02, N04) and N06 (after N01, N04, N05), in parallel
5. N07 (after N00, N05)
6. N11 (after N06)
7. N22 (after N03, N06, N07, N11)
8. N28 (after N22, N20)

**The critical path** is N01 → N05 → N06 → N11 → N22 → N28. The chain N01 → N05 → N06 → N08 → N09 → N10 is serial, which is one reason Learn and sessions wait until after the demo.

---

## Part A: new packages (our code; normal review)

### Tasks (the demo minimum is marked in the table above)

```
N00 Versioned knowledge-model configuration
  seat: executor   model: sonnet
  owns: [packages/learning/src/config.ts, packages/learning/src/types.ts, tests/learning-config.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-config.test.ts"], expectExit: 0 }
  accepts:
    - exports CONFIG with version "km-0.1" and every constant in spec §5.9 (α, β, s0, b_ref, priors, band cut-offs, rule windows, R5 margin, R6 gap, priority weights, difficulty bands, the retrieval support threshold, minutes per item by format)
    - types.ts defines the spec §8.1 result types once (Citation, Answer, ConceptView, Grade, SessionPlan, Coverage) until B01 moves them into contracts
    - a zod schema validates the config; each constant carries `validated: false`
    - ¬ a config missing any constant, or with a band cut-off outside (0,1), fails validation
  done: one importable, versioned source of every threshold (KM-12)

N01 Passages with offsets and the exact-quote validator
  seat: implementer   model: sonnet
  owns: [packages/learning/src/passages.ts, packages/learning/src/quotes.ts, tests/learning-passages.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-passages.test.ts"], expectExit: 0 }
  accepts:
    - splitPassages(resource) returns passages with resourceId, contentHash, textHash, start, end, heading; joining them reproduces resource.text exactly
    - textHash = sha256(title + text); it is unchanged when only `submitted` or `points` change
    - validateQuote(resourceText, quote, start?, end?) returns offsets for an exact span of 12–400 characters
    - ¬ a paraphrase, a one-character-off span, a quote from another version, and a 5-character quote are all rejected; no fuzzy repair
  done: NB-3, and the code half of NB-4

N02 Course-scoped passage retrieval and not-found
  seat: implementer   model: sonnet
  owns: [packages/learning/src/retrieve.ts, tests/learning-retrieve.test.ts]
  dependsOn: [N01]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-retrieve.test.ts"], expectExit: 0 }
  accepts:
    - OR-joined content-word query; BM25 over the passages of included sources; top 8, text ≤1,200 characters each
    - returns scope {searched, excluded, missing[], capturedAt}; below the support threshold it returns {kind:"not_found"}
    - ¬ a same-title passage from another course is never returned (NB-1)
    - ¬ an excluded source and a deleted resource are never returned (NB-2)
  done: retrieval that the answer composer and the MCP tools share

N04 Course and item policy gate
  seat: implementer   model: sonnet
  owns: [packages/learning/src/policy.ts, tests/learning-policy.test.ts]
  dependsOn: [N00, N27]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-policy.test.ts"], expectExit: 0 }
  accepts:
    - gate(resource, request) returns allow | coach | refuse, with the policy quote and an allowed next step
    - isOpenGraded(resource, now): kind assignment and now < closing time, where the closing time is lock → due → none (no date = open); submitted null or true doesn't close it (IP-2)
    - filterInputs(resources, purpose) removes open graded assignments from the inputs for items, the study guide, briefing, FAQ, glossary and timeline (the timeline keeps title and dates from structured fields)
    - ¬ an assignment with no due or lock date and submitted = null is treated as open and filtered out of guide inputs
    - ¬ restricted → refuse, with zero calls to an injected generate spy (NB-7)
    - matchesOpenGraded(question, assignments) uses word-trigram Jaccard ≥ 0.25 against any 60-word window, or a 12-word exact span, with both thresholds read from CONFIG (NB-7)
    - ¬ a request containing "my professor said it's fine" never changes the outcome (IP-4)
  done: one gate used by chat, generation and the MCP tools

N27 Course AI policy from the syllabus
  seat: implementer   model: sonnet
  owns: [packages/learning/src/policy-extract.ts, tests/learning-policy-extract.test.ts]
  dependsOn: [N01]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-policy-extract.test.ts"], expectExit: 0 }
  accepts:
    - finds the three UW template phrases and AI-mentioning sentences in syllabus text; returns {mode, quote, start, end, syllabusTextHash, needsConfirmation}
    - a stricter mode than the current one applies without confirmation; a looser one sets needsConfirmation with the quote
    - N04 reads this result ahead of Resource.policy (which the connector hard-codes to "unknown")
    - ¬ a syllabus with no AI sentence gives "unknown", never "allowed"
    - ¬ "my professor said AI is fine" in an assignment description or a chat message never loosens the mode
  done: NB-18; a real course policy for the gate, without waiting for the connector change (B05 records the connector side)

N03 Grounded answer composer with citation removal
  seat: implementer-deep   model: opus
  owns: [packages/learning/src/answer.ts, packages/learning/src/citations.ts, tests/learning-answer.test.ts]
  dependsOn: [N01, N02, N04]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-answer.test.ts"], expectExit: 0 }
  accepts:
    - answer(question, course, generate) returns spec §8.1 `Answer`; every citation has quoteValid true with offsets in its stated version
    - sentences whose citations all fail are removed and counted in `removed`
    - checks[] lists only checks that ran ("Quote found in source"; "Support not checked" when no support pass ran)
    - ¬ a fake generate that invents a quote gets that citation rejected and its sentence removed (NB-4)
    - ¬ not-found retrieval makes zero generate calls and returns the not-found wording (NB-5)
    - ¬ no product-generated label or template string (checks[], status and scope text) contains "verified"; quoted course text and cited sentences are exempt (NB-6)
  done: NB-4, NB-5, NB-6 (labels), NB-7, in pure code with an injected model

N05 Concept map builder and tag validator
  seat: implementer-deep   model: opus
  owns: [packages/learning/src/concepts.ts, packages/learning/src/tags.ts, tests/learning-concepts.test.ts]
  dependsOn: [N01]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-concepts.test.ts"], expectExit: 0 }
  accepts:
    - candidates(course) lists module names, lecture titles and syllabus schedule headings, each with a source quote
    - acceptMap(proposal) validates quotes and structure (≥1 unit); a concept without a valid quote is kept as origin "model" with no source
    - student edits (rename, merge, hide, restore) are re-applied on top of a rebuilt map
    - validateTags(item, map) requires 1–3 concepts of the same course with exactly one primary
    - ¬ a rebuild never drops or overwrites a student edit (KM-1)
    - ¬ 0 tags, 4 tags, an unknown ID and another course's ID are each rejected (KM-2)
  done: KM-1, KM-2

N06 Checked-item pipeline, flaw rules and truthful labels
  seat: implementer-deep   model: opus
  owns: [packages/learning/src/items.ts, packages/learning/src/flaws.ts, packages/learning/src/labels.ts, packages/learning/src/arith.ts, tests/learning-items.test.ts]
  dependsOn: [N01, N04, N05]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-items.test.ts"], expectExit: 0 }
  accepts:
    - runs stages 1–9 of spec §6.3 in order; the item's check line lists exactly the stages that ran and passed (labels from spec §6.4)
    - the arithmetic evaluator parses numbers, + − × ÷, parentheses and units, and never calls eval or Function
    - items can be accepted as a family: MC and typed variants sharing family_id, key ideas and sources; each variant passes the stages on its own, and a family with a failing variant keeps only its passing variants
    - near-duplicate: a Jaccard similarity of normalised token trigrams ≥0.8 against seen stems means rejection
    - ¬ items with a failing quote, two keys, duplicate options, "all of the above", or a longest-option key (by more than 30%) are each dropped with the stage and reason logged (ST-1)
    - ¬ items from an open graded assignment are dropped at stage 1
    - ¬ no check-label string produced by labels.ts contains "verified", "correct" or "accurate" (scope: our labels only, not item stems, options or quoted source text)
  done: ST-1, ST-10 (explanation citation check), spec §6.3 and §6.4

N07 Knowledge model: evidence filter, Elo update, rules R1–R6, bands
  seat: implementer-deep   model: opus
  owns: [packages/learning/src/knowledge/events.ts, packages/learning/src/knowledge/elo.ts, packages/learning/src/knowledge/rules.ts, packages/learning/src/knowledge/state.ts, tests/learning-knowledge.test.ts]
  dependsOn: [N00, N05]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-knowledge.test.ts"], expectExit: 0 }
  accepts:
    - conceptState(events, map, config, now, rByConcept?) is pure; the same inputs give deep-equal output (KM-4)
    - implements spec §5.3 exactly; a fixture replays every row of the §5.5 worked-check table and matches the band and R1 columns
    - each of R1–R6 has a firing test and the "must not fire" tests listed in spec §5.6; reasons carry event IDs and a clearsWhen string (KM-5, KM-8)
    - ¬ R1 never fires when every scored answer is correct, in any format: 3/3 MC, 4/4 MC, 10/10 T/F, 20/20 MC
    - hysteresis uses the band and R1 state computed after the prior event: Solid → Getting there only when p_low < 0.65; R1 enters at p̂ < 0.60 and exits at p̂ ≥ 0.65 or acc ≥ 0.70 (the "3 wrong, then 4 right" row stays Iffy)
    - ¬ hinted, explained, disputed, quarantined and same-session repeat attempts leave θ and n unchanged
    - ¬ the exported ConceptView type and its JSON contain no theta, p_hat, probability or percent fields (KM-6)
    - ¬ a self-rating alone never moves a concept out of Not seen yet (KM-9, KM-11)
  done: the heart of the knowledge model, as pure functions

N08 Typed-answer grading with a key-idea checklist
  seat: implementer   model: sonnet
  owns: [packages/learning/src/grade.ts, tests/learning-grade.test.ts]
  dependsOn: [N06]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-grade.test.ts"], expectExit: 0 }
  accepts:
    - code normalisation (case, whitespace, punctuation, listed synonyms) runs first; unresolved key ideas go to an injected judge (Jev or model); score = found / required
    - returns spec §8.1 `Grade` with keyIdeas[] and the method used for each idea
    - ¬ "Binary Search Tree" vs "binary search tree." grades correct without calling the judge
    - ¬ with no judge available and student_work sharing off, unresolved ideas are "not checked" and the attempt is not scored
  done: ST-3 grading

N09 Learn rounds and the mistakes queue
  seat: implementer   model: sonnet
  owns: [packages/learning/src/learn.ts, packages/learning/src/mistakes.ts, tests/learning-learn.test.ts]
  dependsOn: [N06, N07, N08]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-learn.test.ts"], expectExit: 0 }
  accepts:
    - rounds of 7 item families; each family is linked variants (MC and typed) sharing family_id; MC variant → typed variant after one correct; a miss drops one stage and returns after ≥2 other families; each attempt is recorded against the variant used, with that variant's format and prior (ST-3)
    - the mistakes queue orders confident misses first; a spaced unassisted success lowers priority; nothing retires (ST-6)
    - ¬ the typed stage never exposes options
    - ¬ a flagged or quarantined item leaves the queue at once and never returns while flagged (ST-9)
  done: ST-3, ST-6, ST-9 (queue side)

N10 Priority function and session builder
  seat: implementer   model: sonnet
  owns: [packages/learning/src/priority.ts, packages/learning/src/session.ts, tests/learning-session.test.ts]
  dependsOn: [N07, N09]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-session.test.ts"], expectExit: 0 }
  accepts:
    - priority_c follows spec §5.7; the plan's block order is R4 items (≤3) → due mistakes → due cards → Learn; each block has a reason string
    - difficulty is a preference: among eligible items, pick the one whose predicted P is nearest the band (warmup, normal, push)
    - ¬ a pool with no item inside the band still fills the block with the nearest items; the plan never comes back empty because of the band
    - ¬ with no evidence the plan is a labelled diagnostic of ≤8 items (ST-7, KM-9)
    - ¬ planned length never exceeds the requested minutes by more than one item
  done: ST-7, KM-7 (session)

N11 LearningStore interface and in-memory implementation
  seat: implementer   model: sonnet
  owns: [packages/learning/src/store.ts, packages/learning/src/memory-store.ts, tests/learning-store.test.ts]
  dependsOn: [N01, N05, N06]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-store.test.ts"], expectExit: 0 }
  accepts:
    - implements every method in spec §7.4 in memory, with the same immutability and uniqueness rules as the SQL tables in spec §7.2
    - markStale(resourceId, newHash) flags dependent artifacts, items and cards; items whose quote no longer validates become quarantined "source changed" (NB-13)
    - ¬ an attempt with an existing ID and different content throws; a review row can't be edited; an attempt on a student-made item with no source resource is accepted
    - ¬ after reset(), every collection is empty (the purge analogue, KM-13)
  done: the store used by the harness, the router tests and the MCP tests

N12 Guide artifacts: schemas, validation, timeline dates, emphasis
  seat: implementer   model: sonnet
  owns: [packages/learning/src/artifacts.ts, packages/learning/src/emphasis.ts, tests/learning-artifacts.test.ts]
  dependsOn: [N03, N07]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-artifacts.test.ts"], expectExit: 0 }
  accepts:
    - zod schemas for study_guide, briefing, faq, glossary, timeline; acceptArtifact drops entries without a quote-valid citation and counts them (NB-8)
    - timeline: every date parses, and its date string occurs in the entry's quote
    - emphasis(guide, states) orders by module, marks Iffy "Iffy for you", collapses Solid, and doesn't change the guide body (NB-9)
    - ¬ with no evidence, no concept is marked; the emphasis markers and headings that emphasis.ts adds contain no digits other than counts and dates (the guide body and its quotes are exempt)
    - ¬ a timeline entry whose date isn't in its quote is dropped
  done: NB-8, NB-9 (logic)

N13 Exam coverage, code layer
  seat: implementer   model: sonnet
  owns: [packages/learning/src/coverage.ts, tests/learning-coverage.test.ts]
  dependsOn: [N02, N05]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-coverage.test.ts"], expectExit: 0 }
  accepts:
    - finds coverage statements in syllabus text (patterns for "covers", "Exam N", "Midterm", "chapters", "modules", "weeks"), returns them as Citations, and maps them to concepts where the labels match
    - computes the schedule window (previous assessment → this one) and labels concepts from it basis "schedule_window"
    - picks the tier: T1/T2 when a this-term statement or practice exam exists, T3 when only past-term exams exist (with the warning), T4 otherwise
    - ¬ with no statement, the result's first warning is "No coverage statement found"
    - ¬ no template string that coverage.ts writes (basis labels, warnings, headings) contains "will be on"; a quoted instructor statement that says it is exempt and shown as a quote
  done: NB-11 (Phase 0 scope), the tier input for ST-4

N18 Magic tools: handlers, schemas, receipts (no transport)
  seat: implementer-deep   model: opus
  owns: [packages/magic-tools/src/tools.ts, packages/magic-tools/src/schemas.ts, packages/magic-tools/src/receipts.ts, tests/magic-tools.test.ts]
  dependsOn: [N02, N03, N04, N06, N11, N13, B01, B11]
  check: { argv: ["pnpm","exec","tsx","--test","tests/magic-tools.test.ts"], expectExit: 0 }
  accepts:
    - every tool in spec §8.3 exists as a pure handler(input, ctx) with zod input and output schemas
    - every handler that returns course text calls ctx.receipt with recipient, categories, resourceIds and characters
    - handlers call the N04 gate; artifact_save and items_submit run N12 and N06 validation
    - ¬ oversized inputs are refused, not truncated; in local_only privacy every text-returning tool refuses (IP-7)
    - ¬ knowledge_summary refuses unless the learning_state category is allowed (IP-8)
    - ¬ no handler output contains a URL, account ID, grade or attempt row
  done: the tool logic for the CLI, testable without the MCP SDK

N20 Agent runtime: adapter interface, detection, Claude route
  seat: implementer-deep   model: opus
  owns: [packages/agent-runtime/src/adapter.ts, packages/agent-runtime/src/detect.ts, packages/agent-runtime/src/claude.ts, packages/agent-runtime/src/events.ts, tests/agent-runtime.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","--test","tests/agent-runtime.test.ts"], expectExit: 0 }
  accepts:
    - detect() checks PATH and the documented install locations and runs --version through an injected runner (no shell)
    - status() for Claude keeps only loggedIn, authMethod and subscriptionType from `claude auth status --json`
    - start/send/events/stop drive `claude -p` stream-json with `--setting-sources project,local --strict-mcp-config --mcp-config <ours>`, mapped to one event type
    - built-in tools are off: the argv carries the exact `--allowedTools "mcp__magic__*"` and `--disallowedTools "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch,NotebookEdit,Task"` values from spec §8.3, plus `--permission-prompts none`; the tool names are checked against the installed CLI's `--help`, and a mismatch fails start()
    - the working directory is a fresh, empty scratch folder per session, deleted on stop()
    - ¬ a live probe script (run with the operator present, since it needs a signed-in CLI) asks the agent to read the workspace database path; the transcript shows the tool call denied or absent, and none of the file's bytes appear in the output
    - ¬ the runner is never invoked with a path under the CLI's credential directory; status output fields other than the three are discarded (IP-14)
    - ¬ a runner error or a non-zero exit becomes {status:"signed_out"|"missing"|"limited"}, never an unhandled rejection
  done: the Phase 0 provider route, with a fake runner in tests

N26 MCP-to-worker bridge (no second database handle)
  seat: implementer-deep   model: opus
  owns: [packages/magic-tools/src/bridge-client.ts, packages/learning/src/bridge-host.ts, tests/magic-bridge.test.ts]
  dependsOn: [N18]
  check: { argv: ["pnpm","exec","tsx","--test","tests/magic-bridge.test.ts"], expectExit: 0 }
  accepts:
    - bridge-host opens a local socket (a Unix socket with mode 0600, or a Windows named pipe) with a random per-session token and dispatches {id, tool, input} to the N18 handlers against the host's one store
    - bridge-client forwards MCP tool calls and returns {id, output | error}
    - ¬ a connection with a missing or wrong token is refused; a closed host makes the client return an MCP error
    - ¬ the client package never imports node:sqlite or @magic/storage (checked by a test that scans imports)
  done: the only path from the CLI's MCP server to course data (spec §8.3)

N29 Synthetic smoke cases and their frozen manifest
  seat: implementer   model: sonnet   (not the author of N03, N06 or N22: gold is written independently, per benchmarking rule 2)
  owns: [evals/cases/smoke/course.json, evals/cases/smoke/questions.json, evals/cases/smoke/seeded-items.json, evals/cases/smoke/events.json, evals/cases/smoke/FROZEN.sha256, evals/freeze.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","evals/freeze.ts","--verify","evals/cases/smoke"], expectExit: 0 }
  accepts:
    - a clearly synthetic course (labelled Synthetic, as a captureBatchSchema-valid batch), ≥10 answerable questions with gold passages, ≥4 unanswerable, ≥8 seeded bad items (wrong key, two correct, no correct, cue flaws), and scripted event streams covering every row of the spec §5.5 table
    - FROZEN.sha256 lists the hash of every case file; freeze.ts --verify recomputes and compares
    - ¬ editing any case file without re-freezing makes --verify exit non-zero
    - ¬ no case contains real course material, names or captures
  done: a committed, frozen smoke gold that makes N22 runnable anywhere

N22 Evaluation harness and knowledge-model replay
  seat: implementer-deep   model: opus
  owns: [evals/run.ts, evals/seeded.ts, evals/km-replay.ts, evals/report.ts, evals/tsconfig.json]
  dependsOn: [N03, N06, N07, N11, N29]
  check: { argv: ["sh","-c","pnpm exec tsc -p evals && pnpm exec tsx evals/run.ts --suite smoke"], expectExit: 0 }
  accepts:
    - evals/tsconfig.json extends the root config and includes evals/**/*.ts (the root tsconfig doesn't include evals/), so `tsc -p evals` type-checks the harness
    - the smoke suite runs on a fresh checkout from the committed synthetic cases (N29), with no network, no provider and no private data
    - reports quote validity and claim support separately; not-found on unanswerable questions; the catch rate and false-drop rate for each seeded-error stage and label (spec §11)
    - km-replay predicts each attempt from the prior events and reports log-loss and AUC against running-accuracy and constant baselines, with raw counts per course
    - refuses case files whose hashes aren't in the frozen manifest ([benchmarking](../../notes/benchmarking.md) rule 1)
    - ¬ `git status --porcelain evals` lists only .ts and .json config; no course data or captures are committed
    - ¬ no report contains a Jev latency, cost or accuracy figure
  done: every number in spec §11 has one command that reproduces it

N28 Scripted headless demo run
  seat: implementer   model: sonnet
  owns: [evals/demo.ts, evals/demo-student.json]
  dependsOn: [N22, N20]
  check: { argv: ["pnpm","exec","tsx","evals/demo.ts","--replay"], expectExit: 0 }
  accepts:
    - imports the demo course through Ben's headless path: createStore(":memory:") + execute({type:"import", batch}); the course is the syllabus + assignments capture or labelled imported material
    - runs, in order: the extracted course policy (N27) → a grounded answer with checked quotes (N03, with generate backed by N20 in --live) → an honest not-found → the concept map (N05) → 5 checked items (N06) → scripted answers from evals/demo-student.json (a synthetic student, labelled as scripted) → the knowledge-model states, with reasons and counts (N07) → a flagged item leaving the evidence
    - --live records every model exchange; --replay replays them byte for byte, producing the same report
    - ¬ the report labels the student as scripted and the material by its true source; it never says "Canvas" for imported material
    - ¬ the report's product-generated text (labels, state names, reasons, headings) contains no probability, percentage or "verified"; quoted course text and model sentences are exempt and shown as quotes
  done: the Sunday demo, reproducible with one command

N23 Learning package barrel
  seat: executor   model: sonnet
  owns: [packages/learning/src/index.ts]
  dependsOn: [N00, N01, N02, N03, N04, N05, N06, N07, N08, N09, N10, N11, N12, N13]
  check: { argv: ["pnpm","check"], expectExit: 0 }
  accepts:
    - re-exports the public API of each module; no module-level side effects
    - ¬ the internal knowledge fields (theta, p_hat) are exported only from `knowledge/state.ts` internals, never from the barrel's student-facing types
  done: one import path for the worker router and the MCP server
```

### After the demo: dependent on Part B seams
```
N24 SQL LearningStore through the storage extension hook
  seat: implementer-deep   model: opus
  owns: [packages/learning/src/sql-store.ts, packages/learning/src/migrations.ts, tests/learning-sql-store.test.ts]
  dependsOn: [N11, B02]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-sql-store.test.ts"], expectExit: 0 }
  accepts:
    - creates the spec §7.2 tables through the B02 hook on createStore(":memory:"); passes the same test suite as memory-store (shared cases)
    - evidence is written to learning_attempts (spec §7.3 decision); nothing is written to Ben's attempts table
    - the purge step deletes learning_courses, learning_sessions, learning_prefs and learning_passage_search
    - ¬ after Store.purge(), every table in sqlite_master has zero rows, excluding FTS5 shadow tables (*_data, *_idx, *_content, *_docsize, *_config) and schema_components; FTS rows are counted through the virtual tables; a null-course session is gone (KM-13)
    - ¬ opening a database with a newer learning schema version throws, as Ben's store does for user_version
  done: persistent learning data in the workspace database

N25 Learning router for the worker
  seat: implementer-deep   model: opus
  owns: [packages/learning/src/router.ts, tests/learning-router.test.ts]
  dependsOn: [N23, N24, N18, N20, B01]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-router.test.ts"], expectExit: 0 }
  accepts:
    - handles every LearningRequest op in spec §8.1 against the store, the engines and an injected runtime; returns LearningResult
    - writes egress receipts for provider calls through Ben's Store.addReceipt
    - ¬ in local_only privacy, notebook.ask returns a consent-needed result and the runtime spy records zero calls
    - ¬ an unknown op fails schema parsing; a late provider response after a privacy change or purge is discarded (the generation-counter pattern in core)
  done: one entry point the worker calls
```

### Phase 1
```
N14 FSRS adapter with a pre-exam review
  seat: implementer   model: sonnet
  owns: [packages/learning/src/fsrs.ts, tests/learning-fsrs.test.ts]
  dependsOn: [B06]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-fsrs.test.ts"], expectExit: 0 }
  accepts:
    - wraps ts-fsrs (the version pinned in B06) with request_retention 0.90; review() returns the new card and an immutable log row
    - retrievability(card, now) matches the library's forgetting curve at the pinned version; conceptR() is the median over reviewed cards, or the concept track
    - for cards covering an assessment within 14 days whose due date is later than (assessment − 1 day), adds a pre-exam review at max(now, assessment − 2 days), without editing the FSRS state (ST-2, same rule as the spec)
    - ¬ undo restores the previous state from the log and writes an undo row; nothing is deleted
  done: ST-2, and the R5 input for KM-10

N15 Practice exam builder with tiers and blueprint
  seat: implementer-deep   model: opus
  owns: [packages/learning/src/exam.ts, packages/learning/src/blueprint.ts, tests/learning-exam.test.ts]
  dependsOn: [N06, N10, N13]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-exam.test.ts"], expectExit: 0 }
  accepts:
    - blueprint follows spec §5.7: exam-faithful first (λ=0), lean with λ=0.5, largest-remainder allocation; a property test shows no concept's share exceeds 1.5 × κ, ≥1 item per covered concept when the length allows
    - the header and every item carry the tier and provenance; T3 carries the past-term warning
    - untimed by default; feedback is deferred to the end
    - ¬ a T3 item outside this term's coverage is dropped or labelled "may not apply"
    - ¬ results contain no predicted score; only observed counts per concept
  done: ST-4

N16 Course path, XP and streaks (engagement only)
  seat: implementer   model: sonnet
  owns: [packages/learning/src/path.ts, tests/learning-path.test.ts]
  dependsOn: [N07, N09]
  check: { argv: ["pnpm","exec","tsx","--test","tests/learning-path.test.ts"], expectExit: 0 }
  accepts:
    - units follow module order with one lesson per concept; XP and streaks are derived from events using local_day
    - ¬ there is no lives or lockout state; a broken streak never blocks a lesson
    - ¬ no UI copy or label template in path.ts contains "mastery", "ready" or "learned" (ST-5, IP-9); course titles and concept labels from the course are exempt
  done: ST-5

N19 Magic tools stdio server
  seat: implementer   model: sonnet
  owns: [packages/magic-tools/src/server.ts, scripts/magic-tools-selftest.ts]
  dependsOn: [N18, N26, B06]
  check: { argv: ["pnpm","exec","tsx","scripts/magic-tools-selftest.ts"], expectExit: 0 }
  accepts:
    - starts the MCP stdio server over N18 handlers; the self-test lists the tools and calls course_list through the N26 bridge to an in-memory host; the server process never opens a database
    - ¬ the server exposes no tool outside spec §8.3; a call to an unknown tool returns an MCP error, not a crash
  done: the server the CLI's isolated configuration points to

N21 Agent runtime: Codex, Gemini and OpenRouter routes
  seat: implementer   model: sonnet
  owns: [packages/agent-runtime/src/codex.ts, packages/agent-runtime/src/gemini.ts, packages/agent-runtime/src/openrouter.ts, tests/agent-runtime-routes.test.ts]
  dependsOn: [N20]
  check: { argv: ["pnpm","exec","tsx","--test","tests/agent-runtime-routes.test.ts"], expectExit: 0 }
  accepts:
    - Codex reuses the existing login: `codex exec --json --ignore-user-config --ignore-rules --ephemeral -s read-only -C <empty scratch> -c developer_instructions="<Magic Canvas role; the user's AGENTS.md is out of scope>"` plus our MCP server via -c; continued with `codex exec resume <id>`
    - Gemini: an isolated GEMINI_CLI_HOME with the API key from an injected keychain and core tools limited to none; OpenRouter: Claude Code with the documented environment variables and the same tool lockdown as N20
    - ¬ the Codex route is disabled (status "unavailable: file access not locked down") until its live probe shows the agent can't read the workspace database path (spec §8.3)
    - ¬ Gemini never offers Google-account OAuth; a key is never written to disk or logged by the adapter
    - ¬ neither the adapter nor its tests read ~/.codex/auth.json or any other credential file (IP-14)
  done: the Phase 1 provider routes
```

---

## Part B: changes to Ben's files (decided; delivered as PRs he merges)

Each B task is drafted on a branch and opened as a PR with its rationale: the spec section, the evidence, and the research decision (D1–D9) where one applies. Nothing is pushed without the operator's OK. Ben merges; if he asks for a different shape that meets the same acceptance criteria, the dependent Part A tasks adapt to it. Every B task comes after the demo.

```
B01 Contracts: learning command, results, categories, optional fields
  seat: implementer-deep   model: opus
  owns: [packages/contracts/src/index.ts, tests/contracts-learning.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","--test","tests/contracts-learning.test.ts"], expectExit: 0 }
  accepts:
    - adds the {type:"learning", request} Command variant, the LearningRequest schema, CommandResult.learning and Snapshot.learning (spec §8.1–8.2)
    - adds the `learning_state` category, the privacySchema fields shareLearningState and alwaysPreview (both .default(false); B11 wires them into maySend), hostedProvider "openrouter" and Link type "covers"; optional ResourceInput fields parts, role, term, module, format
    - becomes the home of the spec §8.1 result types: they move verbatim from packages/learning/src/types.ts (N00), and that file then re-exports them from @magic/contracts, so there is one definition
    - ¬ every existing test passes unchanged; the committed fixture still parses
    - ¬ an unknown op, an extra field, and a question over 2,000 characters are each rejected (strictness kept)
  done: the shared types every learning surface uses (spec §13, decisions 1, 5, 6, 7)

B02 Storage extension hook and purge coverage
  seat: implementer-deep   model: opus
  owns: [packages/storage/src/index.ts, tests/storage-extensions.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","--test","tests/storage-extensions.test.ts"], expectExit: 0 }
  accepts:
    - createStore(path, {extensions}) runs each extension's migrations inside a transaction, tracked in schema_components; user_version stays Ben's
    - purge() runs each extension's purge step, then the existing steps and VACUUM
    - also carries B12's two storage edits (the `covers` allowlist at :509 and Store.resourceVersion), since this task is the only writer of packages/storage/src/index.ts
    - ¬ after purge, every table in sqlite_master has zero rows (a generic test that enumerates the tables)
    - ¬ an extension migration that throws leaves the database at its previous component version; Ben's existing storage tests pass unchanged
  done: spec §7.1 option A (spec §13, decision 2)

B03 Core: route the learning command, exhaustive switch, snapshot summary
  seat: implementer   model: sonnet
  owns: [packages/core/src/index.ts, tests/core-learning.test.ts]
  dependsOn: [B01]
  check: { argv: ["pnpm","exec","tsx","--test","tests/core-learning.test.ts"], expectExit: 0 }
  accepts:
    - execute({type:"learning"}) calls an injected learning handler and puts its result in CommandResult.learning; snapshot() adds the small learning summary only
    - the switch ends in an exhaustive never check
    - ¬ a purge or privacy change during a learning call makes its late result discarded (generation counter)
    - ¬ core's existing tests pass unchanged; Snapshot never includes items, evidence or concept states
  done: the in-process route (spec §13, decision 1)

B04 Desktop worker, main and preload: learning router and runtime
  seat: implementer-deep   model: opus
  owns: [apps/desktop/src/worker.ts, apps/desktop/src/main.ts, apps/desktop/src/preload.ts]
  dependsOn: [B03, N25]
  check: { argv: ["pnpm","test:desktop"], expectExit: 0 }
  accepts:
    - the worker constructs the learning router with the store and the agent runtime; CLI processes are spawned with shell:false and a minimal environment
    - Phase 1: a magic:learning-stream channel with a sender check, like the existing channels
    - ¬ the hidden smoke run completes with no provider installed, and the learning commands report "provider missing" without crashing
    - ¬ purge and privacy changes cancel running CLI sessions (as local.cancel() does today)
  done: the in-app path (spec §13, decision 4)

B05 Canvas coverage: modules, pages, files, announcements, plus extraction with parts
  seat: implementer-deep   model: opus
  owns: [packages/connectors/src/canvas.ts, packages/connectors/src/extract.ts, tests/canvas-coverage.test.ts]
  dependsOn: [B01, B06]
  check: { argv: ["pnpm","exec","tsx","--test","tests/canvas-coverage.test.ts"], expectExit: 0 }
  accepts:
    - bounded GETs for modules → items → pages and files, and announcements, with the existing pagination, caps and partial states
    - PDF by page and PPTX by slide produce `parts` offsets; text over the limit makes the scope partial, as today
    - the connector fills Resource.policy from the syllabus (the N27 logic, moved into the connector) instead of hard-coding {mode:"unknown"} at canvas.ts:269 and :442; a looser mode still needs the student's confirmation in the app
    - ¬ a failed file download marks the scope partial and deletes nothing (only a complete scope proves absence)
    - ¬ no request uses a method other than GET
  done: lecture-level sources for the notebook (spec §13, decision 5; where-we-differ rows 1–2)

B06 Dependencies and workspace manifests
  seat: executor   model: sonnet
  owns: [pnpm-lock.yaml, packages/learning/package.json, packages/magic-tools/package.json, packages/agent-runtime/package.json, tsconfig.json]
  dependsOn: []
  check: { argv: ["pnpm","install","--frozen-lockfile"], expectExit: 0 }
  accepts:
    - adds ts-fsrs and the MCP TypeScript SDK (Phase 1: markmap, docx), each pinned, with its licence recorded per docs/tool-evaluation.md; adds @magic/learning, @magic/magic-tools and @magic/agent-runtime path aliases
    - ¬ no AGPL or non-commercial licence enters the tree (checked by a licence listing)
    - ¬ `pnpm check` still exits 0 with the new aliases
  done: the dependencies Part A tasks N14, N19 and B05 need (spec §13, decision 9)

B07 Gateway: learning judgment endpoints and a global abuse cap only
  seat: implementer-deep   model: opus
  owns: [apps/gateway/src/gateway.ts, apps/gateway/src/schema.ts, apps/gateway/src/typesafe.ts, packages/ai/src/index.ts, tests/gateway-learning.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","--test","tests/gateway-learning.test.ts"], expectExit: 0 }
  accepts:
    - versioned endpoints item.support.v1, item.option_correct.v1, coverage.material.v1, answer.key_idea.v1; questions are built on the server, and the client sends named state only (the existing pattern)
    - option-order rotation by state hash; journal rows hold hashes only (jev-insights §2)
    - replaces the per-device caps with one global abuse cap (operator decision: no per-student Jev budget); OpenRouter-key clients bypass the gateway through their own key
    - ¬ an oversized state is refused, never truncated; hitting the global cap returns a typed "cap" error and the client falls back to the labels in spec §6.4
    - ¬ no request body is logged
  done: Phase 1 Jev checks (spec §13, decision 10)

B08 Renderer: Notebook, Study and Your topics panels
  seat: design-engineer   model: opus
  owns: [apps/desktop/src/renderer/Notebook.tsx, apps/desktop/src/renderer/Study.tsx, apps/desktop/src/renderer/Topics.tsx, apps/desktop/src/renderer/App.tsx, scripts/learning-journey.ts]
  dependsOn: [B04]
  check: { argv: ["pnpm","exec","tsx","scripts/learning-journey.ts"], expectExit: 0 }
  accepts:
    - the headless preview runs one named case per journey on synthetic data labelled Synthetic, with no visible window: J1, J2, J5 and J6 when B08 lands; J3 once N10 is merged; J4 once N15 is merged
    - a journey whose dependency isn't merged is reported as "skipped: <task> not merged" and counted in the summary; it never passes silently
    - the calm, neutral visual direction in docs/product.md; states render with reasons and counts
    - ¬ a scan of the product's own strings (renderer copy, labels and state chips, excluding quoted course text and model sentences) finds no percentage or probability next to a concept state, and no "verified"
    - ¬ the empty, no-provider, stale and partial states in spec §3.4 each render their message
  done: the in-app surfaces (spec §13, open item 1)

B09 Windows: guard the storage file-mode assertion
  seat: executor   model: sonnet
  owns: [tests/storage.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","test"], expectExit: 0 }
  accepts:
    - the 0o600 assertion runs only where POSIX modes apply
    - ¬ the assertion still runs and passes on macOS and Linux
  done: `pnpm test` is green on Windows (where-we-differ row 14)

B10 Local structured generation (only if Ben keeps the local route)
  seat: implementer-deep   model: opus
  owns: [packages/ai/src/local.ts, tests/local-structured.test.ts]
  dependsOn: []
  check: { argv: ["pnpm","exec","tsx","--test","tests/local-structured.test.ts"], expectExit: 0 }
  accepts:
    - a task + JSON schema option alongside the coaching prompt, keeping every existing guard (cloud disabled, loopback only, the llmfit-selected model, the restricted-policy short-circuit)
    - ¬ cloud enabled, a remote host or model, or a changed digest each refuse, exactly as generate() does today
  done: a local fallback for spec §9.1 (spec §13, decision 6)

B11 Privacy: the learning_state category and "always preview"
  seat: implementer   model: sonnet
  owns: [packages/domain/src/index.ts, tests/domain-learning.test.ts]
  dependsOn: [B01]
  check: { argv: ["pnpm","exec","tsx","--test","tests/domain-learning.test.ts"], expectExit: 0 }
  accepts:
    - privacySchema (in B01) gains shareLearningState: z.boolean().default(false) and alwaysPreview: z.boolean().default(false); maySend gates the learning_state category on shareLearningState, exactly as it gates student_work on shareStudentWork
    - stored preferences written by today's build parse unchanged (the strict schema is parsed on read, and the defaults fill the new fields)
    - ¬ with shareLearningState false, maySend(privacy, "claude", ["learning_state"]) is not allowed; in local_only, nothing is allowed for any hosted recipient
    - ¬ existing domain tests pass unchanged
  done: the category gate behind IP-8 and the blocking first-send preview (spec §9.2)

B12 Storage additions the learning extension relies on
  seat: implementer   model: sonnet
  owns: [tests/storage-learning-support.test.ts]
  dependsOn: [B01, B02]
  check: { argv: ["pnpm","exec","tsx","--test","tests/storage-learning-support.test.ts"], expectExit: 0 }
  accepts:
    - the `covers` link type is added to the putLink allowlist (packages/storage/src/index.ts:509) to match B01's Link type; this edit is made in B02's branch, because B02 owns that file, and is tested here
    - Store.resourceVersion(id, version) returns an older captured payload from resource_versions, so the quote re-checks in NB-13 and N11 markStale can compare old and new text (also in B02's branch)
    - ¬ putLink with an unknown type still throws; resourceVersion for a missing version returns undefined and never the current version
  done: the two Ben-side storage needs, made explicit (the review's hidden Part B work)
```

---

## Order and critical path

**Phase 0:** see "the demo minimum" at the top. It's headless; no B task is needed.

**After the demo, in order:**
1. **Ben's seams:** B09, B06, B01, B11, B12 → B02 → B03.
2. **Our engines:** N08 → N09 → N10 (serial); N12, N13 and N18 in parallel with them.
3. **Integration:** N26 → N24 → N25 → B04 → B08.
4. **Phase 1 breadth:** N14, N15, N16, N19, N21, B05, B07, N23.

**Cut order for the demo if time runs short:** trim N22's report breadth → cut the not-found step from N28 → cut the flag step. The knowledge model (N07) and the grounding checks (N01, N03, N06) are never cut.
