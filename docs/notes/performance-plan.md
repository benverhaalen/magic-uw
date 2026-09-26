# Performance plan: what makes Magic Canvas measurably better

**Status: Proposal. Version 2, 2026-09-26.** Revised after three reviews against Ben's code at `73ff7a6`: a Claude reviewer (citation checks), a Codex adversary, and a backend remap. The review record is at the end.
**Status vocabulary** (AGENTS.md): researched · proposed · built · tested in isolation · integrated · demonstrated.
**Labels:** sourced · inferred · not-found.
**Rule:** we cite studies, we don't claim their gains. Learning gains, speed and cost are ours only once our own runs measure them ([decisions](../decisions.md): no unsupported readiness, speed or reliability claims).

## 0. The honest starting point
- **NotebookLM is strong at grounding** in controlled studies:
  - Lung-cancer staging: 86% vs GPT-4o's 39% with the same reference text pasted in, and 95% accuracy locating the reference (PMID 39585559).
  - Pancreatic staging: 70% vs 38% for Gemini 2.0 Flash, with 92% retrieval accuracy (PMID 41784908).
  - One lab ran both, on 100 fictional cases and one guideline each; the abstract calls this an "idealized and controlled proof-of-concept".
  - We won't compete on "it hallucinates".
- **What our app has today** (Ben's connector):
  - Canvas syllabus HTML and assignment descriptions, plus explicit local JSON import.
  - **No modules, files, pages, slides or past exams, and no PDF/PPTX extraction** (implementation-status; pipeline-details).
  - Live ingestion isn't validated yet.
- **Target claim** (proposed, not built): "uses the course material we've captured, with coverage and freshness shown". Lecture-level grounding needs a source path first (§1.0).
- **Where we can plausibly differ** (inferred; to be measured):
  - course policy and deadlines already attached
  - items whose checks are labelled truthfully
  - practice that remembers the student
  - honest scope when support isn't found

## 1. Retrieval and citations
### 1.0 The source path (prerequisite)
| Option | What it takes | Status |
|---|---|---|
| **A. Canvas modules, files and pages, plus PDF/PPTX text extraction** | Ben's connector and main process; about a day; a tool comparison per tool-evaluation.md | proposed → **ask Ben** |
| **B. Offline-converted OCW material,** imported through the existing JSON import and **labelled "Imported: MIT OCW … (CC BY-NC-SA)"**, never passed off as Canvas | a local script; the output stays out of git | proposed; ours; hours |
| **C. What Canvas gives today** (syllabus + assignment descriptions) | nothing | built by Ben |

For the demo: **B + C**, with A as the ask.

### 1.1 Decisions
| Decision | Evidence | Status |
|---|---|---|
| **Passages with offsets, computed in feature code** from `Resource.text` (sections and paragraphs), keyed to the resource version and content hash | Ben's FTS5 returns whole documents, ranked by BM25 (`storage` FTS table; `resources(search)`), with no snippets or offsets | proposed; ours |
| **Scoped lexical retrieval first:** Ben's FTS to shortlist documents, then BM25 over passages in code | Deterministic baseline first (engineering-principles) | proposed; ours |
| **Headers from captured metadata only** (course › title › section heading) | Anthropic measured the gain of contextual chunks (below) with context **written by an LLM**. Structural headers are a cheaper hypothesis to test, not that measured result | inferred |
| **Embeddings + hybrid + rerank:** a candidate, gated on our eval (see [where we differ](where-we-differ.md)) | Anthropic (vendor, own datasets): contextual embeddings cut top-20 retrieval failures 35%; + BM25 49%; + rerank 67% (5.7%→1.9%). sqlite-vec is a native extension and EmbeddingGemma weights carry Gemma terms, which tool-evaluation.md chose to avoid (native module rebuilds) | researched; **needs Ben** |
| **Quote validity ≠ claim support.** Code checks the literal span against that resource version. Support is judged separately, and **reported separately** | Ben's decided direction (pipeline-details: exact match or stored offsets, no fuzzy repair). ALCE: even the best systems "lack complete citation support 50% of the time" on ELI5 | proposed (Ben's direction) |
| **The "not found" wording:** "I couldn't find support in the captured material I searched", plus scope, freshness and missing sources | A retrieval miss doesn't establish absence (Codex review) | proposed |
| **Slides as page images:** a candidate only | ColPali 81.3 nDCG@5 vs 67.0 (Unstructured + captioning + BGE-M3) and 65.5 (best BM25) on ViDoRe. On text-heavy subsets the gap is small (96.2 vs 92.8). Not measured on lecture decks | researched |

