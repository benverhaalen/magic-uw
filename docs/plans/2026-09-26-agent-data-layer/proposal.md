# Agent data layer: one query engine, two thin routes, measured

> **Superseded in part by the [course backend spec](../2026-09-26-course-backend/spec.md) (2026-09-26 late).**
> - **Still current:** the CLI-vs-MCP verdict and evidence (§2), storage and retrieval (§3.1–3.2), the token caps, the security rules (§3.4) and the measure-first items (§6).
> - **Changed:** app features never go through MCP or a CLI. They call the handlers in-process, and the model gets no tools (spec Parts E–F). The MCP server and `magic` CLI are an optional course bank for the student's own clients. The §5.2 access-surface benchmark now applies only to that course bank.

**Status: Proposal.** Written 2026-09-26 against the existing backend at `27782e9` (merged into `docs/research-proposals` at `5bf86f7`). Audience: the team and developers building on the open framework.
**Labels:** **decided** (ours, with the evidence given) · **measure-first** (adopt and kill numbers fixed below, before any run) · **researched** (a published source says it; who measured and when is in §2 and §8).
**Related:** [backend map](../../notes/backend-map.md) · [local database](../../notes/local-db.md) · [agent runtime](../../notes/agent-runtime.md) · [benchmarking](../../notes/benchmarking.md) · [backend optimization plan](../2026-09-26-backend-optimization/plan.md) · [measurement plan](../2026-09-26-measurement/plan.md).
Changes to the shared packages go to `main` as PRs, as in every plan here.

## 1. Decision summary

1. **Storage:** stay in the one `node:sqlite` workspace database. Add passages with offsets, passage-level FTS5 and code-built agent views; no new database and no agent-memory framework. **decided**
2. **Output format:** one compact format with hard token caps (search ≤800, get ≤600), shared by every route. This, not the transport, is where most of the savings are. **decided**
3. **Routes:** one handler layer reached two thin ways: a slimmed MCP server (five tools) and a `magic` CLI with an Agent Skills bundle. **decided**
4. **Defaults:** app-driven sessions keep MCP and no shell. A client's default moves to the CLI only if our benchmark shows ≥25% fewer tokens at equal success, and the team signs off on the shell. **decided rule, measure-first outcome**
5. **Access:** agents never open the database. A read-only reader process serves both routes over a local socket; the worker stays the only writer. **decided**
6. **Retrieval upgrades:** vectors, reranking and context headers ship only if they beat BM25 passages on our gold set by margins fixed in §6. **measure-first**
7. **Repo:** new `packages/retrieval`, `packages/agent-api`, `apps/cli` and a skills bundle; `packages/embeddings` only if vectors pass; storage v4 goes to `main` as a PR. **decided; open-source boundary open**
8. **"CLIs beat MCP":** not supported in general. It holds when an MCP server loads a large tool catalog or returns large outputs; our benchmark (§5.2) tests it on our own workload. **researched**

## 2. The question and the claim: "CLIs are more efficient than MCP"

**Verdict: true under conditions, not in general.**
- **Where the claim holds.** The large gaps people report (4–32× more tokens) come from large tool catalogs loaded up front and from very large tool outputs. Both are properties of a particular server, not of MCP as a transport.
- **Where it doesn't.** When the tool surface and the outputs are both kept small, the two independent head-to-head measurements found no token difference, and MCP was faster in both.
- **What a CLI really adds:** the agent can filter results before they enter its context, skills load in stages, and one interface works across Claude Code, Codex and Gemini CLI.
- **What MCP really adds:** it needs no shell, it has typed contracts, it works in clients with no shell, and it avoids the per-command shell safety check that one independent test found expensive.
- **What that means for us:** the current server has six tools with one shared schema, so the catalog cost is small. Its real cost is output size: `search` can return up to 20 items with windows of up to 8,000 characters each, refused only above 200,000 characters (about 40k tokens worst case; [backend map](../../notes/backend-map.md)). That cost is the same whichever route carries it, so we fix the output first and let a paired benchmark decide the route.

### Evidence

