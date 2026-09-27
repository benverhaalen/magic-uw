# Benchmarks

How My Magic UW is measured, and what the numbers are. This is the single record: every figure below cites the file, commit or pull request it comes from, and every figure carries its status.

**As of:** 2026-09-27, `main` at `699e386`.

| Status | Meaning |
|---|---|
| **on main** | the code and the measurement are merged into `main` |
| **tested in isolation** | measured on a named branch that is not merged; the number holds for that branch only |
| **live (private aggregate)** | measured on the operator's own UW account; counts only, no course content, raw files outside Git |
| **not measured** | a target or protocol exists; no run has produced a number |

A missed target is reported as missed, in the same table as the met ones. Nothing here claims a learning gain, a model's writing quality or a win over a competitor; those rows are in [what is not yet measured](#6-what-is-not-yet-measured).

## 1. Method

### 1.1 Hardware and software

Every measured figure below comes from one machine unless it says otherwise: Windows 11 Home (10.0.26200), Intel Core Ultra 9 275HX (24 cores), 31.4 GiB RAM, Node 24.14.1, SQLite 3.51.2 (`docs/course-backend-architecture.md` §8.1; the item-eval reports record the same CPU and Node). CI runs on GitHub's `ubuntu-latest` (`.github/workflows/verify.yml`). No figure has been reproduced on a second machine.

### 1.2 Harnesses

| Harness | Command | What it drives | Where |
|---|---|---|---|
| MT1 backend performance | `pnpm magic:perf --suite baseline` | ingest, database size, search latency, snapshot size, migration, Canvas sync replay, jobs per sync; synthetic corpus at 10 / 100 / 1,000 / 5,000 resources | `evals/perf/baseline.ts`, `synthetic.ts`, `stats.ts`, `run.ts` (on main) |
| Canvas first sync (T17) | `pnpm magic:perf --suite canvas` | a full first sync replayed with a 150 ms per-request latency model, in the shape of the live account (9 modules per course, 4 of 5 Pages lists hidden) | `evals/perf/baseline.ts` `canvasFirstSync`, `canvas-replay.ts` (on main) |
| File acquisition | `pnpm magic:perf --suite documents` | a synthetic term of 5 courses and 300 mixed files, Files tab hidden, downloads redirected to an Instructure file host, 60 ms latency | `evals/perf/documents.ts` (on main) |
| Item quality (MT4) | `pnpm eval:items --suite smoke\|offline\|live` | the real pack path (`generatePack`) over course scopes, scored by code metrics | `evals/items/**` on branch `feat/item-eval` (tested in isolation) |
| Budget gates | `pnpm test` | request, latency and correctness ceilings asserted as tests (§1.6) | `tests/*.test.ts` (on main) |

No harness touches the network or a real account. The replay transport serves recorded responses from the synthetic university in `packages/connectors/src/canvas-fixture.ts` through the connector's own `fetch` seam. Live figures come from separate, operator-present trials and are labelled as such.

### 1.3 Runs, percentiles and sample sizes

- **Warm-up:** each timed perf series discards one warm-up run, so module JIT and schema compilation aren't billed to run 1 (`evals/perf/baseline.ts`).
- **Runs:** sync 5 runs, query 5 runs over 24 queries (120 samples), snapshot 5, database open 5, ingest 3 repeats; T17's first sync 3 paced runs (`baseline.ts` constants `SYNC_RUNS`, `QUERY_RUNS`, `SNAPSHOT_RUNS`, `OPEN_RUNS`, `INGEST_REPEATS`, `FIRST_SYNC_RUNS`).
- **Percentiles:** nearest-rank over the raw samples (`evals/perf/stats.ts`). **With fewer than 20 samples, a "p95" is the maximum of the runs**, not an estimate of the 95th percentile; the tables below say so wherever it applies.
- **Noise:** across repeated MT1 runs, throughput varied about ±20% and p95 up to 2.6×. So MT1's adopt thresholds ask for an effect of 3× or more, or for a structural change (`docs/course-backend-architecture.md` §8.1).
- **Rates** are reported as k/n with a Wilson 95% interval, which keeps its coverage near 0 and 1 where the normal approximation fails. Intervals marked *computed here* were computed for this document from the published k and n; the item-eval intervals come from its own reports.
- **Deterministic fixtures:** a synthetic fixture gives the same count on every run, so a count such as 285/300 is a property of the fixture, not a sample; no interval is attached to it.

