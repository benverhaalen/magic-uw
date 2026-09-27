# Stall audit: measurements

Harness: `npx tsx evals/perf/stalls.ts --size 1000 --idle 8000` (evals/perf/stalls.ts). It runs the
real worker (apps/desktop/src/worker.ts) in a Node child with `process.parentPort` shimmed over IPC,
and this process plays main. Data: evals/perf/synthetic.ts coursework (1,000 resources, 5 courses)
plus the synthetic Canvas university (packages/connectors/src/canvas-fixture.ts, 150 ms per request).
No Electron window, no network, no real data. Windows 11 laptop, Node 24.14.1. Numbers are one run
and move by about 20% between runs; the statement counts and byte sizes are exact.

The `evals/perf/sync-account*` fixture from the brief is only on `origin/fix/sync-events`, not on
main, so the sync here uses the on-main synthetic university. Once that branch merges, the harness
can switch to it.

## Baseline at aa1ff45 (origin/main)

| action | worker ms | statements | reply bytes | full snapshot |
|---|---|---|---|---|
| open app (first snapshot) | 84 | 31 | 6,427,013 | yes |
| open Home (agenda graph) | 91 | 249 | 29,201 | no |
| open a course (course query and graph) | 28 | 4 | 89,400 | no |
| open an item (`ui_event` open and resource query) | 95 | 40 | 6,431,304 | yes, for `ui_event` |
| search (snapshot with search) | 93 | 40 | 978,602 | yes |
| command bar (prewarm) | 60 | 34 | 6,427,310 | yes |
| command bar (run "what's due this week") | 122 | 40 | 6,427,299 | yes |
| generate cards (pack, no client) | 300 | 753 | 6,427,352 | yes |
| study: knowledge state (learning) | 88 | 54 | 6,427,129 | yes |
| focus | 0 (no reply) | 85 | 0 | no |

