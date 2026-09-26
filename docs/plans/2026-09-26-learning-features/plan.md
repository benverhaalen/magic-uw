# Plan: learning features on Ben's current backend, with evidence-gated upgrades

**Version 2,** 2026-09-26 ~15:00 CDT, against `origin/main` `73ff7a6`. Public version; internal cost figures omitted.
**Tier:** specification.
**Inputs:**
- `docs/notes/backend-map.md` (73ff7a6)
- `docs/notes/performance-plan.md` v2
- `AGENTS.md`, `docs/agent-work-principles.md`, `docs/engineering-principles.md`, `docs/implementation-status.md`, `docs/pipeline-details.md`

**Review rounds:** one independent attack (3 blocking, 8 should-fix, 7 minor), all fixed below. The record is at the end.

## Outcome
**Two versions, and the operator picks one** (was open item 4; it decides whether T8 exists):
- **(H) Harness demo:** by Sunday 2026-09-27 ~10:00 CT, a headless, labelled run on imported OCW material shows the grounded answer with checked quotes, an honest "couldn't find support", a 5-item quiz with truthful labels and explanations, a flagged item, and a missed item returning. A reproducible eval report backs every number.
- **(U) In-app:** the same journey in Ben's desktop app. This needs Ben to accept seam S, which includes a renderer panel and result shape (T8), in time.

**Either way,** where the research already settled a better design, it's decided and goes to Ben as a PR. Only the genuinely uncertain upgrades wait for a measurement.

## Constraints in force
- **AGENTS.md is team policy.**
  - Changes to Ben's packages go to him as PRs, with the rationale.
  - Commit and push only what the user authorized.
  - **Agent verification is headless,** and `main.ts` blocks file dialogs in headless mode.
  - Never present fixtures as real, and never present real data as fixtures.
- **No edits to Ben's files:** contracts, storage, core, ai, connectors, apps, `tsconfig.json`, `package.json`, the lockfile. Our code imports `packages/learning` by relative path until seam S.
- **The default is `local_only` with Jev off.** The Jev budget is 20 calls a day per device. No hosted path exists.
- **Public repo:** no course data or OCW content in git. Cases and gold live in `.data/bench/` (excluded); run outputs go in `.data/` (gitignored); `evals/` holds code only.
- **Local AI must keep Ben's guards:** Ollama cloud disabled, no remote host or model, the llmfit-selected model.

## Deciding facts
| Fact | Source |
|---|---|
| Canvas gives syllabus + assignment descriptions only. There are no files, modules, pages or PDF/PPTX extraction | backend-map; pipeline-details |
| `Store` is fully implemented (DatabaseSync, migrations v2, FTS5 over whole documents). **The FTS query is prefix-AND over every term** (storage `resources(search)`), so a raw question usually matches nothing | storage |
| The store opens **only in the worker** | worker.ts |
| **`CommandResult` is `{snapshot, manifest?, message?}`.** It has nowhere to return answers or items, so the UI needs new result or snapshot fields | contracts; core |
| Unknown commands throw at `commandSchema.parse`. A variant added to contracts but not to core's switch silently returns a snapshot | core |
| **Local AI:** Ollama on loopback, cloud must be disabled, the llmfit exact tag and quant, a fixed coaching prompt, num_ctx 4096 / num_predict 800 / temperature 0.2, a 6,000-character context | local.ts |
| **Jev** answers only `assignment.kind.v1`. **The job queue** runs `enrich.resource` only, with Jev on, FIFO | backend-map |
| **`fixture` sources show as "Synthetic"** and put the app in sample mode | App.tsx; core |
| **Import:** ≤8 MB per file; an equal or older `observedAt` is silently ignored | main.ts; storage |
| **Purge** clears only the workspace database | backend-map |
| **This laptop:** Ollama 0.20.7 with **cloud enabled** and **no models**; **llmfit not installed**; RTX 5080 16 GB; `pdftotext` present (poppler via Git for Windows); PyMuPDF present but **AGPL** | probes 14:16 and ~14:50 |
| **`pnpm test` exits 1 on Windows at HEAD:** the `tests/storage.test.ts` 0o600 assertion. Pre-existing | probe |

## Candidates (unchanged; C2 chosen)
| Candidate | Loses when… |
|---|---|
| C0 wait | Sunday arrives with no learning features |
| C1 extend Ben's tutoring form | the fixed coaching prompt and free-text output can't give checkable items, and nothing is saved |
| **C2 our package + harness, plus seam S proposed** | Ben declines or is late with seam S, so it's harness-only (outcome H) |
| C3 edit Ben's files on a branch | Ben pushes conflicting changes to the same files (twice today), and it breaks the AGENTS.md ask rule |

