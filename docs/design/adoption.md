# Design-system adoption

The working agreement for UI builders and integrators. No CI, hooks, watchers or global configuration. Use shared implementation where it fits; evidence of use matters more than an acknowledgement.

## Before building

1. Read the current `magic-design` entry, then only the affected recipe and [shared component contract](../../packages/ui/README.md). Inspect actual imports/usage before creating another implementation.
2. Name the normal entry, useful action, return path and relevant source/state semantics. Record the system Git revision and owned files in the existing task handoff.
3. Reuse applicable exports and canonical tokens. Keep page geometry and domain adapters local. For a missing pattern, implement the smallest complete example; do not force a mismatched component or copy the exploratory Home CSS.

## Before handing off

Inspect the actual rendered result and exercise the changed interaction, a relevant recovery/return and one affected sibling. An existing test can supply evidence; a tiny static change only needs its appropriate visual check. New component families or consequential changes warrant a fresh independent review. A reviewer must distinguish a taste proposal from a bug and from an untested concern.

Use this small block in the existing PR/task handoff rather than a new report per edit:

```text
System revision: <Git SHA used>
Consumers: <real import/use locations and reused components/tokens>
Exception/new pattern: <none, or reason + scope + owner + revisit trigger>
Observed: <render/state/journey checked, evidence location>
Remaining: <unverified integration or human decision>
```

The integrating agent inspects the claimed consumer and evidence before recording adoption. A lab example, written instruction or agent acknowledgement alone does not establish real-app adoption. If two people disagree, quote the relevant original decisions and ask them directly; continue unaffected work.

## Keep corrections connected

Change the canonical rule, implementation and affected example together. Recheck real consumers of changed roles and a representative sibling. Repeated exceptions indicate a missing or unsuitable recipe to investigate, not a reason to add blanket prohibitions. Agent entry files link here rather than restating every rule.

Already-running sessions refresh changed guidance at natural boundaries and before shared-interface changes/integration. Pulling alone does not reload instructions. One integrator owns shared contract/token edits; feature agents keep their main task and use bounded handoffs.

## Current consumers

| Surface | Implementation source | Adoption/evidence |
| --- | --- | --- |
| HTML component lab | Canonical tokens + isolated vanilla recipes | Audited reference; not a consumer of the new React package. See direct-source audit. |
| React adoption example | `packages/ui/examples/adoption.tsx` imports `packages/ui/src` and its styles | Executable integration example; verification recorded below. Synthetic/in-memory. |
| Desktop shell, Home and resource detail | `Home.tsx`, `App.tsx`, `PersonalReport.tsx`; canonical styles imported once by `main.tsx` | Integrated on the desktop design branch: EvidenceLink, Action, Disclosure and Confirmation. Native synthetic verification below; other operational pages remain partial. |
| Public website | Existing informational site | **Pending.** May consume tokens/behavior contracts without introducing React. Verify its actual framework first. |

Update a row only when an actual consumer and its evidence change. This is a compact dependency map, not a claim to have designed every future screen.

## Verification of this adoption layer

Verified September 26, 2026 (America/Chicago), against the source added with this agreement:

- Focused TypeScript check (`tsc -p packages/ui/tsconfig.json --noEmit`) and esbuild example bundle passed.
- Local Chromium: confirmation → Tab → Undo restores checkbox focus; source v2 is unchecked while the v1 report remains recorded. Native disclosure opens by keyboard.
- Popover focuses the first link; Escape returns to its trigger; Tab departure dismisses. At 360px width with 200% root text, the panel remained inside the viewport and the page had no horizontal overflow.
- Evidence-link keyboard activation reached the exact `#source` anchor, focused that target and did not mark anything handled.
- Saving snapshots the submitted note; subsequent edits are excluded. Reset during save discards the stale UI result.
- A separate Jev-dispatched Claude Sonnet 5 read-only review inspected the components and routing docs. Its pending-checkbox concern was **not reproduced** in the actual React build: checked and unchecked pending examples retained state and emitted zero changes after click and Space. Review agreement alone is not verification.

The example is synthetic and in memory. Persistence, production routing/return restoration, desktop integration and website adoption remain unverified. Target-browser compatibility beyond the tested Chromium also remains a consumer responsibility. No claim of production adoption or automatic enforcement.

## Desktop integration checkpoint

System revision: `ddf93e9` shared foundation, renderer checkpoint `cb65496`, personal-report backend integrated as `fbdd0cc`. Scope remains the isolated desktop design branch.

Consumers: Home named objects use EvidenceLink with exact ID/hash and internal resource route; detail uses Action/Disclosure; PersonalReport adapts Confirmation to the durable typed command. Shell/Home geometry stays local; all roles/colors use canonical shared tokens. Lucide 0.468.0 glyph nodes retain attribution in `packages/ui/LICENSE.icons`. Licensed font binaries remain private runtime assets, not repository files.

Observed: hidden native Electron at 1440×900 with synthetic isolated SQLite; exact Cooper Light/Geist loaded; Home → resource requirements/related material → Back restores originating link/action focus. Native original-source action fails honestly in headless mode; successful external browser opening is unverified. A narrow 980×650 run restored exact workspace scroll/focus, sidebar collapse focus and My UW route. A 200% root-font check had no horizontal overflow; this is not an OS zoom test.

Report verification: handled → Undo → handled → Electron restart retained the report without changing local completion or source submission. Changing only an independent calendar resource hash reopened the issue while assignment hash stayed fixed. The test explicitly prepared accepted same_as links with core `linkExactEvidence` in an isolated synthetic database; current import does not automatically call that helper. Renderer evidence mapping and eight durable backend tests passed. Private harness/captures stay outside Git.

Remaining: actual-course visual review, Start Work integration, independent review, complete briefing/study selection, full Calendar week/month, current course/learning reconciliation, production font distribution and successful external app launch. Calendar currently exposes the existing Today rail only. This checkpoint does not establish whole-app completion.
