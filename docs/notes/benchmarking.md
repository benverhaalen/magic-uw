# Benchmarking honestly: how to show we are better, or learn that we aren't

**Status: Proposal.** 2026-09-26. This follows the [engineering principles](../engineering-principles.md): a claim is a claim until we measure it, benchmark ownership is named, and failures are recorded. Nothing here is a result yet.

## What we measure
| # | Task | Metric | Gold |
|---|---|---|---|
| 1 | Setup | minutes and clicks from zero to a usable course workspace; share of the course's files present | a hand inventory |
| 2 | Course Q&A with citations | answer correctness · **quote validity** (code: the literal span exists in that source version) · **claim support** (judged separately) · correct "couldn't find support in what I searched" on unanswerable questions | ~30 answerable questions per course with a gold passage, plus ≥8 unanswerable |
| 3 | "What does Exam N cover?" | material-mapping precision and recall | a coverage key from the course calendar |
| 4 | Practice items | the share passing a blind rubric (answerable from the source, exactly one correct answer, on topic, not trivial) · **seeded-error catch rate and false-drop rate** | ~20 items with planted wrong keys or flaws, plus a human-rated sample |
| 5 | Practice exam coverage | the share of a real exam's topics covered by practice built **without** that exam | a held-out public exam |
| 6 | Freshness | minutes from a source change to a correct answer | a planted edit |
| 7 | Cascade ablation | code → local model → Jev → larger model vs all-model: correctness × latency × usage | the same tasks |
| 8 | Speed | cold and warm latency per user action on the target laptop | measured, never quoted from vendors |

**Quote validity and claim support are always reported separately.** A real quote can still fail to support the claim built on it.

## Corpus
- **Tier A (public, reproducible):** MIT OpenCourseWare courses with lecture notes, problem sets and exams with solutions (for example 6.006 Introduction to Algorithms, 6.042J Mathematics for Computer Science, 18.05 Probability and Statistics). They're **CC BY-NC-SA 4.0**, so they're used locally for evaluation and never shipped or committed. They're imported as labelled, imported material, never as "synthetic".
- **Tier B (private, realistic):** team members' own UW courses, with consent. Only aggregates are reported.
- **Commit only** the harness code and synthetic cases. Case files built on course material stay out of git.

## Rules that stop us fooling ourselves
1. **Freeze the gold first.** Hash every case file before any pipeline tuning; the harness refuses unfrozen cases.
2. **Independent gold.** Whoever builds the pipeline doesn't write or judge its gold. The judged sample goes to a human or a different model family.
3. **Don't let one model grade itself.** The item rubric checks the same properties as our generation gates, so if one model family generates, gates and judges, the pass rate inflates.
4. **Seeded errors.** Plant ~20 items with wrong keys, two correct answers, no correct answer and cue flaws. Report what the pipeline catches **and** what it wrongly drops. That's the honest number behind any check label.
5. **Blind rating.** Strip badges, check labels and citation styling before anyone rates, and shuffle system identities into letters.
6. **LLM judges:**
   - Always swap the answer order; one early judge kept its verdict after a swap only 23.8% of the time (Zheng et al. 2023, arXiv 2306.05685).
   - Grade against a reference answer; on math this cut wrong "correct" verdicts from 14 of 20 to 3 of 20 (same paper).
   - Calibrate the judge on human labels before trusting it.
7. **Statistics:**
   - Pair every comparison per question.
   - Report raw counts per course.
   - Don't use clustered standard errors with fewer than ~20 clusters.
   - Use exact or paired tests for small samples.
   - State what a sample can't show. With zero errors in 300 independent auto-decisions, the 95% upper error bound is still about 1% ([pipeline details](../pipeline-details.md)).
   - Reference: Miller 2024, "Adding Error Bars to Evals", arXiv 2411.00640.
8. **Reproducible runs:**
   - One command rebuilds every reported number, with recorded model outputs replayed byte for byte.
   - A live run states its tolerance.
9. **Publish the rows we lose.**

## Competitors
| System | How its outputs are collected |
|---|---|
| NotebookLM | By hand in a personal account: the same files, the same questions, answers and citations copied into the outputs file. **No scripted access to competitor UIs.** |
| open-notebook | Run locally with **the same model as ours**, to isolate the architecture effect |
| ChatGPT / Claude projects | By hand, with the same files |
| Quizlet-style tools | By hand; generated from the same material, then exported |

- **Record for every system:** its version or date, plan tier, model if known, setup minutes, and time to first answer.
- **If NotebookLM gets material we lack** (or the reverse), the difference is itself the finding.

**Fair framing:** NotebookLM is strong at grounding in controlled studies. It scored 86% on lung-cancer staging against 39% for GPT-4o given the same reference text (PMID 39585559), and 70% against 38% on pancreatic staging (PMID 41784908). Both studies come from one lab, on fictional cases. We compete on what it doesn't do, and we don't claim it hallucinates.

## What we won't claim
- A learning gain. The effect sizes we cite come from other studies' populations; we haven't measured ours.
- Readiness or a "probability of passing".
- "Verified" items without saying which check ran.
- Any vendor's speed or cost savings as ours.
- **Any Jev performance number,** until TypeSafe's customer agreement has been checked.
