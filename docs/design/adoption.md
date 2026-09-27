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

Change the canonical rule, implementation and affected example together. Preserve existing enforceable boundaries when propagating a correction. Apply the [current hard constraints and reference direction](../../DESIGN.md#accepted-corrections-that-govern-current-consumers), then inspect actual authored copy, source-derived labels, filled color/compactness and empty/partial/stale schedule states. A literal scan is useful for authored punctuation but cannot establish source fidelity or visual adoption. Recheck real consumers of changed roles and a representative sibling. For the [September 27 uniform Geist correction](decision-record.md#uniform-geist--september-27-2026), require computed 400/normal plus loaded Geist across app-authored text, including shared controls, semantic emphasis, menus and late-integrated pages; retain Karma Medium 500 and inspect native/200% metadata readability. Repeated exceptions indicate a missing or unsuitable recipe to investigate, not a reason to add blanket prohibitions. Agent entry files link here rather than restating every rule.

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

Consumers: Home named objects use EvidenceLink with exact ID/hash and internal resource route; detail uses Action/Disclosure; PersonalReport adapts Confirmation to the durable typed command. Shell/Home geometry stays local; all roles/colors use canonical shared tokens. Historic Lucide 0.468.0 lab vendor nodes retain ISC attribution in `docs/design/lab/vendor/LUCIDE-LICENSE`; current consumers use the MIT licensed Hugeicons free Stroke Rounded mapping in `packages/ui/src/glyph.tsx` and `packages/ui/LICENSE.icons`. At that historical checkpoint both fonts were private runtime assets; Karma Medium and Geist with their OFLs are now bundled.

Observed: hidden native Electron at 1440×900 with synthetic isolated SQLite; exact Cooper Light/Geist loaded (pre-Lora receipt); Home → resource requirements/related material → Back restores originating link/action focus. Native original-source action fails honestly in headless mode; successful external browser opening is unverified. A narrow 980×650 run restored exact workspace scroll/focus, sidebar collapse focus and My UW route. A 200% root-font check had no horizontal overflow; this is not an OS zoom test.

Report verification: handled → Undo → handled → Electron restart retained the report without changing local completion or source submission. Changing only an independent calendar resource hash reopened the issue while assignment hash stayed fixed. The test explicitly prepared accepted same_as links with core `linkExactEvidence` in an isolated synthetic database; the subsequently integrated Start Work leaf now refreshes exact links during ingest. Renderer evidence mapping and eight durable backend tests passed. Private harness/captures stay outside Git.

Further checkpoint: real captured-course SQLite copy rendered in hidden native Electron (2,123 resources, 39 course records across terms, 272 sources with partial/inaccessible coverage). Original store and consent preserved; only isolated inspection onboarding presentation state bypassed. Exact private fonts loaded. Named detail/Back focus demonstrated. Native snapshot took 9.673s including queued startup/reload reads; performance is not solved. Startup extraction now yields and batches access lookup; polling coalesces slow reads and invalidates snapshots across result-bearing and void mutations.

Start Work is integrated in detail and flat Upcoming rows using one shared engine. Exact prepared destinations are visible before direct activation; pending/receipt/failure/retry are siblings of the row button. Rendered native synthetic verification passed visible prepared destinations → single-click dry-run receipt → same Home row focus. Pending activation uses aria-disabled plus an in-flight guard so focus survives. Headless native launch guard and preview-hash validation pass; successful external opening remains unverified. Independent visual review identified real remaining product gaps.

Historical checkpoint limits above are superseded where the September 27 integration evidence below closes them. Still remaining: useful briefing/study synthesis, compact course/task variety, duplicate-link return anchors, Today date projection/evening range, report/action proportions, full course visual calibration, production font distribution and successful external app launch. This does not establish whole-app completion.


### September 27 integration correction propagation

| Rule | Consumer | Evidence / remaining |
| --- | --- | --- |
| My Magic UW; exact Karma Medium/Geist required; no decorative left accents | DesktopShell, Home, course detail | Native real-copy Home/course/detail inspected with loaded Cooper/Geist and canonical tokens before the September 27 Lora change; incoming course styles use the same roles. Subsequent native Home/Calendar and web/lab checks loaded the then-current Lora Medium file. Karma adoption remains to be checked after integration; earlier receipts establish only prior font adoption; Home content corrections and further course visual calibration remain pending. |
| Stable course identity and return | Desktop navigation + course cards/sidebar/work rows | Native 6-course A→B→Back A and item→detail→Back preserve identity, scroll, focus and module/past disclosures. Conservative shared course-label projection now binds actual course resource/source; raw title remains available. Duplicated captured work still needs shared identity projection. |
| Canonical evidence and private student reports | queries resourceViews + PersonalReport + storage | Tests cover prose/calendar hash changes, excluded/inaccessible evidence, CAS/Undo/restart and AI/MCP omission. Desktop does not infer submission, reading or mastery. |
| Empty Home schedule; honest coverage | TodayRail compactEmpty from Home only | Unit coverage distinguishes absent/partial/stale/healthy/all-day; full Calendar behavior unchanged. Hidden native synthetic healthy-empty Home verifies no grid, no recovery filler and retained due region. Healthy state has no recovery button. Saved coverage older than 24 hours is labeled potentially stale. |
| No authored em dashes | Desktop renderer and shared React literals | Literal scan contains none; core/domain remaining matches are source-parsing regex, not authored copy. Raw course/source evidence is preserved; shared conservative course-label projection is integrated; other raw source-derived display handling remains pending. |
| Richer anchor color and concise source-derived labels | Home and course projection | Canonical rules now govern selection and actual-surface critique. Actual-data Home still has repetitive tall work rows and weak synthesis. These consumers are not adopted as final merely because the rules were updated. |

Pinned main integration includes canonical learning and prepared Start Work. Real-copy snapshot timing remains about 7.6 seconds, so IPC trimming and yielding are not a complete performance claim. No live external launcher, production-font distribution, terminal native flow or school write is demonstrated by this checkpoint. Private screenshots and coursework remain outside Git.


Calendar week/month is now connected to the normal sidebar and per-entry history. Native real-copy checks verify full resource detail/return, expanded-day state/focus, explicitly accepted study blocks after restart and removal/Undo. Shared label projection is connected to course cards/page/sidebar and Calendar, while Home adopts it in its separate leaf. Full course visual calibration remains pending: missing-fact density and duplicate assignments still weaken the experience. No paper compliance replaces rendered comparison with the original Home anchor.

### Chrome correction adoption gate · 2026-09-27

For changes to shell/control consumers, follow the [latest correction](../../DESIGN.md#september-27-2026--chrome-and-control-correction). Record native-size before/after, normal/hover/keyboard-focus, pending/cancel/error and secondary text readability. Check actual computed glyph size/stroke, stable hit target and shell recovery width, and Geist400/normal with Karma500. Keep any unrendered consumer explicitly pending; a token update alone does not establish its adoption.
