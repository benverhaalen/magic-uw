# Home handoff: Start work bridge for Upcoming

Updated: September 26, 2026 (late evening). Human owner: Ben. Agent: Claude Code (Opus 5.5). Branch: `feat/start-work` from main `90137f0`. Status: implemented and checked with synthetic data and dry runs; not merged; real desktop opening not yet demonstrated.

## Scope

One-click prepared work for an assignment (feature #1 from the September 26 feature inventory). Canonical status and limits: [implementation status](../../../../docs/implementation-status.md).

## Interfaces others will touch

- `window.magic.startWork(assignmentId, only?)` → `WorkLaunchReceipt` (`opened`, `failed`, `held`, `notes`, `mode`). `only` narrows a retry to failed resource IDs; it can never add targets.
- Core command `{ type: "work-set", id }` → `CommandResult.workSet` (`items` in open order, `held` suggestions/overflow, `notes`). Use it to show destinations **before** activation, per the Upcoming-row contract.
- `apps/desktop/src/renderer/StartWork.tsx` is self-contained (prepared list, activation, receipt, retry) and currently mounted in the assignment detail pane.

## Next action for the Home implementer

Wire the Home Upcoming whole-row action to `startWork(resource.id)` and show the receipt near the row (or reuse `StartWork`). Keep the named-object → inspect vs. explicit action → do rule from [Home direction](../../../../docs/home-design-direction.md#clickable-references-and-useful-destinations). Do not add a chooser.
