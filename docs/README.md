# Documentation index

Every document in `docs/`, listed once. Start with [the architecture](architecture.md) and [implementation status](implementation-status.md); the repository [README](../README.md) is the one-screen overview. Status words (researched, proposed, built, tested in isolation, integrated, demonstrated) are defined in [implementation status](implementation-status.md). My Magic UW is an independent student project, not affiliated with UW–Madison. Older documents use the working name Magic Canvas.

## Product

| Document | What it answers |
|---|---|
| [Product brief](product.md) | who it's for, the student experience, the learning loop |
| [Product direction](magic-canvas-direction.md) | the whole product end to end, the two-part launch, where it's going |
| [Decisions and open points](decisions.md) | what's established, dated decisions with their reasons, what's still open |
| [BuildFest context](buildfest.md) | event facts, entries, judging audiences |
| [Business model](notes/business-model.md) | open source with the student's own AI, the hosted Jev service, the campus licence path (price is an open team decision) |
| [Accounts and payments](accounts-and-payments.md) | email sign-in, purchase status in Supabase, setup |
| [Marketing materials](../marketing/README.md) | website directions, logo pack, team photos |

## Architecture

| Document | What it answers |
|---|---|
| [Architecture](architecture.md) | **canonical:** processes, packages, sync, storage, the AI boundary, retrieval, study, notes and Outlook, privacy, the agent layer |
| [Backend reference](course-backend-architecture.md) | schema history, agent-runtime mechanisms, the job-handler contract, freshness, measured effect per design choice, the command bar, open human calls |
| [Academic data platform](academic-data-platform.md) | the database for developers: agent API, MCP course bank, quickstart, licensing, scorecard, roadmap |
| [AI and privacy](ai-and-privacy.md) | AI choices, protection layers per egress path, encryption at rest, provider settings |
| [Pipeline details](pipeline-details.md) | Canvas reads, limits, reconnect, scrubbing, citation checks, link thresholds |
| [Backend map](notes/backend-map.md) | what the code gives learning features and its extension points |
| [Local database](notes/local-db.md) | what's built in storage and what the research supports adding |
| [Agent runtime](notes/agent-runtime.md) | chat and agents on the student's own AI CLI |

## Features

| Document | What it answers |
|---|---|
| [Implementation status](implementation-status.md) | **every feature's status, location and evidence** |
| [Course ingestion](ingestion-upgrade.md) | what's captured, how it refreshes, what survives failures |
| [Planning integration](planning-upgrade.md) | My UW adapters, source reconciliation, privacy |
| [Course intelligence](course-intelligence.md) | versioned course claims and source-bound policy |
| [Course-aware learning sessions](learning-sessions.md) | the assignment learning surface and its limits |
| [Session notes](notes-setup.md) | lecture-note scaffolds, commands, Word and Google Docs sync |
| [Outlook setup](outlook-setup.md) | the app's own Microsoft sign-in and the E1 live test |
| [Calendar page integration](calendar-page-integration.md) | the Calendar page's binding and return state |
| [Prepared work integration](start-work-integration.md) | the prepared-work launch contract |

## Operations

| Document | What it answers |
|---|---|
| [Status, September 27](status-2026-09-27.md) | what works this morning, with measurements, and what's broken |
| [Development](development.md) | running the workspace, checks, the gateway |
| [Frontend data bugs](frontend-data-bugs.md) | backend data defects found while building the frontend |
| [Engineering principles](engineering-principles.md) | tool selection, evidence, privacy |
| [Agent work principles](agent-work-principles.md) | intent, delegation, context and cost, complete delivery |
| [Reference-driven design](reference-driven-design.md) | how references change design, implementation and verification |

## Research and evidence

| Document | What it answers |
|---|---|
| [Benchmarks](benchmarks.md) | every measurement with its method, and what isn't measured yet |
| [Research status](research.md) | checked references and unresolved evidence |
| [Tool evaluation](tool-evaluation.md) | candidate tools, licences, benchmark provenance |
| [Research notes index](notes/README.md) | the notes below, with their status |
| [Where we differ](notes/where-we-differ.md) | where our research departs from the current plan, with evidence |
| [Competitive comparison](notes/competitive-comparison.md) | against NotebookLM, Quizlet and Duolingo |
| [Benchmarking honestly](notes/benchmarking.md) | the method for fair comparisons |
| [Benchmark catalog](notes/benchmark-catalog.md) | public datasets and metrics |
| [Performance plan](notes/performance-plan.md) | what makes the app measurably better |
| [Retrieval research](notes/retrieval-research.md) | what beats plain search, and what we adopt |
| [AI provider access](notes/ai-provider-access.md) | what provider terms allow for the student's own account |
| [Jev usage](notes/jev-usage.md) | design rules for each typed judgment |
| [Jev insights](notes/jev-insights.md) | the design behind each typed judgment |
| [Practice engine](notes/practice-engine.md) | quizzes, exams, preparedness, study sessions |
| [Practice evidence](notes/practice-evidence.md) | the learning-science evidence behind it |
| [Integrity roles](notes/integrity-roles.md) | helping without doing the graded work |
| [Notes method](notes/notes.md) | the right note method per session, turned into practice |
| [Where notes go](notes/notes-targets.md) | local first, cloud only when present |
| [Integrations](notes/integrations.md) | everything reachable through the Canvas portal |
| [Calendar and campus life](notes/calendar-life.md) | one calendar, plus a place for everything else |
| [Project coordinator](notes/project-coordinator.md) | one space per project |
| [Major toolkits](notes/major-toolkits.md) | the workspace specialised per degree |
| [Open-source candidates](notes/open-source-candidates.md) | libraries for the learning features |
| [BuildFest rules](notes/buildfest-rules.md) | the rules that shape the submission |

