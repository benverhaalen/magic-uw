# Home handoff: Today rail ready for review

Updated: September 26, 2026 (evening). Human owner: Sean. Agent: Claude Code (Opus 5.5). Branch: `sean/today-calendar-rail`, merged with main at `973be53`, head `62de5c0`; open as [PR #2](https://github.com/benverhaalen/magic-uw/pull/2) (mergeable, not merged). Recipient: Ben, as Home owner. Status: implemented and tested with synthetic data; not validated on a live UW feed or with students.

## Scope

The quiet right-hand Today rail on Home: due-today items, all-day and timed events with a current-time line, and suggested prep/work/exam-review blocks placed in free time. Students accept, skip, or edit a block from a hover toolbar; study blocks can be marked done. Assignment blocks cross out only when Canvas reports the submission. The synthetic sample course now moves onto the local today when loaded. Ownership split per Sean: **the rail is Sean's; building the designed Home screen is Ben's.**

## Update: built to Ben's design docs

Per Sean ("build based on bens design docs, agree to what he has"): suggestions now appear **on request**; normal rail content is commitments and accepted blocks. `projectWork(resources, now, timeZone)` in `@magic/domain` sorts open work once into overdue / dueToday / upcoming, and the rail reads it, so **Home's Upcoming should read `upcoming`** to keep one identity. Platform-review notes addressed: planned vs. suggested minutes separate, honest prep wording, per-source freshness and qualified empty states, clickable class blocks. New: published **Outlook calendar** meetings (Teams-labeled, location kept, communications category); bridge `setOutlookCalendar(url|null)` / `outlookCalendarStatus()`. `pnpm test:desktop` now passes (it had hard-coded a 2-item sample).

## Interfaces others will touch

- `@magic/domain`: `buildTodayRail(resources, now, timeZone, plan)`, `effortBand`, `gradeShare`, `planEntry`, `validatePlanEdit`.
- `@magic/contracts`: `dayPlanEntrySchema` / `DayPlanEntry`; `Store.dayPlan()`, `setDayPlanEntry()`, `removeDayPlanEntry()`; `Snapshot.dayPlan`; commands `day-plan` and `day-plan-remove`.
- Storage: one local `preferences` entry, `dayPlan` (14 days, cleared by Delete local data). **No schema version change**, so planning migrations are untouched. Never enters hosted context, Jev, local tutoring, or MCP.
- `@magic/core`: `rebaseFixture` (sample course only); optional `timeZone` core option.
- Renderer: `apps/desktop/src/renderer/TodayRail.tsx`, mounted as the third column of the Home layout; styles appended at the end of `styles.css` (`/* Today rail */`, `.rail-*`). `App.tsx` passes `plan={snapshot.dayPlan}` and `onPlan`.

## Decisions for Ben

The suggestion rules (priority tiers, effort ranges, 3 h cap, cross-out rules) are recorded in [decisions](../../../../docs/decisions.md#2026-09-26--today-rail-suggestions-and-day-plan) as **proposed for review, not accepted direction**. Open: styling within the Home visual direction (the rail uses current neutral styles), whether the cap/cutoff become settings, and multi-day planning.

## Next useful action

Ben: review and merge PR #2 when convenient, then keep `TodayRail` in the new Home and restyle the `.rail-*` classes. Sean has a local HTML prototype of the rail inside the Home design (not in the repo) to share on request. If this conflicts with Home plans, tell Sean directly.

## Evidence

297 automated tests, typecheck, desktop build, and the hidden Electron check pass on the branch. A headless browser drove real mouse events through hover → accept → edit → skip and confirmed the saved plan in core; a synthetic Canvas re-import crossed out the accepted block. See [implementation status](../../../../docs/implementation-status.md#verification) on the branch.

This packet is removed by the [release cleanup](../team/3-release-cleanup.md) before September 27, 11 a.m. Central; PR #2 remains the durable record.
