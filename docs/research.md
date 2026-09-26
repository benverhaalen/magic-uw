# Research status

Checked September 26, 2026. Source review is not product verification. No live UW login, course ingestion, provider integration, latency benchmark, or learning evaluation was performed in this documentation pass.

## Event material reviewed

All seven published pages identified in the public BuildFest page inventory were read: [home](https://buildfest.project.wiscweb.wisc.edu/), [schedule](https://buildfest.project.wiscweb.wisc.edu/schedule-logistics/), [awards](https://buildfest.project.wiscweb.wisc.edu/tracks-awards/), [sponsors](https://buildfest.project.wiscweb.wisc.edu/sponsors-partners/), [mentors/judges](https://buildfest.project.wiscweb.wisc.edu/mentors-judges/), [FAQ](https://buildfest.project.wiscweb.wisc.edu/faq-about-tel/), and [press release](https://buildfest.project.wiscweb.wisc.edu/?page_id=115). Ben's 13 opening-slide photos were reviewed. Discrepancies are recorded in [event context](buildfest.md).

## Findings affecting our description

| Finding | Source and limits |
| --- | --- |
| Jev is text-only; voice needs transcription and images need extraction | [Models](https://docs.typesafe.ai/models.md) |
| Docs list jev-1.13.0, 64k total context, and a separate 32k state-plus-longest-question limit | [Models](https://docs.typesafe.ai/models.md); not an observed capacity test |
| Hosted processing is not local-only; no training is different from zero retention | [Models](https://docs.typesafe.ai/models.md), [DPA](https://typesafe.ai/legal/data-processing); account-specific retention unresolved |
| Named JSON state is appropriate for many requests; prose is not universally preferable | [State guide](https://docs.typesafe.ai/concepts/state.md) |
| Irrelevant context and untrusted instructions can affect judgments; arithmetic and ordering are weak points | [Limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) |
| Matching a quote does not prove a claim follows from it | [Citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check.md) |
| json-render's Jev composition API is experimental and described as unreleased | [Jev UI documentation](https://json-render.dev/docs/jev); do not assume stable npm availability |
| Chrome 136 changed remote debugging for the default data directory | [Chrome announcement](https://developer.chrome.com/blog/remote-debugging-port); dedicated profile is a relevant alternative |
| UW requires specified course syllabus content | [UW-1022](https://policy.wisc.edu/library/UW-1022); does not establish uniform AI policy or machine-readable content |

## Reference roles

The [TypeSafe index](https://docs.typesafe.ai/llms.txt), citation/semantic-find/reranking/guardrail cookbooks, and intent/confidence/composite-scoring patterns inform bounded judgment mechanisms. Their example thresholds and measurements are not our results.

The [design memo](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg) offers context-selection, conditional-rule, and shared-state ideas; it is not proof of product improvement. The [context.dev index](https://docs.context.dev/llms.txt) is a starting point for a public behavioral specification, not a completed clean-room specification. [Working-Memory-Jev](https://github.com/AustinAWay/Working-Memory-Jev) is ideas-only per Ben's instruction; no code reused.

## Still unverified

The broader supplied reference list has not been fully investigated. Remaining gaps include competitor names/capabilities (including the claimed NotebookLM rename), student reports, provider terms, complete retention policies, dependency/model licenses, browser-agent benchmarks, platform signing, and public Jev voice/browser demos. Do not describe videos as watched or capabilities as replicated.

The supplied [UW Google page](https://kb.wisc.edu/googleapps/149230) returned HTTP 403; the [PNAS study](https://www.pnas.org/doi/10.1073/pnas.2422633122) returned a challenge page. Learning claims need the study's actual scope before generalization.

These gaps remain visible without preventing teammates from understanding the intended product. They are not a reason to replace this context-sharing task with a build plan.

## New acquisition and extraction candidates

The live September 26 [tool evaluation](tool-evaluation.md) records browser engines, extractors, OCR models, crawling, and change detection, including corrections to MinerU/changedetection links and benchmark provenance. These are evaluated candidates, not automatic dependencies. The general decision policy is in [engineering principles](engineering-principles.md).