## Plans (historical)

Plans record intent when they were written; current status is in [implementation status](implementation-status.md). Where a plan and the course-backend plan folder differ, the folder wins.

| Document | What it answers |
|---|---|
| [Plans index](plans/README.md) | the plans and how they relate |
| [Course backend: spec](plans/2026-09-26-course-backend/spec.md) · [plan](plans/2026-09-26-course-backend/plan.md) · [tasks](plans/2026-09-26-course-backend/tasks.md) · [execution](plans/2026-09-26-course-backend/execution.md) | the governing backend specification, decisions (D-numbers) and task graph |
| [Notebook and study tracking: spec](plans/2026-09-26-notebook-and-study-tracking/spec.md) · [tasks](plans/2026-09-26-notebook-and-study-tracking/tasks.md) · [practice and insights](plans/2026-09-26-notebook-and-study-tracking/practice-and-insights.md) | the course notebook and study-tracking design |
| [Sync and actions: design](plans/2026-09-26-sync-and-actions/design.md) · [course compile](plans/2026-09-26-sync-and-actions/course-compile.md) · [accuracy](plans/2026-09-26-sync-and-actions/accuracy.md) | sync without a model on the hot path |
| [Backend optimization](plans/2026-09-26-backend-optimization/plan.md) | faster and cheaper than the alternatives |
| [Measurement](plans/2026-09-26-measurement/plan.md) | the measurement harness |
| [Learning features](plans/2026-09-26-learning-features/plan.md) | learning features on the backend, evidence-gated |
| [Complete app](plans/2026-09-26-complete-app/plan.md) | the app as a product |
| [Agent data layer](plans/2026-09-26-agent-data-layer/proposal.md) | one query engine, two thin routes |
| [Course brief](plans/2026-09-27-course-brief.md) | the course brief on the course page |

## Design

| Document | What it answers |
|---|---|
| [DESIGN.md](../DESIGN.md) | **the design system's entry point:** visual and behaviour requirements, roles, adoption gates |
| [Desktop handoff](design-handoff.md) | the current desktop frontend: entry points, runtime receipts and boundaries |
| [Home and visual direction](home-design-direction.md) | the near-approved Home and its refinements |
| [Adoption](design/adoption.md) · [foundations](design/foundations.md) · [tokens](design/tokens.css) | how screens adopt the system; foundations and tokens |
| [Component contracts](design/component-contracts.md) · [recipes](design/component-recipes.md) · [content design](design/content-design.md) | product and interaction contracts, reusable recipes, copy |
| [Personal deadlines](design/personal-deadlines.md) · [personal reports](design/personal-reports.md) | planning-date choices and briefing reports |
| [Handoff v3](design/handoff-v3.md) · [platform handoff](design/platform-handoff.md) · [component lab](design/lab/README.md) | using the component system, cross-platform handoff, the working lab |
| [Decision record](design/decision-record.md) · [reference selection](design/reference-selection.md) · [system research](design/system-research.md) | design decisions, references and adopted mechanisms |
| [System coverage](design/system-coverage.md) · [visual baseline](design/visual-baseline.md) · [validation v2](design/validation-v2.md) · [validation v3](design/validation-v3.md) · [v3 source audit](design/audit-v3-direct-sources.md) | surface map, baseline and validation records |

## Archive

Superseded documents, kept as dated records. Each opens with what supersedes it.

| Document | Superseded by |
|---|---|
| [Technical direction, September 26](archive/technical-direction-2026-09-26.md) | [architecture](architecture.md) |
| [Implementation log, to September 27](archive/implementation-log-2026-09-27.md) | [implementation status](implementation-status.md) (the log keeps the full verification narratives) |
| [Course backend build record](archive/course-backend-build-record.md) | [architecture](architecture.md), [backend reference](course-backend-architecture.md), [benchmarks](benchmarks.md) |
| [Backend branch audit](archive/backend-branch-audit.md) | [implementation status](implementation-status.md) |
| [Sync resilience review](archive/sync-resilience-review.md) | [architecture §4](architecture.md#4-sync) |
| [Six organizing concepts](archive/product-directions.md) | [Home and visual direction](home-design-direction.md) |