### 1.4 Same-run references

A before/after pair is only compared when both sides come from the same harness on the same machine:

- **MT1:** the baseline (`91e39fa`) and the "after" (`f365af7`, task T14) ran the same `pnpm magic:perf --suite baseline` on this laptop. Both commits are on branch `feat/course-backend`; their history reached `main` squashed into `780aaed` (PR #6).
- **Item quality:** the "before" column puts the original pack code from `10eeb2d` back and runs the same harness, so the two columns differ only in the generator code (`3172c2a` on `feat/item-eval`).
- **Intent router latency:** the AI-only and fallback series are 24 interleaved pairs in one test run, so machine load hits both sides equally (`tests/intent-latency.test.ts`).
- **Pull-request figures** (T17, acquisition, MCP search, purge, agenda): each PR states its before and after from its own branch. The PRs don't record whether both sides ran in the same session; they are marked "n not stated" where the PR gives no run count.

### 1.5 Pre-registered thresholds

Thresholds are fixed before the run they judge, and changing one after a run is a new registration with its own date.

| Suite | Where the thresholds are fixed | When |
|---|---|---|
| MT1 storage and IPC | the "Adopt at" column of `docs/course-backend-architecture.md` §8.1 | with the baseline at `91e39fa`, before the storage lane's changes |
| Public comparisons | the comparative rows of spec B6 (`docs/plans/2026-09-26-course-backend/spec.md`) | 2026-09-26, before any competitor run |
| Item quality | `evals/items/thresholds.json` on `feat/item-eval` (sha256 prefix `4185ebf297afda52`) | 2026-09-27, "before the first scored run"; a met threshold whose interval crosses it is reported as "met, not established at 95%" |
| Case files | `evals/freeze.ts` hashes every case file (SHA-256, LF-normalised); `--verify` fails on any changed, missing or extra file | the smoke cases on main (`evals/cases/smoke/FROZEN.sha256`); the item cases on `feat/item-eval` (`evals/items/cases/FROZEN.sha256`) |

### 1.6 Budget gates in CI

CI runs `pnpm install --frozen-lockfile`, `pnpm test` and `pnpm build` on every push and pull request (`.github/workflows/verify.yml`). These tests turn a measured budget into a failing build:

| Gate | Asserts | Test |
|---|---|---|
| Hot tick cost | a zero-change hot tick stays below 10% of a full sync; metadata revalidation ≤4 requests per course and ≤10% of the 208-request pre-T17 baseline | `tests/refresh-course.test.ts` |
| Freshness | a new undated module file is found by the content probe within 15 minutes, and only that course is re-read | `tests/refresh-course.test.ts` |
| Canvas request shape | module items arrive in one request per course, under the per-host limit; an identical GET is read once per sync | `tests/canvas-sync-speed.test.ts`, `tests/fetch-scheduler.test.ts` |
| Rate-limit behaviour | never more in flight than the per-host limit; 429 honours Retry-After; Canvas's 403 throttle backs off | `tests/fetch-scheduler.test.ts` |
| File budget | the file budget is shared across a run's drains; deferred files advance next run | `tests/sync-file-budget.test.ts` |
| Code-first latency | the AI fallback's p95 is within 10 ms of AI-only p95; a code hit bills 0 calls | `tests/intent-latency.test.ts` |
| One drain | a save during a sync leases nothing, Jev included, until the sync ends | `tests/one-drain.test.ts` |
| Purge | no content row remains in any table; both sessions' caches and every app-owned folder are cleared | `tests/fix-platform-storage.test.ts` |
| MCP token budget | oversized results are trimmed to the tool's budget, never refused | `tests/fix-platform-search.test.ts` |
| Item quality smoke | two synthetic courses meet every threshold in `thresholds.json` | `tests/item-eval.test.ts` on `feat/item-eval` (tested in isolation) |

Two platform-specific tests are gated so Linux CI stays green (PR #7). No wall-clock performance figure other than the intent-router gate is asserted in CI, because shared runners are too noisy for millisecond thresholds.

### 1.7 Reporting template

Every published number carries, inline or in the row:

```
<value> [n=<sample size>] [<Wilson 95% CI for a rate>] - <machine>, <commit>, <date>
  measured by: <command or test>
  corpus tier: synthetic | Tier A (public MIT OCW, local only) | Tier B (private, aggregates only)
  compared against: <system, version, date, model> | internal only
  judge: code metric | human (blind, raters, agreement statistic) | LLM judge (order-swapped, reference-guided)
  what this number cannot show: <one sentence>
```

The rules behind it are in [benchmarking](notes/benchmarking.md): freeze the gold first, independent gold, no model grades itself, seeded errors with both catch and false-drop rates, blind rating, paired comparisons, and publish the rows we lose.

## 2. Performance results

### 2.1 MT1: storage, search and IPC at 5,000 synthetic resources

Before `91e39fa`, after `f365af7` (T14); both synthetic, this laptop. Sources: `docs/course-backend-build-record.md` §5.1 and `docs/course-backend-architecture.md` §8.1. **Status: on main.**

| Metric | Before | After | Threshold | Result |
|---|---|---|---|---|
| Ingest throughput | 78 resources/s | 1,431 resources/s | ≥750 | met (>18×) |
| Database size per 1,000 resources | 15.6 MB | 10.3 MB | ≤11 MB | met |
| Search p50 / p95 through the store API (n=120: 24 queries × 5 runs, per the harness) | 56.0 / 197.4 ms | 3.3 / 4.8 ms | ≤5 / ≤15 ms | met |
| `searchPassages` p50 / p95 | — | 3.4 / 5.5 ms | — | measured |
| Migration v5 → v7 with a backup | — | 1.60 s, 0 rows lost | ≤2 s | met |
| Purge | 8.7 s | 0.48 s, 0 rows left | ≤1 s | met |
| Question recall@5, 52 planted questions | 0.0 | 1.00 (52/52; 0.93–1.00, computed here) | ≥0.90 | met |
| Correct "not found", 26 unanswerable questions | — | 0.96 (25/26 inferred from 0.96 × 26; 0.81–0.99, computed here) | ≥0.80 | met |
| Zero-change re-sync growth | — | +1.48% | ≤1% | **missed** (secondary) |
| Ingest slope, last batch vs first | — | 2.97× | ≤2× | **missed** (secondary) |

**What this cannot show:** real UW timing. Synthetic text compresses about 2.6×, better than real course text will. The planted questions were written by the builder, not independently. MT1's sync p95 (n=5) is the maximum of 5 runs.

**IPC payload (T15 scoped queries, 5,000 resources; build record §5.3):** the full snapshot every command used to return was 30.6 MB; a summary query is 17.5 KB, a 50-row course page 78 KB, one resource 2.5 KB. The MT1 baseline also recorded 28.8 MB and a 480 ms execute p50 for the snapshot (architecture §8.1). **Status: on main (backend); the renderer switch is documented in architecture §5.**

### 2.2 Canvas sync (T17)

**Replay, 5 synthetic courses, 150 ms latency model** (PR #8, merged as `274f738`; harness `pnpm magic:perf --suite canvas`, 3 paced runs after a warm-up, so the wall time is a median of 3). **Status: on main.**

| Metric | Before | After |
|---|---|---|
| Requests for a first sync | 115 | 65 (−43%) |
| Wall time | 5.7 s | 2.1 s (2.65× faster) |
| Zero-change tick | — | ≤4 requests per course (gated in CI, §1.6) |

What changed: one bounded scheduler per sync (6 requests in flight per host, honouring Canvas's `X-Rate-Limit-Remaining` and cost headers, backing off on 403/429); module items read inline with `include[]=items`; identical GETs read once per sync; a manual sync within 60 s of a sign-in read reuses it.

**After T17 was integrated with the sync-resilience work** (`docs/sync-resilience-review.md`, synthetic, request counts only):

| Fixture | Full read | Unchanged hot tick | Content tick with direct revalidation |
|---|---|---|---|
| Base university | 123 → 99 | 2 | 38 |
| 8 modules / 12 pages per course | 188 → 154 | 2 | 48 |

**Freshness, 5 synthetic courses** (build record §5.2): a hot 5-minute tick costs 2 requests (1.0–1.7% of a full sync); a tick with the content probe 18 requests (8.7–15.3%); the 15-minute average is 3.5–6.2%. A new undated file was found within 15 minutes, and only its course was re-read (16 requests).

**Live (private aggregate), before T17:** the first Canvas read of the operator's account took 125 requests, 65 s and 3.3 MB for 6 current courses, with 0 AI or Jev requests (build record §6, 2026-09-26). The target is a first full sync in ≤10 s. **T17 has not been re-measured live**, so that target is neither met nor missed yet.

**What this cannot show:** the replay's fixture sizes differ between these tables (115, 123 and 208 requests are three fixture versions), so compare within a table, not across them.

### 2.3 File acquisition

Synthetic 300-file course, Files tab hidden, 60 ms latency (PR #22, merged as `355602c`; `pnpm magic:perf --suite documents`). **Status: on main.**

| | Files with text | Syncs to settle | Second sync: metadata / downloads |
|---|---|---|---|
| Before (the live failure reproduced) | 0/300, every file `secret_origin_blocked` at the Instructure file host | 4 | 96 / 0 |
| After | 285/300 (the other 15 are scans, marked `needs_ocr`) | 1 | 0 / 0 |

The "before" row matches what the live pipeline saw: every downloaded file had 0 text on the operator's account (PR #13). The fix downloads through the student's Canvas session and follows redirects only to hosts verified in the canvas-lms source. Scanned pages are read by the Windows OCR engine at about 1.8 s per page (PR #22). **Not yet live-tested on UW Canvas.**

### 2.4 One job drain

PR #23 (merged as `1f9e5b1`) removed core's second, inline drain, which leased the pipeline's jobs during a sync. Every job kind, Jev's `enrich.resource` included, now runs in one pipeline loop. This is a structural result, gated in CI (§1.6): on the old code the first two tests of `tests/one-drain.test.ts` fail. **Status: on main.**

**Live (private aggregate):** the material pipeline drained 1,254 jobs in 12.8 s with 0 failures, about 1,800 passages/s (PR #13, 6 current courses).

### 2.5 Intent router: the code path and the zero-latency fallback

Source: `docs/course-backend-architecture.md` §12 and `tests/intent-latency.test.ts` (PR #24, merged as `ae66b91`). **Status: on main.**

| Path | Measured | n |
|---|---|---|
| Code hit (0 tokens) | p50 1.1 ms, p95 3.2 ms, 0 billed calls | 24 |
| AI fallback after a code miss | p50 / p95 811 / 819 ms | 24 pairs |
| AI only (same fake CLI, fixed 800 ms, warm pooled session) | p50 / p95 809 / 820 ms | 24 pairs |
| Added p95 of the fallback | −0.9 ms (earlier runs −17 to +4 ms: scheduling jitter) | |

The AI branch prepares while code resolves and sends only on a miss, so a miss costs no added latency. CI fails if the fallback's p95 is more than 10 ms above AI-only.

**Live (private aggregate), 40 realistic commands on a read-only copy of the operator's workspace:** code resolved 25/40 (63%; 0.47–0.76, computed here), all 25 correct; 3/40 clarified by code at 0 tokens; resolver p95 0.7 ms; code-path commands excluding the agenda p50 0.6 ms, p95 8.5 ms. The 12 that need the model were not run, because no isolated client profile was signed in.

### 2.6 Agenda

The `due` verb rebuilt the course-inclusion check once per assignment: O(n²), **25–41 s** on 306 assignments. Computed once, the `due` verb takes p50/p95 **576/580 ms** and the agenda command (now the pipeline's agenda) **216/264 ms** on a live-shaped copy (architecture §12; PR #24). n not stated. **Status: on main.**

### 2.7 MCP search

At 5,000 resources, MCP search went from p50 **6.3 s** to about **0.28 s** by searching `passage_fts` (BM25, OR) within the grant's courses and scrubbing only the returned items (PR #19, merged as `05df710`). n not stated. **Status: on main.**

### 2.8 Purge

"Delete local data" removes every table in `sqlite_schema`, every app-owned file, both sessions' HTTP caches and the reader's receipt log.

| Measurement | Result | Source |
|---|---|---|
| Before the storage lane | 8.7 s at 5,000 | architecture §8.2 (P2 spike) |
| T14 (MT1 after) | 0.48 s, 0 rows left | build record §5.1 |
| At `fc43f7a` → foreign keys off for the purge transaction | 0.66 s → 0.35 s, one run each | architecture §6 table; PR #19 |

Target ≤1 s: met. The 0.48 s and 0.66 s figures come from different commits and schemas; each is a single run. **Status: on main.**

### 2.9 AI cost paths

| Measurement | Result | Source | Status |
|---|---|---|---|
| Jev calls for a synthetic 100-assignment course, after code decides quiz/discussion from `submissionTypes` | 100 → 50 | PR #14 (`0497b73`) | on main |
| A fresh `claude -p` vs a warm-session follow-up | 5.8–7.4 s vs 1.7–2.2 s; fixed tokens 11.3k → 2.8k | build record §5.5 | measured; the pool is not yet the accepted default |
| A repeat pack request with unchanged content | 0 tokens, no model call (38/38 in the item eval) | §3.1 | tested in isolation |
| Live sync | 0 AI or Jev requests | build record §6 | live (private aggregate) |

### 2.10 Privacy retention

Branch `feat/privacy-hardening` (PR #25, open, head `079a865`; `tests/privacy-retention.test.ts`, `docs/ai-and-privacy.md` "Measured retention" on that branch). **Status: tested in isolation.**

Corpus: 742 teaching texts, including 730 pages of the local MIT OCW copy (read on the machine, never committed); 696,516 characters; a roster of five students.

| Metric | Result | Target |
|---|---|---|
| Teaching characters changed | 0 (0.0000%) | ≤0.5% |
| Non-person replacements in teaching material (IPs, addresses, card, SSN or birth-date numbers) | 0 | 0 |
| Personal canaries leaked | 0/14 (95% upper bound 0.22, computed here) | 0 |

**What this cannot show:** 14 canaries bound the leak rate only below about 22%; a tighter claim needs a larger canary set. Characters are not independent trials, so no interval is attached to the 0%.

## 3. Quality results

### 3.1 Item quality: flashcards and quizzes (MT4)

Branch `feat/item-eval`: the harness at `b9f09de`, the generator change at `3172c2a`. **Status: tested in isolation.**

The offline suite (`pnpm eval:items --suite offline`) ran on this laptop (Intel Core Ultra 9 275HX, Node 24.14.1) on 2026-09-27: 43.7 s for the "before" run, 100.7 s for the "after" run (the reports' own durations). Corpus: 4 synthetic courses, one per subject family (languages, math, computing, humanities), plus the local MIT OCW copy (6.006, 6.042J, 18.05), read in memory and never committed.

The baseline puts the original pack code from `10eeb2d` back and runs the same harness, so the two columns differ only in the generator code. Each figure is rate (k/n; Wilson 95% interval).

| Metric | Threshold | Before | After |
|---|---|---|---|
| Planted defects caught | ≥0.9 | 0.69 (43/62; 0.57–0.79), **missed** | 0.98 (58/59; 0.91–1.00) |
| Correct items wrongly dropped | ≤0.05 | 0.03 (5/198; 0.01–0.06) | 0.00 (0/196; 0.00–0.02) |
| Items with a cue flaw | ≤0.05 | 0.01 (2/200; 0.00–0.04) | 0.00 (0/197; 0.00–0.02) |
| Courses getting the right item types for their subject | 1.0 | 0.75 (3/4; 0.30–0.95), **missed** | 1.00 (4/4; 0.51–1.00) |
| Prompts that state the course's subject | 1.0 | 0.00 (0/57; 0.00–0.06), **missed** | 1.00 (57/57; 0.94–1.00) |
| Cloze answers left visible in the card | none | 2 of 59 | 0 of 53 |
| Reverse-direction vocabulary cards | none | 0 | 14 |

Met in both runs:
- responses parsed: 1.00 (147/147; 0.97–1.00)
- stored quotes verbatim: 1.00 (216/216 before, 217/217 after)
- exactly one correct answer: 1.00 (87/87 before, 85/85 after)
- near-duplicates: at most 0.01 (0/200 before, 1/197 after)
- repeat requests at 0 tokens: 38/38
- modules covered: 12/12
- gold topics covered: 0.69 (35/51; 0.55–0.80)

The smoke suite (2 synthetic courses) runs inside `pnpm test` on that branch (`tests/item-eval.test.ts`) and meets every threshold.

**Disclosed with the result:**
- The one planted defect still missed after the change is an unparseable model response: the pack command throws, because the SQL ledger rejects the runner's row with an empty model name. The branch tracks it with a todo test.
- Five planted defects need a judge (an altered term definition, a wrong key) and are not run offline.
- On OCW 6.006 and 18.05, every pack ended `needs_student` in both runs: the rule-based stand-in writer extracts too few facts from OCW text to pass the checks. Only OCW 6.042J stored items (12), which is why subject fit is scored on the synthetic courses.

**What these numbers can't show:** offline items come from a rule-based stand-in writer, not a language model. So they measure the app's checks, pipeline, cache and storage, not how well any model writes. The planted defects and gold topics were written by the harness builder, not independently. The live suite (a real model through the student's signed-in client) has not run.

### 3.2 Retrieval

- **Passage search on MT1:** recall@5 1.00 on 52 planted questions; correct "not found" 0.96 on 26 unanswerable questions (§2.1). Builder-written questions on synthetic text.
- **P2 spike, synthetic:** OR + BM25 found 10/10 planted answers where the old prefix-AND query found 0/10 (build record §5.4).
- **Grounded ask, live (private aggregate):** the coverage gate retrieved passages for 9 of 10 real questions and answered "Not in your materials" for 1 with no model call (architecture §12). Citation pass rates need a signed-in client and have not been measured.

### 3.3 Material pipeline on live data (private aggregate)

PR #13 (6 current courses on the operator's account):
- 96.4% of 673 live materials categorised by code; 24 flagged `needs_judgment`
- assignment references: recall 100% of 175 body links (0.98–1.00, computed here) and 10 named items
- the agenda against Canvas's own to-do and upcoming lists: 0 missing, 0 duplicates, 0 date mismatches

## 4. Robustness

**Prompt-injection harness:** nothing measured; no harness runs took place. Branch `feat/injection-harness` exists with no commits beyond `10eeb2d`.

What exists today is test coverage, not a benchmark: adversarial course-intelligence inputs (`tests/course-intelligence-adversarial.test.ts`); name probing through MCP search ranking (`tests/fix-platform-search.test.ts`); the model gets no tools inside the app, and code checks every quote, ID and date it returns (spec §2). None of these produce a rate against a set of attacks.

## 5. Competitor comparison protocol

**Status: not measured.** The protocol is fixed (spec B6, [benchmarking](notes/benchmarking.md)); no competitor has been run.

- **Systems:** NotebookLM first; then Open Notebook self-hosted on the same model as ours, Quizlet, and ChatGPT or Claude Projects. The model each tool uses is recorded per run. Since NotebookLM's own token use can't be observed, a NotebookLM-style long-context baseline (every scoped source in context, on our model) isolates the architecture from the model.
- **Material:** one MIT OCW course imported locally for every system, plus the operator's own course (aggregates only).
- **Pre-registered:** the targets in spec B6 were fixed on 2026-09-26; the case file is hashed with `evals/freeze.ts` before any system runs.
- **Blind:** system names are shuffled into letters; badges, check labels and citation styling are stripped before rating.
- **Order-swapped:** an LLM judge rates each pair in both orders and reports its swap consistency (one early judge kept only 23.8% of verdicts after a swap; Zheng et al. 2023, [arXiv 2306.05685](https://arxiv.org/abs/2306.05685)). Anything with one right answer is judged against the reference; math is checked by execution. The generator's model family never judges its own output.
- **Agreement:** a second blind rater scores 20% of item tasks; agreement is Cohen's kappa, quadratic-weighted for ordinal rubric items. `evals/items/blind.ts` on `feat/item-eval` implements the shuffled export, both orders, swap consistency, weighted kappa and the same-family refusal (tested in isolation, not yet run on a competitor).
- **Statistics:** per-question paired differences, raw counts per course. With 30 questions, a pass rate near 50% has a standard error of about 0.09, so only a gap of roughly 25 points is detectable at 80% power and 5% significance (2.8 × √(0.25/30), computed here after Miller 2024, [arXiv 2411.00640](https://arxiv.org/abs/2411.00640)); pairing narrows this only when the systems' per-question scores correlate. Smaller gaps are reported as within noise.
- **Contamination:** OCW text may be in a model's training data, so a closed-book run (retrieval off) is reported beside the grounded run; a small gap between them flags memorisation, not retrieval.
- **Hand-timed rows:** public tools are timed by hand from the same 30 questions in the same order, with screen-recording timestamps. No scripted access to competitor interfaces.
- **Losses published:** a row we lose is published in the same table.

## 6. What is not yet measured

| Item | Why it matters | Status |
|---|---|---|
| Live Canvas first sync after T17 | the ≤10 s target (live was 65 s before T17) | not measured |
| Live file acquisition and OCR on UW Canvas | the 285/300 result is synthetic | not measured |
| Live Outlook (Microsoft Graph) sync | mail and calendar freshness | not measured |
| Item quality with a real model (`--suite live`) and the judge-needing planted defects | the writing quality of generated cards and quizzes | not measured |
| MT2/MT3 grounded Q&A and long PDFs; MT5 knowledge model; MT6 cost and cascade ablation | answer quality, extraction, estimator calibration, tokens per task | not started |
| MT7a/MT7b head-to-head comparisons | every comparative claim | protocol fixed, not run |
| Prompt-injection robustness | a rate against a fixed attack set | no harness run |
| Renderer ↔ worker round trip and cold start | user-visible latency | no timing hooks yet |
| Warm session pool as default (spikes S1–S10) | idle memory, history growth, Codex caching | not measured |
| Citation pass rate of the grounded ask | quote-checked answers from a real model | needs a signed-in client |
| Independent gold and a second machine | builder-written gold; single-machine timings | not done |

## 7. Sources

| Figure | Source |
|---|---|
| MT1 before and after, IPC payloads, freshness, live trial, warm sessions | `docs/course-backend-build-record.md` §5, §6; `docs/course-backend-architecture.md` §8 |
| T17 | PR #8 (`274f738`); `evals/perf/baseline.ts`; `docs/sync-resilience-review.md` |
| File acquisition | PR #22 (`355602c`); `evals/perf/documents.ts` |
| One drain; live drain throughput | PR #23 (`1f9e5b1`); PR #13 |
| Intent router; agenda | PR #24 (`ae66b91`); `docs/course-backend-architecture.md` §12; `tests/intent-latency.test.ts` |
| MCP search; purge | PR #19 (`05df710`); `docs/course-backend-architecture.md` §6 |
| Jev calls 100 → 50 | PR #14 (`0497b73`) |
| Privacy retention | PR #25, branch `feat/privacy-hardening` at `079a865` (tested in isolation) |
| Item quality | branch `feat/item-eval` at `b9f09de` and `3172c2a` (tested in isolation); run reports kept locally, not committed, because their item files quote OCW text |
| Protocol and rules | spec B6; [benchmarking](notes/benchmarking.md); `docs/plans/2026-09-26-measurement/plan.md` |