## Seams
1. **`packages/learning`:** pure functions over contract types, with the model injected. Tests via `tsx --test tests/learning-*.test.ts`.
2. **The `evals/` CLI** (code only, with its own `evals/tsconfig.json` extending the root): `createStore(':memory:')`, `execute({type:"import", batch})` (headless; no dialog), counts per course.
3. **Seam S, proposed to Ben:**
   - (a) `practice.*` / `ask` commands routed in the worker to `@magic/learning`
   - (b) a `task` + JSON-schema option on local `generate()`, keeping all of his guards
   - (c) a v3 migration with `items` and `responses` tables, covered by purge
   - (d) result fields for answers and items
   - (e) a renderer panel (T8)

## Scope posture: reduce
Deferred:
- embeddings, hybrid, rerank (G4 and G5 not measurable by Sunday)
- Elo, readiness, FSRS
- personalised distractors
- sandboxed code execution
- hosted caching and batch (policy)

**Cut order if time runs short:** G1 arm → Codex review → T8 → T6 probe breadth.

## Tasks
Checks run in the main checkout. Worktrees are used only for T1–T4, each with `pnpm install` first. T5 and T7 write to excluded or ignored paths, so they run in the main checkout.

**The base check for T1–T4:**
```
{ argv: ["pnpm","exec","tsx","--test","tests/learning-*.test.ts"], expectExit: 0 }
```
plus `pnpm check` exits 0. `pnpm test` must show **exactly one** failure: the named storage 0o600 test, and nothing new.

