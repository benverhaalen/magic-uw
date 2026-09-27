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
