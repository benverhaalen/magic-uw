# Benchmark catalog: public datasets and metrics to measure us against

**Status:** researched 2026-09-26. An Exa Agent sweep produced 35 primary-source entries; the load-bearing ones were then re-checked directly. **✓** marks a licence read through the GitHub API, or a claim confirmed on the paper's abstract page. The other figures are as reported by the sweep, with the primary source linked, and should be re-read before quoting. Use follows [tool evaluation](../tool-evaluation.md): licence first, local copies under `.data/` (not committed), and no redistribution.

## S1: Grounded answers and citations (the notebook's chat)
| Resource | Measures | Licence | Use for us |
|---|---|---|---|
| [ALCE](https://github.com/princeton-nlp/ALCE) (ASQA, QAMPARI, ELI5) | answer correctness, citation recall and precision (NLI-based) | MIT ✓ | citation metrics and eval code; an ASQA subset as an external check |
| [RAGBench](https://huggingface.co/datasets/rungalileo/ragbench) | context relevance, faithfulness, utilization, completeness; 100k examples ✓ (arXiv 2407.11005) | check the dataset card | a faithfulness-scorer sanity check |
| [CRAG](https://github.com/facebookresearch/CRAG) | factual RAG QA across 5 domains and 8 question types | NOASSERTION ✓, so read the terms first | robustness question types |
| [FACTS Grounding](https://arxiv.org/abs/2501.03200) | whether long answers are fully grounded in a provided document (up to 32k tokens) | see the paper and Kaggle | the grounding-judge method |
| [TREC RAG](https://trec-rag.github.io/) | citation support rated 0/1/2 (no, partial, full) | per track | the support scale for our human sample |
| **Generation-time vs post-hoc citation** ([arXiv 2509.21557](https://arxiv.org/abs/2509.21557)) | compares citing while writing against citing afterwards | paper | ✓ it recommends "a retrieval-centric, P-Cite-first approach". **This supports our design:** write the answer, then attach quotes and verify them in code |

## S2: Slides, textbooks, long documents (extraction and retrieval)
| Resource | Measures | Licence | Use for us |
|---|---|---|---|
| [MMLongBench-Doc](https://github.com/mayubo2333/mmlongbench-doc) | long-PDF QA; about 22.5% of questions are unanswerable (as reported) | Apache-2.0 ✓ | tests "couldn't find support" honesty and long-PDF extraction |
| [LongBench v2](https://github.com/THUDM/LongBench) | long-context QA | MIT ✓ | a long-context stress set |
| [LooGLE](https://github.com/bigai-nlco/LooGLE) | long-dependency QA over documents above 24k tokens | MIT ✓ | tests whether retrieval finds distant evidence |
| [SlideVQA](https://github.com/nttmdlab-nlp/SlideVQA) | QA across slide decks | NOASSERTION ✓ ("evaluation licence"); read the terms | slide QA, if the terms allow |
| [LecSlides-370K](https://github.com/zamling/LecSlides_370K) (ICCV 2025) | lecture-slide summaries and QA | no licence file ✓ | reference only until licensed |
| Textbook QA (TQA, CVPR 2017), DocVQA | textbook and document-image QA | see sources | optional |

## S3: Question and item quality (practice)
| Resource | Measures | Licence | Use for us |
|---|---|---|---|
| [EduQG](https://arxiv.org/abs/2210.06104) | expert MCQs from OpenStax textbooks, with source-sentence grounding and Bloom labels ✓ | OpenStax sources are CC BY 4.0; dataset terms unstated | a reference set for generated items and distractors |
| [SciQ](https://aclanthology.org/W17-4413/) | 13.7k science MCQs with distractors | CC BY-NC 3.0 (reported); **evaluation only** | a distractor-plausibility comparison |
| **MOOC item-writing-flaw annotations** ([Costello et al. 2018](https://doi.org/10.1186/s13104-018-3959-4)) | 204 MCQs annotated for 15 flaw types; half had at least one flaw (reported) | Zenodo; check the record | **precision and recall of our code flaw rules** |
| LearningQ, CLOTH, the Televic distractor set | question generation, cloze, distractors | varies; check each | optional |

## S4: Knowledge model and spaced repetition (study tracking)
| Resource | Measures | Licence | Use for us |
|---|---|---|---|
| [pyKT](https://github.com/pykt-team/pykt-toolkit) | reproducible knowledge-tracing baselines over standard datasets | MIT ✓ | **compare our Elo-style estimator's next-answer AUC and log loss against DKT-family baselines** |
| ASSISTments 2009–10, [EdNet](https://github.com/riiid/ednet), Junyi | student interaction logs | per dataset (EdNet: no licence file ✓) | the data for the comparison above |
| [Duolingo half-life regression](https://github.com/duolingo/halflife-regression) | recall prediction; the paper reports 45%+ error reduction vs baselines ✓ (ACL 2016 PDF) | MIT ✓ | the decay model baseline |
| [srs-benchmark](https://github.com/open-spaced-repetition/srs-benchmark) | recall prediction for FSRS vs SM-2 and others on about 727M Anki reviews ✓ (README) | **no licence file ✓;** check the Hugging Face dataset card before use | FSRS parameter choice |

## S5: Published evaluations of NotebookLM-like tools
- **NotebookLM staging studies:** 86% vs GPT-4o's 39%, with 95% reference location (PMID 39585559 ✓); 70% vs 38% with 92% retrieval (PMID 41784908 ✓). One lab, on fictional cases.
- **Hagar et al. 2025** (arXiv 2509.25498): 2/15 NotebookLM responses (13%) contained a hallucination, vs 40% for the others. It's a small sample.
- **Institutional and course RAG assistants** (arXiv 2501.13880, 2604.25924): retrieval was the bottleneck, and answers were low on faithfulness (as reported). Our design puts its effort there.

## S6: Measuring speed and cost
- [BenchmarkQED](https://github.com/microsoft/benchmark-qed) (MIT ✓): automated query generation and pairwise LLM-judge win rates. It's the reference for our blind pairwise judging, always with order swaps.
- [Retrieval Pareto](https://github.com/SoumilRathi/retrieval-pareto/) (MIT, as reported): reports quality against latency and storage, rather than one score.
- [IBM MTRAG](https://github.com/IBM/mt-rag-benchmark) (Apache-2.0 ✓): multi-turn RAG, including unanswerable and underspecified turns.
- [SciPhi RAG-Performance](https://github.com/SciPhi-AI/RAG-Performance) (MIT, as reported): an ingestion-throughput method.
- **Vendor latency and cost blogs** (e.g. FloTorch): their own setups, so not evidence about ours.

## Not found
- An independent latency or ingest-time benchmark for Gemini Notebook / NotebookLM.
- A public benchmark that uses real LMS course material (Canvas) end to end. **Our OCW + UW corpus fills that gap.**