| # | Claim | Value | Who measured (interest) | Date | Label |
|---|---|---|---|---|---|
| E1 | MCP costs more tokens than a CLI on GitHub tasks | 4–32× more; simple task 1,365 (CLI) vs 44,026 (MCP); GitHub's 43-tool server. MCP 18/25 runs succeeded vs 25/25, all failures remote TCP timeouts | Scalekit (sells an MCP gateway) | 2026-03-11 | sourced, vendor |
| E2 | Token difference between plain CLI and MCP is negligible | d = 0.036, p = 0.955; MCP cut wall time by 44% | ghx evaluation (independent developer who promotes his own router) | fetched 2026-09-26 | sourced |
| E3 | CLI vs MCP is "truly a wash" | MCP 23% faster, 2.5% cheaper; the CLI arm repeatedly triggered Claude Code's shell safety scanner, costing extra model calls | Mario Zechner (independent; documented harness, 10 runs per combination) | 2025-08-15 | sourced |
| E4 | Keeping intermediate data out of context saves most tokens | 150,000 → 2,000 tokens (98.7%) with code execution over MCP | Anthropic (vendor; one illustrative workflow, no task set) | 2025-11-04 | sourced, vendor |
| E5 | Independent re-check of E4 | 94.4% reduction (9,759 → 550 tokens) | faalantir (independent; tokenizer simulation, not a live agent) | 2025-11-15 | sourced, simulated |
| E6 | Agents call tools better through generated code | qualitative, no number | Cloudflare "Code Mode" (vendor) | 2025-09-26 | sourced, qualitative |
| E7 | Claude Code defers MCP tools by default | only tool names and server instructions load at start; `ENABLE_TOOL_SEARCH=auto` loads up front while definitions stay under 10% of the context window | Anthropic docs | fetched 2026-09-26 | sourced, vendor |
| E8 | Claude Code limits MCP output | default maximum 25,000 tokens, warning above 10,000 | Anthropic docs | fetched 2026-09-26 | sourced, vendor |
| E9 | Skills load in stages | name and description preload; the body loads only when used; bundled files only when read | Anthropic engineering post and docs | 2025-10-16 | sourced, vendor |
| E10 | Coding agents favour CLI plus skills | "CLI invocations are more token-efficient"; no numbers | Microsoft playwright-mcp README (vendor) | fetched 2026-09-26 | sourced, qualitative |
| E11 | Large outputs dominate | one Playwright MCP page snapshot averaged 13,800 tokens vs ~1,400 for a screenshot; 9 calls used 62% of a 200k window | independent blogger (own logging proxy) | 2026-09-20 | sourced, single case |
| E12 | A contrary report | CLI 328.4k vs MCP 45.0k tokens on the same demo task | one commenter on a practitioner post (single run) | 2026-01-27 | sourced, anecdotal |
| E13 | Tool-selection accuracy falls as tools grow | top-1 hit rate ~98% → ~88% from 10 to 100 tools | HumanMCP (preprint, not yet widely cited) | 2026 | sourced, preprint |
| E14 | A top-5 candidate list beats top-1 | 78.95% vs 64.21% success (McNemar p = 0.02); top-10 no better than top-5 | LiveMCPBench (preprint) | 2025-08 | sourced, preprint |
| E15 | "~114k (MCP) vs ~27k (CLI)" tokens for Playwright | widely repeated | no primary source found; every instance cites another blog | 2026 | **not used** |
| E16 | Our current `search` worst case | up to ~160,000 characters ≈ 40k tokens | our reading of the code at `5bf86f7`; characters ÷ 4 | 2026-09-26 | inferred |
| E17 | A CLI call pays process start and database open on every call; the MCP server is long-lived | not measured | our reasoning | 2026-09-26 | inferred |

**Gaps in the evidence.** No head-to-head on a server with ≤10 tools. None with Claude Code's tool search on. No numbers for Codex or Gemini CLI. No skill-vs-MCP numbers. No peer-reviewed result among the MCP benchmarks (E13, E14 and MCP-Bench are preprints). That is why §5.2 exists.

## 3. Target architecture

### 3.1 Storage

**Keep `node:sqlite` in the one workspace database. decided**
- **Why:** one file keeps one purge, one health model and one migration path. FTS5 and `bm25()` already work ([local database](../../notes/local-db.md)). Data kept in a second store would survive "Delete local data".
- **Alternatives rejected (researched, licences and releases checked on 2026-09-26):**
  - **LanceDB** (Apache-2.0, v0.39.0; built-in BM25, vectors and fusion) is the strongest, but it is still a second store to purge and keep healthy.
  - **DuckDB** keeps full-text and vector search in separate extensions. **Orama** (Apache-2.0, pure JS) is in-memory and would duplicate the corpus.
  - **Chroma** is not in-process from Node. **Milvus Lite** is Python-only. **Tantivy** has no maintained Node binding.
  - **Kuzu** is archived. **FalkorDB** is SSPL. **Meilisearch** is a server with some parts under BSL 1.1.
- **Agent-memory frameworks (Letta, mem0, Zep/Graphiti, Cognee): not adopted. decided**
  - They target conversation memory, not retrieval over course documents.
  - Their benchmarks are self-reported and disputed in public: mem0 reports 93.4 on LongMemEval against an independent reproduction's 73.8; Zep and mem0 dispute each other's LoCoMo numbers; Cognee has no published score.

