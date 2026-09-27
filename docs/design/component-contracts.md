# Component and interaction contracts

Version 2. These are implementation recipes and acceptance targets, not claims of working components. Consult the baseline for appearance and current Home direction for product semantics. Begin with these recurring roles; extract reusable code when two real uses need the same behavior. Avoid a universal component framework.

## Atomic structure

**Foundations → controls → meaningful compositions → complete journeys.** Shared foundations: identity, typography, ink/surface/semantic color, border roles, radius, spacing and focus. Controls: button, link, disclosure, time tag, provider mark, confirmation. Compositions: shell navigation, briefing passage with optional action, work row, study action, Today event. A page assembles these according to its goal. Every composition owns its state contract as well as appearance.

| Recipe | Appearance and meaning | Interaction / edge conditions |
| --- | --- | --- |
| App shell | Thin warm gradient wrap, ivory work surface; one collapsible sidebar; compact top controls, centered Cooper page title; profile bottom | Home/Courses/My UW/Calendar. Collapse preserves route and course expansion; keyboard focus stays on the toggle. Icon-only controls retain accessible names/tooltips. History controls reflect real history. Compose opens a new context-aware Magic chat using the current page and permitted course context; unavailable capability is disclosed. The reference bell is illustrative until its destination and state are defined; it must not imply implemented notifications. Website does not copy Mac window buttons. |
| Course navigation | Coherent short title + secondary code, same active/hover/focus grammar as siblings | Expand is distinct from course navigation. Long names wrap or truncate with accessible full name; no typography from a different product inside the dropdown. Zero, many, hidden and unavailable courses are meaningful states. |
| Briefing passage | Readable prose, selective emphasis; optional colored action at right; no-action text uses full width | Entity links inspect the correct object/source. Explicit verbs act. Evidence and freshness remain inspectable. A named entity must not unexpectedly open many apps. Mixed information lengths do not create mandatory boxed rows. |
| Time tag / entity link | Tag text inherits prose size, filled background extends around text; entity has recognizable link affordance | A time label is not a button unless it actually navigates. Link supports keyboard/focus and a useful destination. No hover-only critical evidence. Outline/link backing remains a local refinement, not a universal ban. |
| Review + confirmation | A coherent action region, separate review and handled controls, quiet internal division when needed | Clicking review never checks handled. Confirmation explains local self-report, persists by issue and source version, supports Undo. Material new evidence can reopen with reason; copy regeneration alone cannot. Focus survives update. |
| Upcoming work row | Flat colored surface, selective Cooper title, readily seen due date/time, small authentic destination marks | Whole-row launch must communicate what opens. Preserve one-click prepared work; no nested competing buttons. Show partial launch failure per destination and retry only failures. Do not imply installed tools or correct resource matching without evidence. |
| Study action | Specific already-chosen activity and reason, clear typographic action, compact vibrant surface | Start the selected useful activity. An exam in a week can justify source-grounded practice without invented mastery. No generic class menu, minutes selector or quiz/podcast thumbnail. If unavailable, explain and offer an actual alternative. |
| Today / Calendar | Deadline and timed-event distinctions; readable hours; consistent course/source identity | Home is today's projection. Calendar defaults to the current week, offers week/month views and shows suggestions on request through an easy-to-find action with relevant context already supplied; normal content is commitments and accepted study blocks. Same underlying records and confirmed plan state in both; partial coverage is not a free day. Preserve source timezone, all-day semantics and overlapping events. |

## State and return contract

For each consequential interaction write a compact specification:

`entry + user intent → activation/feedback → destination/resource identity → preserved state → refreshed data → completion/correction → failure recovery → observable check`

Representative journey: saved Home → named lecture → relevant requirements and assigned material → source/readings → Back to the same briefing place. Preserve semantic anchor plus offset, keyboard focus, selected course, useful drafts and local confirmations. Revalidate changed facts without jumping the reader or reshuffling an active selection. Do not discard draft/state by accidentally changing a component's identity. If the target was removed, explain and return to the nearest useful context rather than opening a similarly named item. A network failure leaves saved evidence usable with honest freshness.