```
T0 gold set (independent of pipeline authors)
  seat: operator + bench-judge agent   (not the T2–T7 writers)
  owns: [.data/bench/cases/** (local, not committed)]
  dependsOn: [T5]            deadline: frozen by Sat 22:00 CT
  check: { argv: ["node","-e","<hash cases, compare to .data/bench/cases/ (local, not committed)FROZEN.sha256>"], expectExit: 0 }
  accepts:
    - ≥30 answerable 6.006 questions with gold passage (resource + exact quote), ≥8 unanswerable, 20 seeded bad items (wrong key, 2 correct, no correct, cue flaws)
    - hashes recorded in FROZEN.sha256 before any T7 tuning run (negative: a run on unfrozen cases is refused)
    - 20-item human spot-check sample drawn at random by script, rated by the operator (time-boxed 30 min)
  done: frozen, hashed gold that no pipeline author wrote

T1 passages + quote validator
  seat: implementer  model: opus  effort: medium   isolation: worktree
  owns: [packages/learning/src/passages.ts, packages/learning/src/quotes.ts, packages/learning/src/index.ts, packages/learning/package.json, tests/learning-passages.test.ts]
  inputs: [packages/contracts/src/index.ts]   dependsOn: []
  check: base
  accepts:
    - passages carry resourceId, contentHash, start, end, heading; concatenation reproduces the text exactly
    - exact span → offsets; paraphrase, other-version, or one-character-off quote → not found (no fuzzy repair)
  done: exports via packages/learning/src/index.ts (sole owner of the barrel); imported by relative path; no tsconfig edit

T2 retrieval + answer composer
  seat: implementer  model: opus  effort: medium   isolation: worktree
  owns: [packages/learning/src/retrieve.ts, packages/learning/src/answer.ts, tests/learning-answer.test.ts]
  dependsOn: [T1]
  check: base
  accepts:
    - BM25 over passages; never crosses courseId (negative: same-title passage in another course excluded)
    - restricted policy → refusal with zero generate calls (negative)
    - below threshold → "couldn't find support in the captured material I searched" + scope + freshness; never invents
    - every returned quote passes validateQuote; a model answer quoting unseen text is rejected (fake generate)
  done: answer(question, courseResources, generate) → {text, citations[{resourceId,contentHash,start,end,quote,valid}], scope}

T3 items + policy gate + flaw rules + truthful labels
  seat: implementer  model: opus  effort: medium   isolation: worktree
  owns: [packages/learning/src/items.ts, packages/learning/src/policy.ts, packages/learning/src/flaws.ts, tests/learning-items.test.ts]
  dependsOn: [T1]
  check: base
  accepts:
    - restricted → no items; open graded assignment never a source (negative)
    - rules flag longest-option-correct, all/none-of-the-above, duplicates, negation stems
    - labels = exactly the checks that ran and passed: "quote found", "answer checked by running it" (arithmetic evaluator, no eval()), "a second model agreed"; never "verified"
    - failing quote → item dropped with logged reason
  done: generateItems(...) with injected generate returns only gated items with provenance + labels

T4 session + responses + review queue
  seat: implementer  model: opus  effort: medium   isolation: worktree
  owns: [packages/learning/src/session.ts, packages/learning/src/review.ts, packages/learning/src/repo.ts, tests/learning-session.test.ts]
  dependsOn: [T3]
  check: base
  accepts:
    - drill = immediate explanation; exam mode = at end
    - responses store chosen option/text, item version, outcome, flag/dispute; disputed outcomes excluded from adaptation (negative)
    - misses enter queue; unassisted spaced successes lower priority; nothing retires permanently
    - an item whose resource contentHash changed is not served unchanged (negative)
    - JSON repo is harness-only under .data/; after a purge-equivalent reset the queue is empty (negative)
  done: full session vs fake generate survives a process restart

T5 OCW → CaptureBatch converter
  seat: executor  model: sonnet  effort: medium   isolation: none
  owns: [scripts/ocw-to-capture.ts]
  dependsOn: []
  extractor: pdftotext (poppler, GPL, invoked as an external dev tool; not added to package.json, not shipped). PyMuPDF excluded (AGPL).
  check: { argv: ["pnpm","exec","tsx","scripts/ocw-to-capture.ts","--course","6.006","--out",".data/captures/ocw-6006.json","--validate"], expectExit: 0 }
  accepts:
    - passes captureBatchSchema; source.kind "web", label "Imported: MIT OCW 6.006 (CC BY-NC-SA 4.0)"; never "fixture" (negative: app must not enter sample mode)
    - each resource ≤200k chars, file ≤8 MB; oversize split by lecture, never silently truncated
    - re-run sets a newer observedAt
    - nothing written outside .data/ (negative: git status --porcelain unchanged)
  done: importable headlessly via execute({type:"import"})

T6 local model: setup, then a guarded eval adapter
  seat: lead (operator steps) → implementer  model: opus
  operator steps (≈20 min + download):
    1. install llmfit
    2. set OLLAMA_NO_CLOUD=1, restart Ollama
    3. pull llmfit's exact ollama_name + best_quant
  owns: [evals/adapters/ollama.ts]   dependsOn: [operator steps]
  check: { argv: ["pnpm","exec","tsx","evals/adapters/ollama.ts","--probe"], expectExit: 0 }  (exit 3 = reported failure, not 0)
  accepts:
    - calls createLocalAi().status(); refuses unless "ready"; uses status().selected.name
    - copies Ben's generate options exactly (num_ctx 4096, num_predict 800, temperature 0.2, 6,000-char context) and adds only format
    - cloud enabled → refuse; remote_host/remote_model → refuse; non-loopback URL → refuse (negatives)
    - records latency + tokens per call to the harness ledger
  done: eval-only Generate whose measurements transfer to seam S(b)

T7 eval harness + baseline
  seat: implementer-deep  model: opus  effort: high   isolation: none
  owns: [evals/** except evals/adapters/**, .data/bench/runs/**]
  dependsOn: [T0, T2, T3, T4, T5, T6]
  check: { argv: ["pnpm","exec","tsx","evals/run.ts","--suite","smoke"], expectExit: 0 }
  accepts:
    - headless: createStore(':memory:') + execute({type:"import"}); counts per course
    - reports separately: quote-valid rate; human-rated support (T0 sample); unanswerable honesty; seeded-item catch AND false-drop rates; cold/warm latency; tokens
    - refuses unfrozen cases; no clustered SE under 20 clusters (negative)
    - --suite demo replays recorded generations (byte-identical report) and --live re-generates (numbers within stated tolerance)
    - git status --porcelain evals lists only .ts/.json config (negative: no case data)
  done: .data/bench/runs/<date>-baseline.md and -demo.md, reproducible by one command

T8 (outcome U only) seam S draft: renderer panel + result shape + commands + generate(task) + v3 tables
  seat: implementer-deep  model: opus  effort: high   isolation: worktree, branch proposal/learning-seam (never pushed without operator OK)
  owns: [the seam diff on that branch only]
  dependsOn: [T4, T6]
  check: { argv: ["pnpm","build"], expectExit: 0 } + headless desktop smoke (pnpm test:desktop)
  accepts:
    - with the seam applied, the journey runs in the app headlessly; with it absent, main is unchanged (negative)
    - Ben's guards/tests unchanged except the proposed ones
  done: a reviewable diff + one-page rationale for Ben; Codex diff-review (inline via codex exec stdin) done
```