**The renderer's poll (App.tsx:199-206): a full snapshot every 2 s while the window is visible.**
Per poll: 56 ms of worker time, 46 statements, a 6.4 MB reply, and 7.6 ms for main to clone it on
to the renderer (plus the renderer's own deserialize and a full React re-render, which this harness
doesn't see). That is about 3% of a core continuously, just to redraw identical data. The worker
answers one message at a time, so any view request can wait behind a poll. The view-speed builder
measured 12.7 MB and about 125 ms per build on a real-shaped 2,577-resource copy.

**While syncing (first sync, 1,000 resources on the device):** view requests p99 444 ms (the
target is under 100 ms), with worker event-loop blocks of 393, 298 and 188 ms, all made of the full
`resources` read (`SELECT r.*, v.payload, ...` at 20 to 28 ms each), repeated inside one step.

**During the job drain after the sync (8 s):** view requests p99 117 ms, with 18 blocks over 50 ms
(max 114 ms), each again several full `resources` reads in one slice. The drain did 3,709
statements in 8 s.

**Idle, with no renderer:** 0 statements and no Canvas requests in 8 s. The worker's timers are all
30 s or longer (listed below). Its CPU still measured 0.2 to 0.4 s per 10 s in two runs; the source
of that isn't attributed yet (0 statements, no timer fired).

| timer | cadence | where |
|---|---|---|
| pipeline wake | 60 s | apps/desktop/src/worker.ts:457 |
| pipeline backfill | once, 20 s after start | apps/desktop/src/worker.ts:459 |
| planning cadence | 10 min (present only) | apps/desktop/src/worker.ts:588 |
| ingestion tick | 30 s (returns early unless due) | apps/desktop/src/worker.ts:595 |
| core wake | 30 s | apps/desktop/src/worker.ts:599 |
| notes tick | 30 s | apps/desktop/src/worker.ts:617 |
| presence (main) | 60 s | apps/desktop/src/main.ts:2041 |
| renderer snapshot poll | **2 s** | apps/desktop/src/renderer/App.tsx:201 |
| Today rail clock (renderer, no IPC) | 60 s | apps/desktop/src/renderer/TodayRail.tsx:72 |

**Synchronous fs in the worker during the sync and drain:** only the course brief writer
(packages/core/src/course-facts/brief.ts:275-282, four calls per course) and one `existsSync`.
No JSON parse or stringify over 1 MB ran inside the worker; the 6.4 MB snapshot crosses as a
structured clone.

## Fix 1: change-driven snapshot reads (b87c447, merged onto main 734a755+ in 1714bbd)

The worker compares the store's write count (`SELECT total_changes()`) once a second and posts
`changed`; main forwards `magic:changed`; App.tsx reads the snapshot on it, at most every 2 s, through
the snapshot gate Ben added on main. Without `onChanged`, his idle-time poll (read, 2 s idle, read)
stays as the fallback.

Idle for 10 s after the workspace settles, 1,000 resources, after the merge with main:

| renderer | snapshot reads | worker statements | bytes cloned per read |
|---|---|---|---|
| main's idle-time poll (fallback) | 4 | 189 | 6,788,600 |
| change-driven (this branch) | 0 | 10 (the change checks) | 0 |

While syncing and draining, the window still reads at most one snapshot every 2 s (the old rate),
and only while something is being written.

Guard: tests/stall-guards.test.ts. It checks that reads never move the change count, and that idle
means no snapshot reads and no worker interval faster than the 1 s change check (only that one
under 30 s). View p99 while syncing and draining is printed against the 100 ms budget and never
gates.

## Ranked findings

1. The 2 s full-snapshot poll (App.tsx:199-206). Fixing it here: change-driven updates.
2. Every command reply carries a full snapshot (packages/core/src/index.ts:1036-1037), so opening an
   item, the command bar, cards and study each build and send 6.4 MB. `origin/wave/backend-0927b`
   (13900a8) already adds an opt-in `reply: "result"` for learning, notes and `ui_event`; the
   command bar (`command`), `pack` and `workspace` still carry the snapshot.
3. Worker blocks during the sync and drain: repeated full `store.resources()` reads in one
   step. `origin/sean/sync-timeout-fix` addresses the access pass (one read per pass, yields
   between courses); `origin/fix/sync-events` 4ca22de does it for the document and course-space steps.
4. Opening an item runs `readLinked` (apps/desktop/src/ingestion.ts:1182), which does a full
   `store.resources()` read to find one source's rows.

## Stall table

| action | measured cost (1,000 resources) | cause | status |
|---|---|---|---|
| window visible, nothing happening | 1 snapshot per 2 to 2.5 s: 46 statements, 56 ms worker, 6.4 to 6.8 MB cloned twice | App.tsx snapshot poll | **fixed here** (b87c447): 0 reads at idle |
| open an item | 6.4 MB snapshot per open, plus a full resource read in `readLinked` | core/src/index.ts final `snapshot()`; ingestion.ts:1182 | snapshot: **fixed on wave/backend-0927b** (`reply: "result"`); `readLinked` full read: **open**, read by source id instead |
| study (learning), notes | 6.4 MB snapshot per request | the same final `snapshot()` | **fixed on wave/backend-0927b** |
| command bar run, prewarm; generate cards (pack); workspace | 6.4 MB snapshot per request; cards 753 statements | the same final `snapshot()` | **open**: extend `reply: "result"` to `command`, `pack` and `workspace` |
| search | 1 MB snapshot per keystroke-search | the snapshot `search` path | **open**: a scoped search query |
| view requests during the first sync | p99 300 to 960 ms; worker blocks up to 400 ms | repeated full `store.resources()` reads inside one sync step | **open here**; the access pass is **fixed on sean/sync-timeout-fix**, the document and course-space steps on **fix/sync-events** (4ca22de) |
| view requests during the job drain | p99 90 to 240 ms (agenda the worst); blocks to 140 ms | several full resource reads per drain slice; agenda does 249 statements | **open**: batch the agenda reads (budgets.test.ts already marks it a TODO) |
| focus / blur | 85 statements, no Canvas request (floored at once a minute) | refresh coordinator `focus()` | fine |
| idle timers | 30 s ticks (ingestion, core, notes), 60 s pipeline, 10 min planning, 1 s change check (this branch) | worker.ts:457-624 | documented cadence; the 30 s ticks read without writing |
| idle CPU | 0.05 to 0.4 s per 10 s, noisy between runs | not attributed | **open** |
| course brief writer | 4 sync fs calls per course during the drain | core/course-facts/brief.ts:275-282 | small; **open**, low priority |

Harness limits: the synthetic first sync here makes 5 Canvas requests (the on-main synthetic university
under discovery and confirmation), so it's lighter than a real first sync. The live-shaped
`sync-account` fixture is on fix/sync-events; switch to it once that branch merges.

## Sean's branches (read, not merged)

- **sean/sync-timeout-fix** (d40eb14, b8820e5): sound. It makes one resource read per access pass
  (indexed by course), yields between courses in inventory, recheckAccess and external, and
  `courseRowIncluded` reads one course row. That gives the same answer as `courseInclusion`,
  because a deleted or missing row falls through to the override or the default in both. The
  second commit adds the abort check after the yield. Its App.tsx in-flight guard is superseded by
  main's snapshot gate and this branch's change-driven reads, so drop that hunk when merging.
  ingestion.ts overlaps fix/sync-events (4ca22de also removes per-course full reads), so expect
  conflicts. Recommend merging it after fix/sync-events.
- **sean/page-scope-clock** (160addc, 61b2a56): sound. The 120 s scope budget now starts when
  the scope's first exchange holds a scheduler slot, so pages queued behind others no longer time
  out unread. A scope stopped while still queued records nothing and keeps its prior state (the
  second commit reverts the `scope_deferred` emit). The run's own signal still bounds a scope that
  never gets a slot. Recommend merging.