## 2. Speed and cost
| Item | Evidence | Status |
|---|---|---|
| **Store and jobs in a utilityProcess worker** | `main.ts` `utilityProcess.fork`; the store opens only in `worker.ts`. Electron: "Under no circumstances should you block this process" | **built by Ben** |
| **FTS5 + BM25 in node:sqlite** | Ben's storage; `node:sqlite` is "Stability 1.2 – Release candidate" from Node 24.15. **Electron 44.4.5 ships Node 24.21.0,** so test on that runtime | built by Ben |
| **Job queue, leases, judgment cache** | Ben's storage and core. **Only `enrich.resource` jobs run, and only when Jev is enabled.** There's no priority ordering | built by Ben; feature job kinds **need Ben** (see [where we differ](where-we-differ.md)) |
| **Exact-input result cache** for our generations | reuse `putJudgment`, keyed by input hash + question version + model | proposed; ours |
| **Minimal ledger:** latency, model, tokens when available, retries, cache hits, recorded by our harness and adapters | receipts carry character counts only. The vendor savings claims (FrugalGPT 98%, RouteLLM 85/45/35%) are author-run and unreplicated, so only our ledger can support a claim | proposed; ours now, contract fields later (see [where we differ](where-we-differ.md)) |
| **Prompt caching** | Claude Code and Codex cache prompts on their own; on the OpenRouter route, Anthropic caching applies to the student's key (cache reads 0.1× input on Anthropic's pricing page). Keep a stable course prefix (skeleton, policy, instructions) at the front of every session so the cache hits. Batch APIs (50% off, ≤24 h) fit only overnight precompute | decided: stable-prefix sessions; batch only for overnight jobs |
| **Background embedding, soonest exam first** | needs job kinds + priority + a dependency decision | needs Ben (see [where we differ](where-we-differ.md)) |

## 3. Quizzes and tests
Evidence comes from lab and K-12 studies, drills and other domains. We cite it to choose designs; **none of it is a gain we claim.**

**3.1 Items with truthfully labelled checks**
- **Why:**
  - LLM keys are often wrong: 32 of 50 GPT-4 USMLE-style items (64%) were judged correct; 9 had multiple correct answers, 6 a wrong key, 3 no correct answer (QUEST-AI, medRxiv; primary source confirmed by the reviewer). Medicine, not CS.
  - A hybrid checker (scripts plus LLM parts) caught 91% of human-identified flaws vs GPT-4's 79%, but it over-flagged (2.1 flaws per item vs humans' 1.6, and GPT-4's 4.2). The items were student-written (Moore et al. 2023).
  - Pure code rules reliably cover only length, position and keyword cues.
  - Solving accuracy improves with self-consistency (+17.9 on GSM8K) and program execution (PAL 72.0% → 80.4% with voting). That's solving, not wrong-key detection, and a same-family second sample can repeat the error (inferred).
- **Pipeline** (proposed; ours):
  1. Policy gate: `policy.mode`; no open graded item as a source.
  2. Code flaw rules.
  3. Quote exists in that resource version.
  4. An exactly-one-correct structural check.
  5. **Labels that say what ran and passed:**
     - "quote found in source" (code)
     - "answer checked by running it" (math or code, only where a safe evaluator exists)
     - "a second model agreed" (not a verification)
     - no generic "verified" badge
  6. `local_only` with Jev off (the default): code checks plus the local model only.
- **Execution of model-written code** needs a sandbox. Deferred.

**3.2 Explanations, not right/wrong**
- Elaborated feedback g=0.49, correct answer shown 0.32, right/wrong only 0.05 (Van der Kleij 2015; figure not re-verified from the PDF).
- Feedback helps only when it gives the correct answer (Pashler, via Metcalfe 2017).
- **→** Every item carries an explanation quoting its source, plus a "why that option was tempting" line. Drills give feedback immediately; a practice exam gives it at the end (a design choice).