**Schema v4** (in `packages/storage`; a PR to `main`, because v3 is the existing schema):

| Object | Shape | Label and evidence |
|---|---|---|
| `passages` | `pid, resource_id, version, text_hash, ord, start, end, page?, slide?, section?, heading?, tok_est, redacted` | decided. Citations need literal spans (backend plan O4). Offsets come from the `"\n\n"` join of `parts` until extraction fills `start`/`end`; code checks every offset against the resource text |
| Passage size | split at part boundaries, target ~1,000 characters (~250 tokens), never across a page or slide | measure-first (MF1). No source in the research |
| `passage_fts` | FTS5 external-content over `passages`, columns `ctx, body` | measure-first (MF2 = backend M3) |
| `ctx` column | a header written by code: course · resource title · page or slide · heading. Used for search and embedding input only, never returned | measure-first (MF3). Anthropic's Contextual Retrieval reports 49% fewer failed retrievals (67% with reranking) using LLM-written context on its own data (vendor). Ours is deterministic and costs no tokens, so it must earn its place on our data |
| `passage_vec` | int8, 384 dimensions, keyed by `pid` | measure-first (MF4, MF5). Try a plain BLOB column scanned in the reader first (50k × 384 bytes ≈ 19 MB, inferred); sqlite-vec (Apache-2.0, v0.1.9) only if that misses the latency budget. Cohere reports int8 keeps ~99% of search quality at 4× less memory (vendor) |
| Embedding model | `snowflake-arctic-embed-xs` (22M parameters, 384 dims, retrieval 50.15, Apache-2.0); challenger `bge-small-en-v1.5` (retrieval 51.68, 384 dims, Apache-2.0) | measure-first (MF6). Vendor MTEB figures; no CPU latency figure exists for either. EmbeddingGemma is excluded from the open default by its Gemma licence terms; `potion-base-8M` is rejected (retrieval 31.11 vs MiniLM's 42.92) |
| `agent_views` | `kind (course_brief, assessment_brief), key, input_hash, body_json, tok_est, built_at` | decided when built by code from resources, evidence links, course inclusion and deadlines (no model call). Rebuilt when the change feed touches their inputs. LLM-written summaries are measure-first (MF10) |
| Change feed | a monotonic `seq INTEGER` on `resource_changes`; `magic changes --after <seq>` | decided. `store.changes` exists; a cursor avoids clock skew between processes (inferred) |
| Settings | statement cache (O2), `synchronous=NORMAL` (O3), `mmap_size`/`cache_size` (M4) | decided (O2, O3); measure-first (M4 = MF9) |

**Hard rule. decided** Every new table is keyed to `resources`, so purge cascades to it; any embedding cache is deleted with the rest of the workspace data.

### 3.2 Retrieval pipeline, with budgets

It runs in one app-owned **reader** process (§3.4). Latency budgets are p95 at ~5,000 resources and ~50k passages on a mid-range Windows laptop and an Apple-silicon desktop (specs recorded in each run report).

| Stage | What | p95 budget | Label |
|---|---|---|---|
| 0. Route | an ID goes to a direct fetch; due-date, deadline or course-overview words go to `agent_views` with no search; everything else to stage 1 | ≤1 ms | decided (no published number for routing) |
| 1. Permission set | grant × course inclusion × `maySend` × the course policy gate → the allowed resource IDs, joined **before** ranking so counts leak nothing | ≤5 ms | decided |
| 2. Lexical | `passage_fts` BM25: OR of content words for questions, prefix-AND for exact lookups; top 50 | ≤15 ms | decided (O4) |
| 3. Vector | embed the query, nearest neighbours, top 50 | embed ≤30 ms, search ≤25 ms | measure-first (MF4–MF6). sqlite-vec's author reports <75 ms at 100k vectors (author-run) |
| 4. Fuse | convex combination of normalised scores, α tuned on a held-out part of the gold set; reciprocal rank fusion until labels exist | ≤1 ms | decided. A peer-reviewed ACM TOIS 2023 study finds convex combination beats RRF in and out of domain and needs little data to tune |
| 5. Rerank | `ms-marco-MiniLM-L-6-v2` cross-encoder (Apache-2.0) over the top 20–30 | ≤150 ms added | measure-first (MF7). 74.30 NDCG@10 on TREC DL19 (vendor); its throughput figure is GPU-only. `answerai-colbert-small` is deferred: no published JS scoring path |
| 6. Not found | a score threshold; optionally one Jev judgment "which of these ≤5 passages answers this, or none", only when the grant allows Jev | off the hot path | measure-first (MF12) |
| 7. Shape | IDs, location, offsets, excerpt ≤240 characters; full text only on `get` | ≤2 ms | decided |

**Whole call:** lexical ≤50 ms, hybrid ≤120 ms at the service; CLI wall time ≤300 ms including process start; warm MCP call ≤100 ms. A result cache keyed by (grant, normalised query, `PRAGMA data_version`) drops entries when another connection writes (to confirm on the Electron runtime).

**One output format for every route. decided**
```
search <q> [--k 8]        -> {"q":..,"n":8,"more":true,"hits":[{"pid","rid","c","t","loc","s","e","sc","x"}]}
get <pid> [--around N] [--max-chars 2000]
                          -> {"pid","rid","loc","s","e","text","prev","next","cite":{"ver","observedAt","src"}}
brief course|assessment <id>   -> the precomputed agent_views body
due [--days 14] · changes --after <seq> · batch (several operations in one round trip)
```
`c` course, `t` title, `loc` page or slide, `s`/`e` offsets, `sc` score, `x` excerpt.

**Token caps, enforced in code** (truncate and set `more:true`). The estimate is characters ÷ 4 at run time, checked against provider-reported usage in §5; if it undercounts by more than 10%, the divisor is tightened.

| Call | Cap (tokens) |
|---|---|
| `search` (k = 8) | ≤800 |
| `get` (default) | ≤600 |
| course brief | ≤600 |
| assessment brief | ≤800 |
| `due` | ≤400 |
| `changes` (20 rows) | ≤600 |

A typical grounded question (one search, two gets) should cost about 2,000 tokens of tool output, against a current worst case near 40k for one search (E16). All caps sit far below Claude Code's 10k warning (E8). `batch` applies the idea behind E4 without a sandbox: several operations, filtered at the source, one round trip (MF11).

### 3.3 Access layers per client

| Layer | Serves | Why | Label |
|---|---|---|---|
| **MCP server, slimmed:** `search, get, brief, due, changes` (plus `answer_course_question` kept for compatibility), one schema per tool, one-line descriptions, the output format above | **app-driven headless sessions** (all clients) and **clients with no shell** (desktop chat apps, editor hosts) | needs no shell, which the [agent runtime](../../notes/agent-runtime.md) requires; typed contracts; deferred by tool search (E7); independent tests found no token penalty at small size (E2, E3) | decided |
| **`magic` CLI** (compact JSON, `--fields`, `--max-chars`, `batch`; `magic --help` ≤40 lines, detail per verb) **plus one Agent Skills bundle** (`SKILL.md` ≤150 lines; `reference.md`, `examples.md` read only when needed) | **developers and scripts** on the framework; offered to the student's **own interactive** Claude Code, Codex or Gemini CLI sessions alongside MCP | filtering built into the CLI means no `jq` or pipes need allowing; skills load in stages (E9); Agent Skills became an open standard on 2025-12-18 | decided to ship. Default for interactive agents is measure-first (§5.2). Whether Codex and Gemini CLI read `SKILL.md` natively is to confirm; the fallback is an AGENTS.md or GEMINI.md snippet generated from the same source |
| **Read-only SQL views** (`agent_passages`, `agent_items`, `agent_deadlines`, `agent_changes`, grant-filtered) | framework developers in-process, analytics and evals | most flexible, but the easiest way to pull huge outputs and the hardest to gate; no evidence agents do better with raw SQL | decided for developers; **off for agents** |

**Rule for app-driven sessions, fixed now. decided** They use the thin MCP server and get no shell. A client moves to the CLI only if all three hold: it wins §5.2 for that client; the allowlist probes in R7 pass; and the team agrees, because it changes the "no shell" line in the agent runtime.

### 3.4 Security

Findings about the current build are reported privately to the team and are not discussed here. The target design:

| Rule | Mechanism | Label |
|---|---|---|
| One writer | only the worker writes. The reader sends receipts to the worker as messages through main. This settles the MCP-to-worker bridge question (N26 in the [backend map](../../notes/backend-map.md)) in favour of the bridge; a PR to `main` | decided |
| Read-only agent access | a new reader utility process opens the database read-only (`DatabaseSync` `readOnly`, else `PRAGMA query_only=ON`; to confirm). Stages 0–7 run there. Developer SQL accepts one `SELECT` against `agent_*` views; anything else is rejected | decided |
| Agents never open the file | CLI and MCP are thin clients on a named pipe (Windows) or Unix socket (macOS, Linux). The connection file holds `{endpoint, clientId, token}` and no database path, mode 0600; each export rotates the token. If the app isn't running, `magic` exits non-zero with "open Magic Canvas" | decided |
| Grants rechecked every call | token-hash timing-safe match, course inclusion, `maySend`, and the course policy gate (N04), all before ranking. Revocation takes effect on the next call | decided |
| Secrets never returned | a scan while passages are built for known token formats (`glpat-`, `AKIA…`, PEM blocks, `token=`/`key=` query strings) sets `redacted=1` and keeps that text out of FTS, vectors and output | decided; false-positive rate measure-first (MF13) |
| Egress receipts | one per call, listing passage IDs and returned token estimates | decided |
| Threat-model limit | an agent with a general shell runs as the student and can read what the student can; file modes don't stop the same user. Protection is: no path handed out, skills direct agents to `magic`, app-driven sessions get no general shell. Encryption at rest stays not proposed ([local database](../../notes/local-db.md)) | **open decision:** whether this threat model is enough |

### 3.5 Where the two design reviews disagreed, and what we adopt

This proposal merges an architecture draft and a skeptical review of it.

| Question | Architecture draft | Skeptical review | Adopted, and why |
|---|---|---|---|
| Default for the student's own interactive sessions | CLI plus skill | MCP | **Ship both, recommend MCP until §5.2 says otherwise per client.** The evidence is a wash (E2, E3) and MCP is built, tested and works in every client. An interactive session already has a shell, so the CLI adds no new exposure there; the choice is only efficiency, which the benchmark settles |
| Developers and scripts | CLI | not addressed | **CLI.** No agent context to protect, and scripts need exit codes and pipes |
| Benchmark arms | current MCP, thin MCP, CLI plus skill | a 2×2 (transport × output) plus a skill arm and an `alwaysLoad` arm | **The 2×2 design.** The three-arm design mixes output size with transport, so a CLI win could not be attributed |
| Tasks and threshold | 30 tasks; CLI ≤80% of thin-MCP tokens | 16 tasks; ≥25% fewer tokens, sign test 13/16 | **24 tasks, ≥25% fewer tokens, sign test ≥17/24 (one-sided p = 0.032).** The independent evidence says "no difference", so a claimed win needs a clear margin; 24 tasks gives the sign test room at an affordable run count |
| Tool-search deferral | relies on it | may add a round trip at 6 tools | **Measure it** with an `alwaysLoad` arm (MF14) |
| App-driven shell | allowed, limited to `magic`, after a benchmark win | a shell weakens the grant model; allowlists can be bypassed | **Both conditions:** a benchmark win **and** zero bypasses in R7, then a team decision |
| Search defaults | k = 8, ≤240-char excerpts | top-5, ~300-character snippets | **k = 8, ≤240 characters,** within the 800-token cap; k = 5 swept in R1. The gold-set metric is recall@5, and three extra hits cost ~200 tokens |
| Vector storage | BLOB brute force first | not addressed ([local database](../../notes/local-db.md) proposed sqlite-vec) | **BLOB first**; sqlite-vec only if the hybrid budget is missed. It avoids the native extension the `node:sqlite` choice was made to avoid |

## 4. Repo structure

| Piece | Location | Owner |
|---|---|---|
| v4 tables, purge coverage, O2/O3 | `packages/storage` | PR to `main` |
| Passage splitter, offset check, context header, secret scan, query parser, fusion, output format, token caps | **`packages/retrieval`** (new; pure; depends only on the `Store` interface) | ours |
| Embedding loader, int8 quantisation, vector scan or sqlite-vec adapter | **`packages/embeddings`** (new; only if MF4 passes) | ours |
| Request/response zod schemas and the shared handlers, moved out of `core/mcp.ts` so CLI and MCP call the same code; grant check; receipt messages | **`packages/agent-api`** (new) | ours + PR to `main` |
| Reader process and socket server | `apps/desktop/src/reader.ts` (new), launched by `main.ts` | PR |
| MCP server as a socket client | `apps/desktop/src/mcp-server.ts` | PR to `main` |
| `magic` binary | **`apps/cli`** (new); Electron-as-Node or a Node single-executable build, chosen on R4 start-up time | ours |
| Skills bundle | `skills/magic-canvas/{SKILL.md,reference.md,examples.md}` plus generated AGENTS.md and GEMINI.md snippets | ours |
| Evals | `evals/perf/retrieval.ts`, `evals/retrieval/`, `evals/agent-surface/` (under MS7/MT6 of the [measurement plan](../2026-09-26-measurement/plan.md)) | ours |

**Open-source framework vs desktop app. Proposal; the call is the team's.** The repo is MIT today. Any change to licensing or distribution is a deliberate team decision ([business model](../../notes/business-model.md)).
- **Framework (open):** `contracts` (ingestion subset), `storage`, `retrieval`, `embeddings`, `agent-api`, `apps/cli`, the MCP adapter, the skills bundle, `connectors` (Canvas, ICS, GitLab, external sites, documents), `evals/perf` and the retrieval evals.
- **Desktop app:** the Electron UI, licence activation, the Jev gateway client and hosted gateway, onboarding and orchestration of the student's AI tool, learning features (practice, notes, spaced repetition).
- **Boundary test (R8):** framework packages build and test with zero imports from `apps/desktop`, `apps/gateway` or licence code, and a sample ICS-only connector plugs in with ≤1 new file.

## 5. Benchmark on our own data

All runs follow [benchmarking](../../notes/benchmarking.md): the gold set is frozen and hashed before tuning and written by someone who doesn't build the pipeline; comparisons are paired per question or task; reports carry raw counts, the git SHA, machine and model versions, and the rows we lose. **Corpus:** the MIT OCW 6.006 import (used locally, never committed) plus a synthetic Canvas, calendar and GitLab fixture with planted deadlines, changes, fake credentials and injection canaries. **Gold:** ≥50 answerable questions with gold passages plus ≥8 unanswerable (MS2).

### 5.1 Retrieval and budget tests

| # | Test | Pass | Fail |
|---|---|---|---|
| R1 | Passage BM25 vs today's `search` | recall@5 no more than 2 points lower (paired exact test) **and** returned tokens per call ≤25% of today's | either misses |
| R2 | Token caps | 100% of 500 generated calls within the §3.2 caps | any call over |
| R3 | Estimator accuracy | characters ÷ 4 within 10% of provider-reported usage on §5.2 runs | tighten the divisor |
| R4 | Latency at ~5,000 resources / ~50k passages, both machines | the §3.2 budgets; `get` ≤10 ms; `brief` ≤5 ms; CLI wall ≤300 ms including start | any budget missed on either machine |
| R5 | Freshness | after ingest, passages, FTS and views current before the next call returns (≤2 s); vectors ≤60 s, marked `stale:true` until then | exceeded |
| R6 | Size | passages plus external-content FTS ≤1.6× today's database; int8 vectors ≤400 bytes per passage | exceeded |
| R7 | Security negatives | connection files and spawned process arguments/environment contain no database path; writes and non-view SQL rejected on every endpoint; a revoked grant refused on the next call; 0 of 20 seeded credentials in any output; after purge, passage, vector and view rows = 0; text only in an excluded course gives 0 hits, and `n`/`more` match a no-match query; if a CLI arm runs with a shell allowlist, 0 non-allowlisted executions across compound-command and substitution probes | any case fails |
| R8 | Framework boundary | see §4 | any import, or >1 file |

### 5.2 Access-surface benchmark: tests the CLI claim

**Arms.** Every arm calls the same `packages/agent-api` handlers, so ranking, grants and receipts are identical; all arms use the new FTS ranking; a test asserts the CLI's stdout is byte-identical to the MCP text for the same arguments. The clock and timezone are frozen.

| Arm | Transport | Output | Setup |
|---|---|---|---|
| A0 | MCP | today's shape (8,000-character windows, 20 items) | shell disallowed |
| A1 | MCP | compact (§3.2) | only our server loaded, shell disallowed |
| A1-L | MCP | compact, `alwaysLoad` | as A1; isolates tool-search deferral |
| B | CLI (`magic … --json`) | same bytes as A1 | no MCP; shell allowlisted to `magic` only |
| C | skill wrapping B | same as B | `SKILL.md` in a working directory the app owns |

A0 → A1 is the output effect. **A1 → B is the transport effect: the claim under test.** B → C is the skill's effect. A0 → B is reported but not attributed.

**Clients.** Claude Code (`claude -p --output-format json`) and Codex (`codex exec --json`), model and effort pinned per client; Gemini CLI optional. Clients are analysed separately, never pooled. Arm C runs on a client only if a probe shows it loads skills in our isolated setup; otherwise it is marked N/A. Exact permission and flag syntax is confirmed by probe before code is written.

**Tasks (24), frozen and hashed before tuning:**
- Deadlines (4): due this week; next exam date and weight; assignments with no due date; deadlines that fall in the same week.
- Locate and cite (6): the slide defining a term, with page and span; where the syllabus states the late policy; the lab's submission format; which lecture first introduces a topic; two more of the same form.
- Changes (3): summarise changes since a date; did any due date move; what was removed.
- Overview (3): course overview with coverage gaps; list one module's materials; what an exam covers.
- Synthesis (4): a 5-question quiz on one module; a one-page study guide; compare two lectures on one topic; explain a worked example with citations.
- Unanswerable (4): the answer isn't in the corpus; the correct result is "not found".

**Metrics.** Tokens from each client's JSON usage fields (field names confirmed by probe): uncached input, cache creation, cache read and output, reported separately; the primary metric is total input processed. Fixed overhead measured once per arm with an empty "reply OK" task. Tool calls from stream events, including any extra model calls such as shell safety checks. Wall time from spawn to exit. Success checked by code for IDs, dates and literal quote spans; quizzes and guides judged against the key by a different model family, blind to the arm. Three runs per task per arm; the unit of analysis is the per-task median. About 720 sessions for two clients.

**Decision rules, fixed now, per client:**
- **"The CLI is more efficient" holds only if all hold:** B's median paired input tokens are ≥25% below A1's; B is lower on ≥17 of 24 tasks (one-sided sign test, p = 0.032); B's success is no more than 1 task below A1 and an exact McNemar test shows no significant loss; B's median wall time is no more than 20% above A1's. **Otherwise the result is "no difference"** and MCP stays the default.
- **Compact output (A1 over A0)** is kept if median input tokens drop ≥30% and are lower on ≥17 of 24 tasks, with success no more than 1 task lower. If success drops more, the caps are raised and re-run.
- **The skill (C)** is adopted if its success is ≥ B's and its tokens ≤ B's + 10%; otherwise dropped.
- **A run is invalid if** any non-allowlisted command runs, any file outside the tool is read, or any tool call lacks a receipt. **0 canary executions** in every arm and run.
- **What 24 tasks can't show:** differences much under ~25%. Smaller ones don't change the decision.

## 6. Measure-first items

Each is tested against the §5 harness, one at a time, against the baseline.

| # | Item | Adopt if | Kill if |
|---|---|---|---|
| MF1 | Passage size 600 / 1,000 / 1,600 characters | another size beats 1,000 by ≥3 points recall@5 at ≤ the same returned tokens | otherwise keep 1,000 |
| MF2 | External-content FTS (backend M3) | database −25% or more, query p95 within ±10% | slower queries or a complex rebuild |
| MF3 | Context header `ctx` | recall@5 ≥ +3 points over body-only | <3 points |
| MF4 | Hybrid retrieval (backend M5) | recall@5 ≥ +10 points over passage BM25 on ≥50 questions (paired exact test) | fails, or packaging or licence problems |
| MF5 | sqlite-vec instead of BLOB scan | BLOB scan misses the 25 ms search budget at 50k passages | BLOB scan meets it |
| MF6 | `bge-small-en-v1.5` over `arctic-embed-xs` | ≥2 points recall@5 better with query embedding p95 ≤30 ms | otherwise keep `arctic-embed-xs` |
| MF7 | Cross-encoder rerank | recall@5 ≥ +5 points over the fused list, added p95 ≤150 ms | either misses |
| MF8 | Convex fusion vs RRF, once labels exist | convex ≥ RRF on the held-out split | RRF wins; keep RRF |
| MF9 | `mmap_size` / `cache_size` (backend M4) | query p95 −20% at 5,000 resources | <20% |
| MF10 | LLM-written summaries in `agent_views` | success on overview and synthesis tasks rises by ≥2 of 7, tokens per task not higher | otherwise code-built views only |
| MF11 | `batch` | ≥20% fewer input tokens on multi-step tasks at equal success | <20% |
| MF12 | Jev not-found judgment | correct "not found" rises by ≥2 of the unanswerable questions, ≤1 answerable question lost | otherwise the score threshold alone |
| MF13 | Secret-scan false positives | 0 seeded credentials returned and ≤1% of OCW gold passages wrongly redacted | either misses; tune patterns |
| MF14 | `alwaysLoad` for our server | A1-L lower total input than A1 on ≥17 of 24 tasks | otherwise keep deferral |
| MF15 | Agent access to SQL views | only if a later benchmark shows a task class the tools can't serve | not scheduled |

## 7. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Shell access in a CLI arm | a shell can read what the student can read, reach the network, and bypass grants and receipts | app-driven sessions keep no shell unless §5.2 **and** R7 pass and the team agrees; the CLI never opens the database |
| Allowlist bypass | compound commands or substitution run something other than `magic` | R7 probes; any bypass invalidates the CLI route for that client |
| Foreign skills | a student repository's own skills load if the agent runs inside it | app-driven sessions run in a working directory the app owns |
| The skill doesn't load | shows up as failed tasks, not fewer tokens | success is a primary metric in §5.2 |
| Prompt injection in course text | classmates can write GitLab READMEs and forum posts | read-only tools, no network tools, ≤240-character excerpts by default, canaries in every run |
| Truncation hides the answer | caps cut the passage that mattered | `more:true` and `get --around`; R1 and the compact-output rule catch a success loss |
| CLI start-up cost | a process start and socket connect per call | R4 budget; single-executable build if Electron-as-Node is too slow |
| Vendor-sourced model scores | MTEB and BEIR numbers are self-reported | every model choice is decided on our gold set (MF4–MF7) |
| Tool behaviour drifts | tool search, output limits and skill loading change between client versions | client versions recorded per run; §5.2 re-run on major updates |
| Schema v4 depends on the current code | the extractor and handler layout may change | the baseline in the backend plan is re-run when the final version lands; this plan updates from the diff |
| Small benchmark | 24 tasks detect only large differences | stated in every report; no claim beyond what the test can show |

## 8. Sources

All fetched or checked 2026-09-26 unless a date is given.

**CLI vs MCP**
- Scalekit, "MCP vs CLI", 2026-03-11: https://www.scalekit.com/blog/mcp-vs-cli-use; code https://github.com/scalekit-inc/mcp-vs-cli-benchmark
- ghx evaluation report: https://github.com/aryeko/ghx/blob/main/docs/eval-report.md
- Mario Zechner, "MCP vs CLI", 2025-08-15: https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/
- Anthropic, "Code execution with MCP", 2025-11-04: https://www.anthropic.com/engineering/code-execution-with-mcp
- faalantir, mcp-token-analysis, 2025-11-15 (read via a mirror; canonical repository not re-fetched): https://github.com/faalantir/mcp-token-analysis
- Cloudflare, "Code Mode", 2025-09-26: https://blog.cloudflare.com/code-mode/
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp.md
- Claude Code skills docs: https://code.claude.com/docs/en/skills.md
- Anthropic, "Equipping agents for the real world with Agent Skills", 2025-10-16: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Anthropic, "Agent Skills", 2025-10-16 (open-standard note dated 2025-12-18): https://www.anthropic.com/news/skills
- Microsoft playwright-mcp README: https://github.com/microsoft/playwright-mcp
- Playwright MCP token usage case study, 2026-09-20: https://dev.to/ji_ai/playwright-mcp-token-usage-9-tool-calls-62-of-my-context-4on2
- Practitioner post with the contrary report, 2026-01-27: https://www.linkedin.com/pulse/playwright-cli-first-impressions-key-takeaways-andrew-goldis-4v5ec
- HumanMCP (preprint): https://arxiv.org/abs/2602.23367
- LiveMCPBench (preprint): https://arxiv.org/abs/2508.01780
- MCP-Bench (preprint): https://arxiv.org/abs/2508.20453

**Storage and agent memory**
- Licences and latest releases read from each project's GitHub repository: sqlite-vec, libSQL, DuckDB (with duckdb-fts and duckdb-vss), LanceDB, Chroma, Milvus Lite, Tantivy, Orama, Meilisearch, Kuzu, FalkorDB, Letta, mem0, Graphiti, Cognee.
- Zep and mem0 LoCoMo dispute: https://github.com/getzep/zep-papers/issues/5
- Independent reproduction of memory benchmarks (search excerpt only): https://www.maximem.ai/blog/state-of-ai-memory-2026-claimed-vs-observed

**Retrieval**
- snowflake-arctic-embed-xs: https://huggingface.co/Snowflake/snowflake-arctic-embed-xs
- bge-small-en-v1.5: https://huggingface.co/BAAI/bge-small-en-v1.5
- potion-base-8M: https://huggingface.co/minishlab/potion-base-8M
- EmbeddingGemma announcement, 2025-09-04: https://developers.googleblog.com/en/introducing-embeddinggemma/
- ms-marco-MiniLM-L-6-v2: https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2
- answerai-colbert-small-v1: https://huggingface.co/answerdotai/answerai-colbert-small-v1
- "An Analysis of Fusion Functions for Hybrid Retrieval", ACM TOIS, 2023 (OpenAlex W4377138005)
- Cormack et al., "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods", 2009 (OpenAlex W2148972377)
- Weaviate, hybrid search fusion algorithms: https://weaviate.io/blog/hybrid-search-fusion-algorithms
- Anthropic, "Contextual Retrieval", 2024-09-19: https://www.anthropic.com/news/contextual-retrieval
- Cohere, "int8 and binary embeddings", 2024-03-18: https://cohere.com/blog/int8-binary-embeddings
