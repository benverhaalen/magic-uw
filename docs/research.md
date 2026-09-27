# Research status

Updated September 26, 2026. Source review and synthetic verification are different evidence. The ingestion upgrade is implemented and tested; its app-owned UW path has not been demonstrated live. [Implementation status](implementation-status.md) records the observed checks and limits. Earlier research below retains its original scope.

## Event material reviewed

All seven published pages identified in the public BuildFest page inventory were read: [home](https://buildfest.project.wiscweb.wisc.edu/), [schedule](https://buildfest.project.wiscweb.wisc.edu/schedule-logistics/), [awards](https://buildfest.project.wiscweb.wisc.edu/tracks-awards/), [sponsors](https://buildfest.project.wiscweb.wisc.edu/sponsors-partners/), [mentors/judges](https://buildfest.project.wiscweb.wisc.edu/mentors-judges/), [FAQ](https://buildfest.project.wiscweb.wisc.edu/faq-about-tel/), and [press release](https://buildfest.project.wiscweb.wisc.edu/?page_id=115). Ben's 13 opening-slide photos were reviewed. Discrepancies are recorded in [event context](buildfest.md).

## Findings affecting our description

| Finding                                                                                                     | Source and limits                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Jev is text-only; voice needs transcription and images need extraction                                      | [Models](https://docs.typesafe.ai/models.md)                                                                                          |
| Docs list jev-1.13.0, 64k total context, and a separate 32k state-plus-longest-question limit               | [Models](https://docs.typesafe.ai/models.md); not an observed capacity test                                                           |
| Hosted processing is not local-only; no training is different from zero retention                           | [Models](https://docs.typesafe.ai/models.md), [DPA](https://typesafe.ai/legal/data-processing); account-specific retention unresolved |
| Named JSON state is appropriate for many requests; prose is not universally preferable                      | [State guide](https://docs.typesafe.ai/concepts/state.md)                                                                             |
| Irrelevant context and untrusted instructions can affect judgments; arithmetic and ordering are weak points | [Limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)                                                                  |
| Matching a quote does not prove a claim follows from it                                                     | [Citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check.md)                                                             |
| json-render's Jev composition API is experimental and described as unreleased                               | [Jev UI documentation](https://json-render.dev/docs/jev); do not assume stable npm availability                                       |
| Chrome 136 changed remote debugging for the default data directory                                          | [Chrome announcement](https://developer.chrome.com/blog/remote-debugging-port); dedicated profile is a relevant alternative           |
| UW requires specified course syllabus content                                                               | [UW-1022](https://policy.wisc.edu/library/UW-1022); does not establish uniform AI policy or machine-readable content                  |

## Reference roles

The [TypeSafe index](https://docs.typesafe.ai/llms.txt), citation/semantic-find/reranking/guardrail cookbooks, and intent/confidence/composite-scoring patterns inform bounded judgment mechanisms. Their example thresholds and measurements are not our results.

The [design memo](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg) offers context-selection, conditional-rule, and shared-state ideas; it is not proof of product improvement. The [context.dev index](https://docs.context.dev/llms.txt) is a starting point for a public behavioral specification, not a completed clean-room specification. [Working-Memory-Jev](https://github.com/AustinAWay/Working-Memory-Jev) is ideas-only per Ben's instruction; no code reused.

## Still unverified

The broader supplied reference list has not been fully investigated. Remaining gaps include competitor names/capabilities (including the claimed NotebookLM rename), student reports, provider terms, complete retention policies, dependency/model licenses, browser-agent benchmarks, platform signing, and public Jev voice/browser demos. Do not describe videos as watched or capabilities as replicated.

The supplied [UW Google page](https://kb.wisc.edu/googleapps/149230) returned HTTP 403; the [PNAS study](https://www.pnas.org/doi/10.1073/pnas.2422633122) returned a challenge page. Learning claims need the study's actual scope before generalization.

These gaps remain visible so teammates can separate supported behavior from the broader product direction.

## New acquisition and extraction candidates

The live September 26 [tool evaluation](tool-evaluation.md) records browser engines, extractors, OCR models, crawling, and change detection, including corrections to MinerU/changedetection links and benchmark provenance. These are evaluated candidates, not automatic dependencies. The general decision policy is in [engineering principles](engineering-principles.md).

## Reference-driven design and retained technical details

The [reference register](reference-driven-design.md#reference-register-and-concrete-transfers) records inspected official product documentation, proposed transfers, and the remaining live-interaction gaps. VS Code execution boundaries, Notion views, Drive resource organization, Arc Spaces, Canvas navigation, and Claude quick entry have specific jobs. The supplied Jev videos and several app/artifact interactions remain unverified; this update does not claim they were reproduced. [Six organizing concepts](product-directions.md) are design hypotheses awaiting Ben's reaction.

[Pipeline details](pipeline-details.md) compare actual connector/session/context code with current Canvas pagination, throttling, announcements/activity, and Microsoft Graph documentation. They preserve proposed scrubbing/citation behavior and a link-threshold experiment informed by the original Fellegi–Sunter record-linkage paper. No representative UW coverage, redaction accuracy, fuzzy-link precision, real local-model quality, or paid Jev performance has been measured.

## Ingestion implementation evidence

The [ingestion handoff](ingestion-upgrade.md#primary-references-and-their-role) maps the Canvas, GitLab, calendar, and document references to their concrete use. Canvas pagination and scope semantics became strict bounded reads; module metadata/body separation became prioritized page fetches; calendar capabilities became encrypted secrets with an independent credential-free transport. These are transferred mechanisms, not vendor speed claims.

The initial ingestion upgrade passed 119 automated tests, the build, a hidden Electron journey, and headless renderer checks; the current combined gate is recorded in implementation status. Synthetic transports exercise the real coordinator and SQLite store, including exclusions, partial reads, expiry, continued calendar feeds, typed changes, linked context, and MCP privacy/revocation. Generated PDF/Office files exercise actual text extraction. See [implementation status](implementation-status.md#verification) for the complete evidence boundary.

An earlier authorized private pull established live reads for the previous thin Canvas connector. Its personal-browser adapter is not a product integration. Ben later separately authorized private headless Firefox-session checks for the planning investigation; that exception does not change production authentication. The new path still needs app-owned login/expiry/SSO checks, per-course feed availability, real five-course request costs, download-host coverage, GitLab authentication, and cold/warm timings. Keep only aggregate counts/timings in shared research, never private coursework or credentials.

Ben accepts incidental view/must-view effects from reading Canvas. No teacher-controlled course is available to isolate which endpoints cause those effects; the UI discloses the possibility and exposes no explicit completion action. Feedback collection defaults to local; hosted sharing requires a separate grant. These are accepted decisions, not findings that reads have no side effects.

Pinned additions are node-ical 0.27.2 and PDF.js 6.3.289 (Apache-2.0), fflate 0.8.3 (MIT), and MCP client/server SDK 2.1.0 (MIT). Their shipped versions and local behavior were checked; no independent speed comparison is claimed. Optional Poppler/Tesseract are developer-supplied local tools, not bundled dependencies. Their distribution and license obligations need review before shipping binaries.

## Planning evidence and remaining unknowns

The [planning handoff](planning-upgrade.md) separates live adapters, normalized fixtures, research-only transcript access, and remaining product work. The integrated native HTTP → normalization → SQLite/reopen check succeeded on one authorized account with no normalization rejects, including enrollment, history, and saved audits. Personal inventory counts and report contents remain private. Source scope/completeness, unresolved transfer identities, and ambiguous audit blocks remain visible. Public catalog and package parameters were checked against actual response shapes. These are observations from one student and selected courses, not error-rate or coverage estimates.

The source review corrected consequential assumptions: DARS catalog `20251` means Fall 2024; UW service clock fields need a source-specific fixed-offset decoder; Canvas academic-year labels need corroboration; DARS applied credits are not attempt credits; current/final Canvas scores are not authoritative transcript grades. The reconciliation projection encodes these distinctions. Existing unofficial transcript access succeeded without requesting a new report; a production parser is still absent.

The coursemap data repository declares MIT while its related application is AGPL-3.0. Neither code nor data was adopted. Underlying ratings rights remain unresolved, so ratings stay link-out. Madgrades OpenAPI was reviewed, but no live adapter/token is present. Six scoped policy entries are implemented; broader policy assumptions remain outside automatic alerts.

All private checks stayed headless under Ben's explicit Firefox authorization. Captures and identity remain outside Git/logs; no hosted model received them. One-login app-owned SSO, actual session lifetimes, identity switching in that browser, nonempty holds/advisors, transfer equivalences, and representative non-CS/college audit coverage still require evidence. The initial 403 responses followed by successful session-backed reads do not establish the cause of denial or anonymous access reliability.