## Track 2: upgrades to Ben's code
**Decided** (the research already settled these; each goes to Ben as a PR with its evidence):

| # | Change | Why it's decided |
|---|---|---|
| S | Learning seam: commands, structured `generate`, v3 tables, result fields, UI panel | no learning feature can reach the app without it |
| D1 | Passage offsets (`parts`) + passage-level FTS at ingest | page and slide citations and literal-span checks need offsets (Ben's own pipeline direction) |
| D2 | Excerpt-list `ContextManifest` | multi-source answers are the norm for course Q&A |
| D3 | Per-resource validation at import | one bad resource shouldn't discard a whole capture; it matches the existing partial semantics |
| D4 | Usage fields (latency, model, tokens) on receipts and judgments | every speed and cost claim needs them |
| D5 | Feature job kinds, kind-filtered leasing, priority (soonest assessment first) | precomputing study material is what makes it instant |
| D6 | Canvas modules, files and pages + PDF/PPTX extraction | there are no lecture materials without it |
| D7 | OR-query form for natural-language questions | prefix-AND over every term rarely matches a question |
| D8 | CI: check + test + eval smoke | four people push to one repo |
| D9 | Windows fix for the 0o600 test | reproduced |

**Measure first** (the evidence is still open):

| Gate | Change | Adopt if (fixed now) | Kill if |
|---|---|---|---|
| G4 | Embeddings + hybrid retrieval | ≥10-point recall@5 gain on ≥50 labelled questions, paired exact test p<0.05, acceptable packaging and licence | fails any |
| G5 | Structural headers stored at ingest | ≥5-point recall@5 gain, paired test | fails |
| G10 | `typesafe/jev-router` as the default model choice (OpenRouter route) | beats a fixed model on answer quality at equal or lower cost on our eval | doesn't |

## Time boxes (CDT)
| Time | Work |
|---|---|
| Sat 15:00–17:00 | T1, T5; operator T6 steps + model pull |
| 17:00–20:00 | T2, T3 in parallel; T6 adapter |
| 20:00–22:00 | T4; T0 frozen by 22:00 |
| 22:00–01:00 | T7 baseline; reviews (integrity-auditor, learning-reviewer, grounding-reviewer on T2–T4) |
| Sun 08:00–09:30 | outcome U only: T8 if Ben accepted seam S; otherwise `--suite demo` report + recorded run |

Apply the cut order when a box overruns.

## Acceptance (the whole)
1. `pnpm check` exits 0. Learning tests exit 0. `pnpm test` shows only the pre-existing storage failure.
2. `pnpm exec tsx evals/run.ts --suite demo` reproduces `.data/bench/runs/<date>-demo.md` byte for byte.
3. The headless journey (outcome H) passes on imported OCW material labelled as imported.
4. Outcome U only: the same journey runs in Ben's app headlessly with seam S applied.

## Open, for the operator
1. **Outcome H or U.** This decides T8.
2. Agree the three seams.
3. Do the T6 operator steps (llmfit, disable Ollama cloud, pull the exact model).
4. Rate the T0 human sample (about 30 min) by 22:00.
5. Send seam S to Ben once it's drafted, and the Windows test note now?

## Review record
**Round 1 (independent reviewer), fixed:**

*Blocking:*
- B1: the checks now scope to the learning tests, with an exact-one-failure rule for `pnpm test`.
- B2: outcome H/U split, T8 added, headless import.
- B3: T0 gold task, independent authors, frozen hashes.

*Should-fix:*
- S1: T6 reuses Ben's guards and options.
- S2: setup facts added.
- S3: gates made measurable, or marked as triggers or not measurable; G1 query rule and CI.
- S4: `web`, not `fixture`.
- S5: pdftotext named; AGPL excluded; import limits.
- S6: data out of `evals/`; own tsconfig.
- S7: single owners; relative imports.
- S8: purge, stale version and restricted-policy negatives.

*Minor:*
- M1: fact corrected.
- M2: demo suite defined.
- M3: worktree rules.
- M4: T6 exit code.
- M5: seam drafted after T4, owned by T8.
- M6: time boxes and cut order.
- M7: exact tests.

A second round wasn't run, for time. The operator can ask for one.
