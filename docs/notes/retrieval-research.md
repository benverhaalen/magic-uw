# Retrieval research: what's reported to beat plain search, and what we adopt

**Status: Research, 2026-09-26.** Feeds the [course backend spec](../plans/2026-09-26-course-backend/spec.md) (Parts B–D) and the measure-first items in the [agent data-layer proposal](../plans/2026-09-26-agent-data-layer/proposal.md) §6. Numbers are as reported by the named party, and most were read through search summaries. Re-read the primary source before any number becomes load-bearing.

## Decisions it supports
1. **Typed lookups first.** Most app features know their scope (an assessment's confirmed materials), so they need no search call at all.
2. **BM25 over passages next;** vectors only if they win on our gold set.
3. **No graph-RAG indexing.** The course pass builds the course graph in one call per course.

## Graph-based RAG
| Finding | Number | Who / source |
|---|---|---|
| Graph structure helps multi-hop, hurts simple QA | RAPTOR, GraphRAG, LightRAG and HippoRAG often −5 to −10 F1 on simple QA vs plain RAG | GraphRAG-Bench ("When to use Graphs in RAG", arXiv 2506.05690, ICLR'26) |
| GraphRAG vs RAG, systematic | HotpotQA F1 61.66 vs 60.04; MultiHop-RAG 69.01% vs 67.02%; hybrid integration up to +6.4 | Han et al., arXiv 2502.11371 |
| Indexing cost | HippoRAG 2: about 9M tokens vs 115M for GraphRAG-style extraction on MuSiQue; LazyGraphRAG indexing "identical to vector RAG" (about 0.1% of full GraphRAG) | arXiv 2502.14802 (corrected 2026-09-26); Microsoft Research blog (2024-11) |
| RAPTOR tree summaries | QuALITY +20 accuracy with GPT-4; NarrativeQA ROUGE-L 30.87 vs 29.26 | Sarthi et al., ICLR 2024 |

## Local lexical, sparse and late-interaction retrieval
| Technique | Reported | Source |
|---|---|---|
| BM25S | >100× throughput over rank-bm25 on 10 of 14 datasets | arXiv 2407.03618 |
| SPLADE-v3 | BEIR avg nDCG@10 51.7 | arXiv 2403.06789 |
| answerai-colbert-small | BEIR avg nDCG@10 0.5379; beats e5-large-v2 (corrected 2026-09-26) | Answer.AI (2024-08) |
| MUVERA vs PLAID | +10% recall, −90% latency | Google Research, NeurIPS 2024 |
| Late chunking | +1.9 nDCG absolute on average | Jina, arXiv 2409.04701 |

## Slides and visual documents
- **ColPali** retrieves page images directly: nDCG@5 0.813 vs 0.66 for BM25 over OCR text on ViDoRe, and it wins even on text-heavy subsets (arXiv 2407.01449, ICLR 2025).
- **For slide-heavy courses this is a measure-first candidate.** It needs a vision model to run locally, so it's weighed against CPU budgets.

## Long context vs retrieval
- **No universal winner** between RAG and long-context models; it depends on model, task and length (LaRA, ICML 2025, 2,326 cases).
- **1M-token models exist on every route we use:** Sonnet 5, Opus 5.5, GPT-6 Sol and Luna, Gemini 3.x.
- **Our budgets still apply caps:** the cost scales with tokens, and quotes must stay checkable.

## Embeddings in Node and Electron
| Fact | Number / status | Source |
|---|---|---|
| transformers.js (WASM vs WebGPU) | all-MiniLM-L6-v2, batch 1: 378 ms WASM vs 32 ms WebGPU (Chrome 122) | HF Space community benchmark |
| model2vec static embeddings | about 500× faster than MiniLM on CPU, about 90% of its MTEB score (maker's claim) | MinishLab |
| Running inside Electron | onnxruntime-node packaging errors are reported; a maintained Electron fork exists; the utilityProcess path is unverified | transformers.js issues #487, #1240; Mintplex fork |
| Zero-shot classification with small embedders | MiniLM average F1 about 0.37; larger embedders 0.59–0.62 | BTZSC, arXiv 2603.11991. **Not good enough to decide exam scope** |

## Agentic search vs embeddings for coding agents
- **Claude Code:** "Early versions of Claude Code used RAG + a local vector db, but we found pretty quickly that agentic search generally works better", citing security, privacy, staleness and reliability (Boris Cherny).
- **Cursor:** measured semantic search adding +0.3% code retention (+2.6% on codebases over 1,000 files), used alongside grep (cursor.com/blog/semsearch, 2025-11-06; a vendor).
- **Neither is about course documents,** so our gold set decides.

## Workflows vs agent loops
- **Anthropic:** "For many applications, optimizing single LLM calls with retrieval and in-context examples is usually enough" ("Building effective agents").
- **Cascades:** FrugalGPT reports matching the best model at up to 98% lower cost (arXiv 2305.05176). This is the basis for pass-then-escalate.
- **Prompt caching (Anthropic pricing page):** cache reads bill at 0.1× the input price.
