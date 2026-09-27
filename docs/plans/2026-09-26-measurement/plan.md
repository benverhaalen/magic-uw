# Measurement plan: build the harness, start measuring

**Status: Decision (ours).** Written 2026-09-26. It turns [benchmarking](../../notes/benchmarking.md) and the [benchmark catalog](../../notes/benchmark-catalog.md) into runnable work. The harness code is committed. **Data stays out of git:** public datasets are downloaded to `.data/bench/`, and course material is never committed. Every result goes in a dated run report with raw counts, the rows we lose, and the machine and model versions.

## What gets measured, per capability
| # | Capability | First measurement | Data | Metrics |
|---|---|---|---|---|
| MS1 | Backend speed | the baseline in the [backend plan](../2026-09-26-backend-optimization/plan.md) §1 | synthetic + labelled imported | sync requests and time, ingest throughput, query p50/p95, command round trip + snapshot bytes, cold start |
| MS2 | Grounded Q&A | our pipeline on the OCW gold (T0), plus an ALCE ASQA subset | OCW (local), ALCE (MIT) | **quote validity (code)** and **claim support** (human sample + ALCE NLI), reported separately; unanswerable honesty |
| MS3 | Long PDFs and slides | the extraction + retrieval pipeline on MMLongBench-Doc | Apache-2.0 | answer accuracy; correct "couldn't find support" on the unanswerable subset; extraction coverage per page |
| MS4 | Item quality | code flaw rules on the annotated MOOC MCQ set; the seeded-error set; generation compared against EduQG references | Zenodo record, OpenStax | flaw-rule precision and recall; seeded catch and false-drop rates; the human-rated rubric pass rate |
| MS5 | Knowledge model | our Elo-style estimator vs pyKT baselines on ASSISTments 2009 / EdNet, predicting the next answer per student | pyKT (MIT) + dataset terms | AUC, log loss, calibration (reliability bins) |
| MS6 | Spaced repetition | FSRS defaults vs fitted parameters; our R5 decay rule vs HLR | HLR (MIT); srs-benchmark (after the licence check) | log loss, AUC, RMSE (bins) |
| MS7 | Cost and efficiency | the ledger on every run: tokens in/out/cached, calls, latency per task. Cascade ablation: code-first vs all-model | our runs | tokens per answer, per guide, per 10-item quiz; Jev calls per sync (internal); p50/p95 latency |
| MS8 | Head-to-head | Gemini Notebook, Quizlet and ChatGPT/Claude projects given the same OCW material, collected by hand | OCW (local) | the S2/S3 metrics, setup minutes, time to first answer, quota hits |

## Tasks
```
MT1 perf harness (backend baseline)
  seat: implementer  model: opus  owns: [evals/perf/**]
  check: { argv: ["pnpm","exec","tsx","evals/perf/run.ts","--suite","baseline"], expectExit: 0 }
  accepts: writes .data/perf/<date>/baseline.json with every §1 metric; refuses to run without a recorded git SHA (negative)
MT2 dataset fetchers with licence gate
  seat: executor  model: sonnet  owns: [evals/datasets/**]
  check: { argv: ["pnpm","exec","tsx","evals/datasets/fetch.ts","--list"], expectExit: 0 }
  accepts: each dataset entry records url, licence, checksum; fetch refuses a dataset whose licence field is "unknown" until an operator note is added (negative); downloads only to .data/bench/
MT3 grounded-QA suite (MS2 + MS3)
  seat: implementer-deep  model: opus  owns: [evals/qa/**]  dependsOn: [MT2, learning answer composer]
  check: { argv: ["pnpm","exec","tsx","evals/qa/run.ts","--suite","smoke"], expectExit: 0 }
  accepts: quote-valid and claim-supported reported as separate columns; unanswerable subset scored for honest refusal; per-course raw counts; no clustered SE under 20 clusters (negative)
MT4 item-quality suite (MS4)
  seat: implementer  model: opus  owns: [evals/items/**]  dependsOn: [MT2, learning flaw rules]
  check: { argv: ["pnpm","exec","tsx","evals/items/run.ts","--suite","flaws"], expectExit: 0 }
  accepts: flaw-rule precision/recall per flaw type vs the annotated set; seeded set reports catch AND false-drop; generator and judge must be different model families or human (negative: same family refused)
MT5 knowledge-model offline suite (MS5 + MS6)
  seat: implementer-deep  model: opus  owns: [evals/km/**]  dependsOn: [MT2, learning knowledge model]
  check: { argv: ["pnpm","exec","tsx","evals/km/run.ts","--suite","assist09-small"], expectExit: 0 }
  accepts: AUC/log-loss/calibration for our estimator next to pyKT baseline numbers produced on the same split; split by student, no leakage (negative: a student in both train and test fails the run)
MT6 ledger + cascade ablation (MS7)
  seat: implementer  model: opus  owns: [evals/cost/**]  dependsOn: [MT3]
  check: { argv: ["pnpm","exec","tsx","evals/cost/run.ts","--suite","ablation-smoke"], expectExit: 0 }
  accepts: per-task tokens, calls, latency; code-first vs all-model on identical cases; Jev figures written only to .data (negative: a Jev number in any committed file fails the check)
MT7 head-to-head protocol (MS8)
  seat: lead + operator  owns: [.data/bench/h2h/**]
  check: blind key file exists before scoring; bench-judge verdicts with order swaps
  accepts: same material for every system; setup minutes and quota hits recorded; rows we lose published
```

## Order
1. **MT1 and MT2 first:** no product code needed.
2. **MT5:** the knowledge model can be measured on public data **before we have students.**
3. **MT3, MT4 and MT6,** as the learning package lands.
4. **MT7:** after the first internal results.
