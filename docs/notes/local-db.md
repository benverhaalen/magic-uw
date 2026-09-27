# Local database: what is built, what the research supports, what to add

**Status:** the first section describes built code at `73ff7a6`. The rest is **Proposal.** Checked 2026-09-26.

## Built today
- **Engine:** Node's built-in `node:sqlite` **`DatabaseSync`** (synchronous), opened only inside the Electron **utility-process worker**. The renderer never touches it; commands reach it through preload → main → worker. The main process stays free, as Electron's performance guide requires ("Under no circumstances should you block this process").
- **Settings:** WAL, `secure_delete`, and file mode 0600 where the OS supports it. Migrations are tracked by `PRAGMA user_version` (currently v2), and newer databases are refused.
- **Data model:** `resource_versions` (content hash = SHA-256 of the whole resource input), deletion markers, source health, links with user decisions, a judgment cache keyed by input hash, attempts, egress receipts (metadata only), a job queue with leases and retries, and preferences.
- **Search:** FTS5 table `resource_search(title, course_name, body)`, queried as **prefix-AND over every term**, `ORDER BY rank` (BM25). It returns whole resources.
- **Purge:** deletes sources (cascading to every resource-keyed table), receipts and preferences, then runs `VACUUM`.

## Facts checked
- **`node:sqlite` is "Stability 1.2 – Release candidate" from Node 24.15.0** (nodejs.org, v24 docs). Electron 44.4.5 bundles Node 24.21.0. Node 24.14 still printed "experimental" in our test, so test against the Electron runtime.
- **FTS5 and `bm25()` work** in `node:sqlite`, verified with a local run.
- `loadExtension()` exists (since v22.13 / v23.5), but it requires `allowExtension: true` when constructing the `DatabaseSync`.
- **The API is synchronous only,** so long queries belong in the worker, which is where the store already lives.

## Proposals, in order
1. **Feature tables (migration v3).**
   - `items`: question, options, key, explanation, provenance (resource, version or hash, offsets, quote), and check labels with the method that passed.
   - `responses`: chosen option or typed text, item version, outcome, and flag or dispute state.
   - `reviews`: the review queue and FSRS state, if flashcards adopt ts-fsrs.
   - All keyed to resources, **so purge covers them.** Disputed outcomes are excluded from adaptation.
2. **Passages with offsets.** A `passages(resource_id, version, start, end, heading)` table plus a passage-level FTS table, rebuilt when a resource version changes. Citations become literal spans that code checks, and retrieval returns passages. This comes after extraction preserves page and slide boundaries (`parts`); see [where we differ](where-we-differ.md) rows 1–3.
3. **Query form for questions.** Keep prefix-AND for exact lookups. For natural-language questions, OR-join the content words and let BM25 rank them, **measured against the gold set before switching** ([benchmarking](benchmarking.md)).
4. **Per-resource validation at import** (see where-we-differ row 10).
5. **Job queue:** kind-filtered leasing, local jobs that don't depend on Jev, and a priority column (soonest assessment first).
6. **Embeddings (only if they're measured to be better).** Keep vectors in the same SQLite file with `sqlite-vec`, rather than running a separate vector service. Its author measures under 75 ms per query at 100k vectors of ≤1024 dimensions (disk-backed, author-run; alexgarcia.xyz, sqlite-vec stable release post; v0.1.0, 2024-08-01, corrected 2026-09-26).
   - **Costs:**
     - a native loadable extension, which the current choice of `node:sqlite` was made to avoid
     - model weights with their own licence (EmbeddingGemma uses Gemma terms)
     - a background embedding job
   - **Adopt only if** hybrid retrieval raises passage recall@5 by ≥10 points over BM25 passages on ≥50 labelled questions (paired exact test).
   - Vendor figures for hybrid and rerank retrieval (Anthropic "Contextual Retrieval": 35% / 49% / 67% fewer failed retrievals, measured on its own data with LLM-written chunk context) motivate the test; they don't replace it.

## Deliberately not proposed
- **An ORM** (e.g. Drizzle). The store's SQL is small, explicit and migration-tested. An ORM adds a dependency without solving a measured problem.
- **A separate vector database or search server.** It duplicates storage, health and purge semantics, and course-scale data fits in SQLite.
- **Encrypting the database in the app.** It's not proposed here. The [implementation status](../implementation-status.md) already states that OS and device security apply. Revisit if the threat model changes.

## Side effects to respect
- **A resource's content hash covers its whole input.** Populating a new field bumps every version and invalidates its judgments, which is correct but costly the first time. Batch such changes.
- **`resourceInputSchema` is strict.** An older build rejects captures that carry new fields, so the contract has to land before connectors send them.
- **Feature data kept in another file would survive a purge,** so keep it in the workspace DB.

## Agent-first databases, swept 2026-09-26: the verdict is to stay on node:sqlite
Two sweeps: the [agent data-layer proposal](../plans/2026-09-26-agent-data-layer/proposal.md) §3.1, and a second one covering what it missed. **No independent benchmark shows any of these beating SQLite at a student's scale** (1–5k documents, about 50k passages). Every latency number found was vendor-measured.

| Candidate | Licence and release | In-process in Node/Electron? | Takeaway |
|---|---|---|---|
| Turso Database (SQLite rewrite) | MIT, v0.7.2 (2026-07-30) | yes, native bindings and WASM | native vectors and MVCC concurrent writes (beta). **The planned upgrade path** if contention or vector latency ever bites; it keeps the file format |
| Turso AgentFS | no SPDX licence on GitHub; v0.6.4 | yes, over SQLite | the pattern worth copying: agent state plus an audit trail in one file, copy-on-write |
| sqlite-ai family (sqlite-vector, sqlite-sync, sqlite-ai) | sqlite-vector Apache-2.0; the others NOASSERTION | loadable extensions | small projects; licences must be read before any use |
| Qdrant Edge | repository and licence not found | Rust library; no Node binding found | vectors only |
| PGlite + pgvector | Apache-2.0 | yes (WASM Postgres, ~3 MB gzipped) | mature and widely used; still a second, heavier engine |
| SurrealDB 3.x | **BSL 1.1** (change date 2030-01-01) | not confirmed | multi-model, "agent memory" positioning; the licence rules it out for a shipped product |
| HelixDB | Apache-2.0, v3.3.0 | server, not embedded | graph + vector + FTS with MCP built in; vendor benchmark only (one-hop p50 6.09 ms vs Neo4j 38.75 ms, their hardware) |
| LadybugDB (Kuzu fork) | MIT, v0.20.4 | Node binding is very new (3 stars) | the live fork after Kuzu was archived; graph + vector + FTS; watch |
| CozoDB | MPL-2.0, last release 2023-12 | historically | dormant |
| Alibaba Zvec | Apache-2.0, v0.7.0 | Python only | `zvec-grep` fuses ripgrep, BM25 and vectors in one CLI; an idea to note |
| MemOS | Apache-2.0 | its local plugin uses SQLite FTS5 + vectors | vendor LoCoMo and LongMemEval claims, unverified; it validates the SQLite hybrid pattern |
| Supermemory, Memvid | MIT; Apache-2.0 | hosted-first; Python | Memvid's claims are contested; not considered |

**Also checked in the first sweep** (licences read from each repository): LanceDB is the strongest alternative but a second store; Chroma isn't in-process from Node; Milvus Lite is Python-only; Tantivy has no maintained Node binding; Kuzu is archived; FalkorDB is SSPL; Meilisearch is a server with parts under BSL. Agent-memory frameworks (Letta, mem0, Zep/Graphiti, Cognee) target conversation memory, and their benchmark numbers are disputed.
