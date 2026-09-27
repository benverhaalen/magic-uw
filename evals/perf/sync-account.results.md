# Canvas sync: before and after (fix/sync-events)

`pnpm magic:perf --suite sync` (evals/perf/sync-account.ts): the whole desktop ingestion on a
synthetic account shaped like the operator's live one: 6 current courses, 12 organization
shells, 10 concluded and 7 nameless restricted rows; ~700 items, ~250 files, 50 modules; the
Files tab hidden on 4 courses and the Pages list on 3; every request held 150 ms. Base:
`fix/current-courses-only` (`9e7aeea`). Windows laptop, CPU shared with other builds, so wall
times are high and noisy; request counts are exact. September 27, 2026.

Requests per trigger:

| Scenario | Before | Step 1 | Step 3 | Step 4 |
|---|---|---|---|---|
| First sync after sign-in | 721 | 721 | 721 | 721 |
| Manual refresh within a minute | 283 (full) | 283 (full) | 47 | 47 |
| Second launch within the window | 283 (full) | 8 | 8 | 8 |
| Steady hot tick | 8 | 8 | 2 | 2 |
| App focus (content probe) | 147 | 147 | 41 | 41 |
| A due date moves (to-do item) | not reached* | 93 (1 course) | 39 (1 course) | 39 (1 course) |
| Manual refresh (steady) | 283 (full) | 283 (full) | 47 | 47 |
| Six-hour backstop | 283 | 283 | 177 | 177 |
| URLs read twice in one run | 6-26 | 6-26 | 0 | 0 |

Wall time (ms, latency model):

| Scenario | Before | Step 4 |
|---|---|---|
| First sync: agenda usable (all 6 courses' assignments) | 2,479 | 2,143 |
| First sync: page text usable | 6,014 | 5,752 |
| First sync: files done | 70,914 | 22,898 |
| First sync: whole run | 126,022 | 31,262 |
| Derivation after the first sync (core drain) | 13,049 | 10,696 |
| Manual refresh within a minute | 96,389 | 10,286 |
| Second launch within the window | 70,068 | 2,759 |
| App focus | 60,076 | 7,628 |
| Six-hour backstop | 106,674 | 16,659 |

\* The harness's background tick landed before the jittered hot interval, and the changed
assignment was outside the to-do window; both fixed in the harness before step 1's run.

Steps: 1 persisted refresh baselines (`0a3b455`); 2 manual refresh probes first (`8ae3f02`,
measured with step 3); 3 no URL twice per run, no unchanged file re-checked per probe
(`d782281`); 4 one workspace decode per step instead of per file or course space (`4ca22de`).

What caused the slowness: every launch and every refresh button press was a full re-read
(baselines lived in memory; manual always meant full); ICS feeds and hidden-list page bodies
were read twice per run; files behind a hidden Files tab were re-checked on every probe; and
about 1,000 full `store.resources()` decodes per first sync (access checks per course space,
inclusion and row lookups per file) cost ~95 s of CPU. With latency 0 the first sync went from
99-124 s to 21 s of CPU.

Not in these steps: a due date outside the to-do/upcoming window is still only caught by the
backstop or a course's warm read (the change-event queue and targeted reads, drafted, would read
each current course's assignment list on a manual refresh); a moved to-do item still warm-reads
its whole course (39 requests) instead of the one assignment.
