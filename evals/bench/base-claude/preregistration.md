# Pre-registration: ingestion and agent-task benchmark

Fixed before any live run. Every result records the first 16 hex characters of this file's SHA-256; a
changed threshold changes the hash and must be stated. The thresholds live in `score.ts` (`THRESHOLDS`).

## Part A: ingestion head-to-head

**Sides.** Ours (the app's ingestion code, 3 runs, fresh database each) and each baseline client and model
(Claude Code: `claude-opus-5-5`, `claude-sonnet-5`; Codex: `gpt-6-astra` default, `gpt-6-sol` cheaper),
3 runs each, fresh working folder each.

**Gold.** `gold.ts`: an independent GET-only crawl of the Canvas REST API through the same signed-in session,
taken once before the runs. It never reads our database.

**A run passes only if every check holds:**

| Check | Pass when |
|---|---|
| Current courses | no current course missing and no other course (past, restricted, non-term site) marked current |
| Assignments | recall >= 0.98; due_at exact (same second, UTC) on >= 99% of matched; points exact on >= 99%; extra rows <= max(1, 1% of gold) |
| Assignment groups | recall >= 0.98; weights exact on >= 98% (NULL or 0 accepted where the course does not weight groups) |
| Modules | recall >= 0.98; extra rows <= max(1, 1%) |
| Module items | recall >= 0.98; items in the wrong module <= max(1, 1%); extra rows <= max(1, 1%) |
| Pages | recall >= 0.95; mean token F1 of body text >= 0.80 |
| Files | recall >= 0.95 (files reachable through modules and links count when the Files tab is hidden); text present on >= 90% of text-bearing files; mean token F1 >= 0.70 on the gold's sampled files (3 per course, plus syllabus files) |
| Syllabus | present for >= 90% of current courses that have one; mean token F1 >= 0.60 |

Rows for non-current courses in the deep tables count as extra rows.

**Measured per run:** wall time to agenda-usable (the first moment >= 95% of the gold's dated assignments are
present with the exact due date; baseline polled every 15 s, ours every 1 s) and to complete; Canvas requests
(proxy log); tokens (input, cached, output); cost in USD (Claude Code's reported `total_cost_usd`; Codex
estimated from API list prices, labelled); blocked write attempts; the repeat sync (a second pass over the same
account: time, requests, tokens, cost, and whether the database still passes).

**Headline comparison:** pass rate, median time to complete, median cost, per side. Rows we lose are reported.

## Part B: academic agent tasks

60 tasks from the gold, 10 families x 6 (`tasks.ts`): due date, exam date, points, group weight, module of an
item, readings linked from an assignment, assignments due in a window (ordered), next due, module size, files
in a module. Answers are JSON with Canvas ids (exact unique titles accepted); checked by code only.

Each client x condition (raw browser; our database through the read-only MCP) runs the same 10 sampled tasks
(one agent run each). Reported: pass@1 with a 95% percentile-bootstrap interval (2,000 resamples), cost per
correct answer, median latency, failures by type (wrong answer, schema error, timeout, budget, tool error,
agent error).

## Caps

Part A: 40 minutes wall and a USD cap per run (proposed: Opus 5.5 $25, Sonnet 5 $10, gpt-6-astra $25,
gpt-6-sol $10); repeat sync 20 minutes and $10. Part B: 10 minutes and $3 per trial. A run stopped at a cap is
scored on what it wrote and marked with the cap. One retry of the prompt when an attempt ends on its own with
assignments, modules or files still empty, within the remaining caps.
