# Plans: start here to pick up the work

> **Historical plans.** These record intent and decisions as written on September 26–27. What is built now, with evidence, is in [implementation status](../implementation-status.md); how it fits together is in [the architecture](../architecture.md).

**Status: Proposal.** Updated 2026-09-26 against `main` at `d44dcf7`. The plans carry our decisions and their evidence. Changes to the shared packages go to `main` as PRs ([AGENTS.md](../../AGENTS.md)).

## Where things stand
- **Built on `main`:**
  - an Electron desktop with a utility-process SQLite store (FTS5, versioned captures, jobs, judgment cache, attempts, receipts)
  - the Canvas connector (courses, syllabus, assignments, modules, pages, files, quizzes, discussions, announcements)
  - document extraction (PDF, PPTX, DOCX, HTML)
  - calendar, external-site and GitLab connectors
  - background refresh
  - a permissioned MCP server
  - privacy gates
  - local AI via Ollama
  - a Jev gateway with one judgment
  - See [implementation status](../implementation-status.md) and the [backend map](../notes/backend-map.md).
- **Not built yet:** passages with offsets, the course map (assessment scope and materials), Outlook and campus feeds, prompt packs and the model runner, the notebook UI, the learning features, notes export, licensing.

## Read in this order
1. **[Course backend: execution playbook](2026-09-26-course-backend/execution.md), [spec](2026-09-26-course-backend/spec.md), [plan](2026-09-26-course-backend/plan.md) and [tasks](2026-09-26-course-backend/tasks.md): the build.** Start with the playbook: units U0-U10, each with a research pass, the fleet, live trials and an exit condition. Connect every source (Canvas, Outlook as a gist and a link, calendar and campus feeds, Kaltura), store it, map assignments and assessments to their materials, and build the notebook on top. Every AI feature is a one-call prompt pack on the student's own AI. It supersedes the agent data-layer and sync-and-actions docs where they differ.
2. [Notebook + study tracking spec](2026-09-26-notebook-and-study-tracking/spec.md) and its [tasks](2026-09-26-notebook-and-study-tracking/tasks.md): the learning mechanics that run in the notebook: the Quizlet-like study modes and a knowledge model of what the student has learned and what's still iffy.
3. [Backend optimization](2026-09-26-backend-optimization/plan.md): taking the existing backend from here. The baseline comes first, then the decided optimizations (scoped queries instead of full snapshots, statement cache, WAL sync mode, passages, text-hash caching, precompute, stable-prefix AI sessions, Canvas throttling), then the measure-first list.
4. [Measurement plan](2026-09-26-measurement/plan.md): the harness tasks to start measuring: backend baseline, grounded Q&A, item quality, the knowledge model on public datasets before we have students, cost and latency, head-to-head.
5. [Complete app plan](2026-09-26-complete-app/plan.md): the whole product. Components, owners (proposed), phases, and the decisions that change the current direction.
6. [Learning features plan](2026-09-26-learning-features/plan.md): the first build wave (passages, quote checks, items, sessions, eval harness), reviewed once.
7. [Where we differ](../notes/where-we-differ.md): every proposed change to current code or decisions, with evidence and triggers.
8. The evidence: the [competitive comparison](../notes/competitive-comparison.md), the [benchmark catalog](../notes/benchmark-catalog.md), the [performance plan](../notes/performance-plan.md), [benchmarking](../notes/benchmarking.md), [local DB](../notes/local-db.md), [agent runtime](../notes/agent-runtime.md), [business model](../notes/business-model.md), [notes targets](../notes/notes-targets.md), [open-source candidates](../notes/open-source-candidates.md), and [Jev insights](../notes/jev-insights.md).

## Working rules for whoever picks this up
- **Pull first.** Build on the newest `main`. Changes to the shared packages (contracts, storage, core, ai, connectors, apps) go to `main` as PRs.
- **Commits:**
  - Commit synthetic fixtures only.
  - Course material, the OCW benchmark corpus and real course data stay out of git.
  - No Jev performance numbers in the repo.
- **Agent testing on the team's machines and Canvas is headless.** Never automate Duo.
- **Claims are measured:** use the [benchmarking](../notes/benchmarking.md) rules, then report quote validity and claim support separately.
