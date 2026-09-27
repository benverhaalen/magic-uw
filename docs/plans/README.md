# Plans: start here to pick up the work

**Status: Living index.** Updated 2026-09-27 against current `main`. For what the system does today and the status of each part, read [how it works](../how-it-works.md) first; the plans below carry the decisions and their evidence. Changes to the shared packages go to `main` as PRs ([AGENTS.md](../../AGENTS.md)).

## Where things stand
- **Status per part** (demonstrated live, integrated, tested in isolation, in progress, planned) lives in one place: [how it works](../how-it-works.md). This index does not repeat it.
- **On `main` since the course-backend plan began:** passages with offsets and passage search; the one job drain and the material pipeline (categorisation, the reference graph, the daily agenda); prompt packs on the student's own Claude Code or Codex (instant mode, client health); cards and quizzes feeding the learning router; study guides; practice analytics; lecture notes with Word and Google sync; Outlook and Microsoft 365 through Graph; file acquisition with OCR; the intent router; read-only MCP and `agent-api` v1; the Workspace tools preview tabs.
- **In progress on branches:** the in-flight table in [how it works](../how-it-works.md).

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
