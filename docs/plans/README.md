# Plans: start here to pick up the work

**Status: Proposal.** Updated 2026-09-26 against `main` at `73ff7a6`. The plans carry our decisions and their evidence. Changes to Ben's packages go to him as PRs ([AGENTS.md](../../AGENTS.md)).

## Where things stand
- **Built on `main`:**
  - an Electron desktop with a utility-process SQLite store (FTS5, versioned captures, jobs, judgment cache, attempts, receipts)
  - a Canvas connector (courses, syllabus, assignments)
  - privacy gates
  - local AI via Ollama
  - a Jev gateway with one judgment
  - See [implementation status](../implementation-status.md) and the [backend map](../notes/backend-map.md).
- **Not built yet:** Canvas files, modules and pages; PDF/PPTX extraction; feature tables; the learning features; the AI-CLI runtime; notes export; licensing.

## Read in this order
1. [Notebook + study tracking spec](2026-09-26-notebook-and-study-tracking/spec.md) and its [tasks](2026-09-26-notebook-and-study-tracking/tasks.md): **the next thing to build.** It covers the NotebookLM-style course notebook, the Quizlet-like study modes, and a knowledge model of what the student has learned and what is still iffy.
2. [Complete app plan](2026-09-26-complete-app/plan.md): the whole product. Components, owners (proposed), phases, and the decisions that change Ben's direction.
3. [Learning features plan](2026-09-26-learning-features/plan.md): the first build wave (passages, quote checks, items, sessions, eval harness), reviewed once.
4. [Where we differ](../notes/where-we-differ.md): every proposed change to current code or decisions, with evidence and triggers.
5. The evidence: the [performance plan](../notes/performance-plan.md), [benchmarking](../notes/benchmarking.md), [local DB](../notes/local-db.md), [agent runtime](../notes/agent-runtime.md), [business model](../notes/business-model.md), [notes targets](../notes/notes-targets.md), [open-source candidates](../notes/open-source-candidates.md), and [Jev insights](../notes/jev-insights.md).

## Working rules for whoever picks this up
- **Pull first.** Build on the newest `main`. Changes to Ben's packages (contracts, storage, core, ai, connectors, apps) go to him as PRs.
- **Commits:**
  - Commit synthetic fixtures only.
  - Course material, the OCW benchmark corpus and real course data stay out of git.
  - No Jev performance numbers in the repo.
- **Agent testing on Ben's machine and Canvas is headless.** Never automate Duo.
- **Claims are measured:** use the [benchmarking](../notes/benchmarking.md) rules, then report quote validity and claim support separately.
