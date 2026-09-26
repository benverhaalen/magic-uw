# Backend optimization: faster and cheaper than the alternatives, measured

**Status: Decision (ours), with a measure-first list.** Written 2026-09-26 against `main` at `73ff7a6`. Ben's first backend is finishing. We take it from there, **measure it, then optimize and extend it.** When his final version lands, the baseline in §1 is re-run before any change, and this plan is updated from the diff. Labels: **decided** · **measure first** · **built** (in Ben's code today).

## Goal
- **Per student, per semester:** the lowest total cost and the least waiting of any comparable study system.
- **Total cost counts everything:**
  - the model tokens used on the student's own plan
  - our Jev calls
  - network requests to UW
  - local CPU, memory and disk
- **Waiting counts:** setup to first useful answer, sync time, and time to answer, quiz and artifact.
- **Every claim comes from our own runs.** See [benchmarking](../../notes/benchmarking.md).

## 1. Baseline first (measure the backend as Ben delivers it)
Harness: `evals/perf/`. It's headless and uses synthetic plus labelled imported data; it writes to `.data/perf/` (not committed).

| Metric | How | Why |
|---|---|---|
| Canvas sync: requests, bytes and wall time per course; a re-sync with zero changes | a replay transport with recorded responses, plus one live run with the operator present | the incremental sync target is near-zero requests when nothing changed |
| Ingest throughput: resources per second; DB size per 1,000 resources | `createStore` on a temp file, ingesting 10 / 100 / 1,000 / 5,000 resources | shows statement and FTS costs |
| Query latency: `resources(search)` p50/p95 at those sizes | a fixed query set | the retrieval budget |
| Command round trip: renderer → worker → renderer, with snapshot size in bytes | a headless Electron smoke test with timers | **the snapshot grows with use** (see §2) |
| Cold start: launch → first paint → worker ready → DB migrated | a headless smoke test | the perceived speed |
| AI cost ledger per artifact: tokens in/out/cached, calls, latency for a Q&A answer, a study guide, a 10-item quiz, a lecture note | the model adapter records every call | the per-student cost model |
| Jev calls per course sync, and per 100 items checked | the gateway client counter | our marginal cost (numbers stay internal) |

## 2. Decided optimizations (the evidence is already in the code or docs)
| # | Change | Where | Evidence and reason |
|---|---|---|---|
| O1 | **Scoped queries instead of full snapshots.** Commands return only what the view needs (paged resources, one course, one item) plus a small change feed. The full `Snapshot` stays for debugging | `core` `snapshot()`, `contracts` `Snapshot`/`CommandResult`, renderer | `snapshot()` returns every resource, judgment, job, receipt **and attempt** after every command (core `snapshot`, `store.attempts()`). The payload and the IPC clone grow with use, and practice writes many attempts |
| O2 | **Prepared-statement cache** | `storage` | statements are prepared inline inside ingest loops; preparing once and reusing is standard SQLite practice |
| O3 | **`PRAGMA synchronous = NORMAL` with WAL** | `storage` open | WAL already on. In WAL mode, NORMAL avoids an fsync per commit and stays corruption-safe; at worst the most recent commits are lost on power failure. Captures can be refetched. Record the durability trade-off |
| O4 | **Passages with offsets + passage-level FTS; OR-query for questions** | `storage`, `contracts` | citations need offsets. Prefix-AND over every term rarely matches a question ([where we differ](../../notes/where-we-differ.md) rows 2–3) |
| O5 | **`text_hash` for judgments and learning caches** | `storage`, learning package | the content hash covers `submitted`/`points`, so a submission flip invalidates text judgments on unchanged text |
| O6 | **Extraction cached by file hash;** text layer first, OCR only for pages that come back empty | the new extraction module | never re-extract an unchanged file |
| O7 | **Job kinds + priority** (soonest assessment first), and precompute when idle | `storage` jobs, `core` drain | artifacts are ready before they're asked for; the answer path stays cache-first |
| O8 | **Stable-prefix sessions** for the AI CLI: course skeleton + policy + instructions first, the question last | the agent runtime | provider prompt caching bills cached reads at a fraction of input price (vendor docs), and Claude Code and Codex cache automatically |
| O9 | **One Jev request per state** (all the questions on the same state together), small candidate sets, code first | the Jev client | from [Jev usage](../../notes/jev-usage.md); fewer calls for the same judgments |
| O10 | **Coarse tools** (`notes.build_course_tree`, `artifacts.build`, `materials.search`) | the MCP server | the model never plans file-by-file or reads whole documents, so fewer tokens per task |
| O11 | **Canvas: honour throttling headers** (`X-Rate-Limit-Remaining`, 429 with `Retry-After`) and use a per-session queue | `connectors/canvas.ts` | the documented Canvas throttling; today there's no back-off ([pipeline details](../../pipeline-details.md)) |

## 3. Measure first
Each has its adopt and kill numbers fixed now.

| # | Change | Adopt if | Kill if |
|---|---|---|---|
| M1 | Canvas concurrency 2–4 within throttling | sync wall time drops ≥30% with zero 429s over 3 live runs | any 429 storm, or <30% |
| M2 | Incremental sync by `updated_at` watermarks per course or module (skip unchanged lists) | a zero-change re-sync makes ≤10% of the full-sync requests | no reliable watermark on the endpoints we use |
| M3 | FTS5 external-content table (no second copy of the body text) | DB size −25% or more, with query p95 unchanged (±10%) | slower queries or a complex rebuild |
| M4 | `mmap_size` / `cache_size` tuning | query p95 −20% at 5,000 resources | <20% |
| M5 | Embeddings + hybrid retrieval | ≥10-point recall@5 gain on ≥50 labelled questions (paired exact test) | fails, or packaging or licence problems |
| M6 | `typesafe/jev-router` for model choice on the OpenRouter route | equal or better answer quality at lower cost on our eval | doesn't |
| M7 | Overnight batch generation (vendor batch APIs, 50% off, ≤24 h) for OpenRouter-key users | the ledger shows ≥20% of tokens are precompute that can wait | <20% |

## 4. Ownership and order
- **We own this work from Ben's delivered version.** Changes to his packages are still visible to the team as PRs.
- **Order:**
  1. The baseline (§1).
  2. O1, O2, O3, O5: cheap, with the biggest effect on responsiveness.
  3. O4 + O6, which the notebook needs.
  4. O7–O11.
  5. The measure-first items, one at a time against the baseline.
- **Every optimization reports** the before and after on the same harness, per [benchmarking](../../notes/benchmarking.md) (paired, raw counts, and the rows we lose).