**3.3 Formats**
- Short answer with feedback beat MC (d=0.41, Kang 2007, lab). MC with competitive alternatives aided related recall (d≈0.43–0.59, Little & Bjork 2012, lab).
- **→** Mix formats, with authored or reviewed distractors for Sunday. **Personalised distractors need stored responses** (the chosen option isn't in `Attempt`), so they're deferred.

**3.4 Typed answers: key-idea checklist, with a flag**
- LLM graders approach human agreement but don't reach it: κ 0.70 vs 0.75 human-human on K-12 open responses; medical short answers 0.61 vs 0.69; rubrics sometimes lowered agreement.
- **→** A checklist of key ideas, showing which were found. **"Flag this grade"** stores a dispute, and disputed outcomes are excluded from adaptation. No automatic regrading on Sunday.

**3.5 Difficulty**
- RCT on geography drill, ~3.3M answers, target error rates 5/20/35/50%: "easy questions are better for short term engagement, whereas difficult questions are better for long term engagement and learning" (its-target-difficulty.pdf).
- Learners rated C35 "Appropriate" most often, 66% (tech report FIMU-RS-2016-02).
- An earlier study found a suitable success rate "around 65%" (AIED 2015).
- **→** A design hypothesis to test: aim for about 65–75% success, with Warm-up / Normal / Push me.

**3.6 Readiness**
- Adaptive tests roughly halve item counts in psychometric settings, with smaller savings for small item pools.
- **→** Fixed, topic-labelled quizzes only. Report "observed performance on the items you practiced". **Readiness bands need representative exam coverage, enough responses and a validated meaning.** Deferred; not unlocked by an item count.

**3.7 A review queue for mistakes**
- Criterion learning then spaced relearning (Pyc & Rawson 2011: 3 correct recalls, then 3 relearning sessions); relearning attenuates the criterion effect (Rawson & Dunlosky 2012).
- **→** Misses enter a review queue. Unassisted, spaced successes lower an item's priority, and **nothing retires permanently.** Exam-date scheduling is a separate, tested design.

**3.8 Pretest before a lecture**
- g=0.54 for asked content, g=0.04 for everything else (preregistered meta-analysis); the authors flag classroom transfer as open.
- **→** Optional, and only when there's lecture material (§1.0).

**3.9 Untimed by default**
- 72% said retrieval practice made them less nervous (6% more nervous; the special-education subgroup 15% more), from a school survey.
- **→** Exam conditions are opt-in.

## 4. Evaluation that can't fool us
- **Code-checked results first:** quote validity, structural item checks, and a human-checked random sample of keys.
- **Seed about 20 items with known wrong keys or flaws.** Report what the pipeline catches and what it wrongly drops. That's the honest number behind any check label.
- **Avoid circularity:** the rubric checks the same properties as our gates, so a model family that both generates and judges inflates pass rates. Use a different family or a human for the judged sample.
- **Blind rating:** strip badges and citation styling before anyone rates.
- **LLM judges:** position bias is large (Claude-v1 kept its verdict after an order swap only 23.8% of the time), so always swap. Reference-guided grading cut wrong math verdicts from 14/20 to 3/20. MT-Bench agreement: GPT-4 vs humans 66% against human-human 63% with ties counted (S1), and 85% vs 81% without ties (S2).
- **Statistics:** report raw counts per course. No clustered standard errors with fewer than about 20 clusters. Pair per question. Freeze the gold before tuning the pipeline.
- **Competitor runs** use the same captured material. Where the material differs, the difference is itself the finding.

## 5. The earlier list, re-labelled
| # | Item | Status |
|---|---|---|
| 1 | Usage ledger | proposed: ours in the harness now; contract fields need Ben (see [where we differ](where-we-differ.md)) |
| 2 | Passages + retrieval | proposed: feature-side now; store-side offsets need Ben (see [where we differ](where-we-differ.md)) |
| 3 | Excerpt-list payload | proposed: **a shared interface; needs Ben** (see [where we differ](where-we-differ.md)); it drives the privacy preview |
| 4 | Per-resource validation | proposed: a concrete ingestion gap; needs Ben (see [where we differ](where-we-differ.md)) |
| 5 | utilityProcess worker | **built by Ben** |
| 6 | CI + eval | decided: the eval harness is ours; CI goes to Ben as a PR |
| 7 | Model routing | decided: a routing table per task; `typesafe/jev-router` measured first (G10) |
| 8 | Checked-item pipeline | proposed: ours |
| 9 | Caching + batch | decided: stable-prefix caching; batch only for overnight precompute |

## Review record (2026-09-26)
**Changes made from the reviews:**
- **The source-material gap is now §1.0.** It was the review's worst finding.
- **ALCE rerank row removed.** Its RERANK is response resampling (the 20.5→21.2 figure is QAMPARI; ASQA was 73.6→84.8).
- **ColPali baseline relabelled.**
- **MT-Bench figures corrected** to compare within the same setup.
- **Moore et al. scoped** to what it measured.
- **Solving accuracy is no longer evidence of key checking.**
- **Pelánek source corrected.**
- **Badge replaced with truthful labels.**
- **Retirement replaced with priority.**
- **Readiness no longer unlocked by an item count.**
- **Caching and batch marked blocked by policy.**
- **Built-by-Ben items marked.**
- **Evaluation made circularity-proof.**

Also noted: Ben's `tool-evaluation.md` still says node:sqlite is "experimental" (the docs now say RC), and `tests/storage.test.ts` asserts POSIX mode 0o600, which fails on Windows (0o666).

**Not re-verified:** Van der Kleij's figures; Kang, Little & Bjork, and the distractor papers; OpenAI and Gemini caching details.