For a work-launch action, prepare the verified destinations before activation; after activation show which opened, which failed and how to recover. Returning to Magic restores the originating context. Opening does not prove the work was completed. School submission/enrollment stays outside the app's authorized capability boundary.

Keep domain evidence, student confirmations and view state distinct. A completed source assignment, a locally completed work item, an acknowledged conflict and demonstrated understanding are different facts. Do not overload one generic `complete` operation.

## Minimum states to inspect where relevant

- Default entry, populated, no data, loading, stale/partial and recoverable error.
- Hover, focus, pressed, disabled and keyboard activation; focus return after a menu/dialog.
- Long course/title, unbroken source label, dense day, no action, several related insights, no study recommendation.
- Refresh during reading, edited deadline, removed source, interrupted launch, repeated clicks and Undo.
- Narrow laptop width, zoom/enlarged text, reduced motion and collapsed sidebar.

Use synthetic cases. Vision catches hierarchy/wrapping/material inconsistency; DOM/accessibility inspection catches semantics and focus; deterministic checks catch IDs, time handling and persistence. Run only the cases affected by the change plus a representative sibling and return path. A screenshot cannot establish these behaviors.

## Visual states and motion

Use [Foundations](foundations.md) for color, boundary, icon, focus and motion rules. The recipes above specify which states and return behavior need those treatments.

## Shared evidence reference — every AI surface

Applies to Briefing, course/detail summaries, Study, chat and My UW whenever AI refers to a source-backed object or assertion. Choose the correct role:

- **Named object:** recognizable link to the exact course, assignment, lecture or resource context.
- **Evidence:** compact source affordance exposing title, source, relevant excerpt/location, captured/updated time and uncertainty where material. It may accompany the named link without creating two indistinguishable actions.
- **Work action:** explicit verb describing what starts or opens. An action label such as “Review assigned readings” is not merely a citation to the Canvas homepage.

These share a visual family but not a generic click handler. Preserve keyboard semantics, visible link recognition and a useful destination. A source missing or changed after generation retains its identity and explains the limitation; never substitute a similarly named item. Unsupported inference is labeled as inference and cannot acquire a fabricated citation. Expose evidence on demand to preserve glanceability; do not require hover. Permission-sensitive content remains subject to the app's existing access boundary.

**Acceptance example:** the same assignment appears in Home prose, a course page and chat. All three resolve to the same source object/version; a changed deadline is represented consistently, and Back restores the originating surface. This is a required integration check, not currently demonstrated by a static mock.

## Courses overview and course detail

Prefer one card per course, following Ben's Canvas reference while using Magic's material/type language. The card identifies the course with a concise readable name and code and supplies one meaningful current cue when supported. Opening it goes to that course's working context; do not turn every card into a duplicated Home briefing or infer mastery from a grade. Full official identity remains available in detail. There is no mandatory grade/progress ring.

Keep course identity stable across card, sidebar, event and assignment. The dropdown must be a sibling of the same design system, including hover/focus/selection. Expansion and navigation are distinguishable controls. Empty enrollment, long names, many courses and partial capture need usable states. Preserve saved courses while a capture is partial. A stale course can still open saved evidence with an honest freshness label.

Course detail gives the student course-specific work/material context and useful evidence access. Its exact page composition is provisional; do not freeze a new layout based only on this paragraph. A representative transfer trial is overview → course → assignment/source → Back, checking the selected card, semantic scroll anchor and focus. Keep domain identity and view state outside display copy.

## Time-aware briefing — synthetic scenario, not a clock-only algorithm

Inputs: a verified 2:30 lecture; explicitly assigned reading linked to it; source freshness; upcoming graded work; known typed-note preference only if the student supplied it. Before class, a useful passage can state the lecture time and offer “Review assigned readings.” Near class, it can offer opening the relevant notes when that matches the student's habit. The reading remains accessible; merely reaching 2:30 or opening its link never marks it read. A changed lecture time uses fresh evidence and does not silently discard an active review.

The system selects the useful implication and action from available evidence and preferences, rather than displaying every input. Unknown preference or missing reading association must not become invented certainty. An informational advisor update may need no button. This scenario makes the flagship intelligence testable without forcing every briefing into the same three rows.
