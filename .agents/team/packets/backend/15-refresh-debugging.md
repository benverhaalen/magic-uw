# Why the app shows no new information after a pull (debugging)

Human owner: Nathaniel. Agent: Claude Code lead. September 27, 2026. Base: main `5372c5a`. Status: diagnosis for Ben's runs, from the code on main and today's measurements. The fixes are in flight (listed below).

Nathaniel asked: "If someone has the app open and pulls, why is Ben's version still not pulling new info." Two different things can be meant by "pull". Check them in this order.

## 1. `git pull` while the app is open: the running app keeps the old build
- `pnpm dev` builds once, then Electron loads `apps/desktop/dist`. Nothing watches the source or reloads it.
- After a pull: quit the app, run `pnpm install` if `pnpm-lock.yaml` changed, then `pnpm dev` again. Main, the worker and the renderer all load only at start.
- Your branch `codex/desktop-design-integration` doesn't contain today's backend fixes (below), so pulling it alone won't bring them.

## 2. The app refreshing Canvas and nothing new arriving (the four causes on main)
| Cause | What you'll see | Check | Fix (status) |
|---|---|---|---|
| **The worker is blocked by a first sync of many courses.** Before today it did one full `store.resources()` decode (sqlite plus inflating every payload) per course space, and never yielded | screens hang; "Local workspace request timed out"; refresh does nothing for minutes | the Sources page's last-sync time doesn't move; the worker's CPU sits near 100% | Sean's `sean/sync-timeout-fix` (max blocked gap 94 s → 1.4 s on 24 synthetic courses); our `fix/sync-events` (the workspace decoded once per step); `fix/nonblocking-jobs` (derivation 20.8 s → 0.5 s, longest stall 336 → 49 ms). None is on main yet |
| **Old and irrelevant courses are read.** Completed enrollments and nameless date-restricted rows were requested and counted "partial" | many courses in Sources, some "name unavailable"; long syncs | count the courses in Sources vs your schedule | `fix/current-courses-only`: enrollment from Course Search & Enroll decides this term; nameless rows are never stored. In the integration PR |
| **The UW session expired.** Canvas returns sign-in pages | Sources shows "needs sign-in" | Sources › UW Canvas status | sign in again; "Remember my sign-in" (#40) can fill it once per expiry |
| **Refresh only rechecks on a timer, and a relaunch re-read everything** | a change appears only after 5 min (to-do list) or 15 min (course content); a due date moved outside the to-do window waits for the 6 h full read; every launch re-reads everything (283 requests, 70 s, synthetic) | the last-sync time vs when the change happened | `fix/sync-events`: baselines kept across launches (a relaunch goes 283 → 8 requests); manual refresh probes first (283 → 47). Under review |

## What would help us pin your case
Send Nathaniel the Sources page line for UW Canvas (the status plus the last-synced time), how many courses it lists, and whether the window froze. That tells us which row above it is.
