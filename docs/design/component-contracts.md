# Magic product and interaction contracts

Version 3. This page binds the [reusable recipes](component-recipes.md) to Magic's student workflows. These are requirements and acceptance examples, not claims of working production components. Appearance uses [foundations](foundations.md); the [coverage map](system-coverage.md) records what has actually been demonstrated.

## Complete interaction contract

For each consequential journey specify:

`normal entry + intent → activation/feedback → exact destination/resource → preserved state → refreshed facts → completion/correction → failure recovery → observable check`

Keep domain evidence, student confirmation and view state distinct. A source-completed assignment, local work completion, handled conflict and demonstrated understanding are different facts. Do not expose one generic `complete` operation for all of them. A source version change invalidates dependent conclusions until checked; missing, partial and conflicting sources must not collapse into an empty/successful state. The interface does not imply an exam blueprint, mastery model or grade predictor from ordinary course data.

For navigation, preserve semantic anchor plus offset, keyboard focus, selected course, useful drafts and local confirmations. Revalidate changed facts without jumping the reader or reshuffling an active selection. Stable object IDs survive changed display copy. If a target disappears, explain and return to useful context; never substitute a similarly named item. Network failure keeps saved evidence usable with honest freshness.

## Shared evidence reference — every AI surface

Applies to Home, course/assignment detail, Study, chat and My UW whenever AI refers to a source-backed object or assertion (D18).

| Role | Meaning and destination | Required distinction |
| --- | --- | --- |
| Named object | Recognizable link to the exact course, assignment, lecture or resource context | Must not unexpectedly launch several apps. |
| Evidence | Inspect title, source, relevant excerpt/location, captured/updated time and material uncertainty | Expose on demand through keyboard/click, never hover alone. Unsupported inference cannot acquire a fabricated citation. |
| Work action | Explicit verb names what starts or opens using the assembled context | “Review assigned readings” must reach the useful material, not a generic Canvas homepage. |

These can share a visual family while retaining separate handlers and semantics (R1/R2/R5). Permission-sensitive information follows existing access boundaries. If a source changes or disappears, retain identity and explain what cannot currently be supported. **Integration acceptance:** the same assignment in Home prose, course detail and chat resolves to the same object/version; a changed deadline is consistent across all three; Back restores each origin. A static mock cannot demonstrate this. Course summary dates use `courseDeadlineDisplay`: a disputed date keeps its ordering value but shows “Dates disagree” in the date position, without confirmed-date urgency. Same-object copies retain their conflict and evidence; Next up offers “Review dates” through the existing resource destination.

## Surface bindings

| Binding | Composition and accepted requirement | Behavior and recipe mapping |
| --- | --- | --- |
| Desktop shell | Thin warm wrap, ivory open pane; one collapsible sidebar; My Magic UW at the far left of the top bar, followed immediately by sidebar toggle, new conversation, Back, Forward; centered Karma Medium page title; profile at bottom | Home/Courses/My UW/Calendar; preserve course expansion and route on collapse, focus stays on toggle. Back and Forward appear only when useful in actual history; introduce/remove them gently, keep route-restored focus, otherwise transfer focus from a disappearing focused action to a remaining history action or compose, and remove travel for reduced motion. Hidden course children reserve no vertical space; collapsed navigation retains even row rhythm and the full profile target. Expanded navigation starts close beneath the top bar. Top-right authentication/status stays anchored without moving workspace content. An optional bottom conversation launcher sits outside workspace scrolling; clearance follows its rendered height only while mounted. Compose creates a context-aware Magic chat with permitted page/course context or explains unavailability. The bell (far right of the chrome) opens a nonmodal anchored panel: unread urgent and important count, Urgent in words, rows routed by stable ID to item, course, Outlook or Sources; Escape and focus departure close it and return focus to the bell. R1/R5/R7; window chrome is desktop-only. |
| Home Briefing | Most important cross-source implications first; readable prose and selective emphasis; optional right action region; no-action text gets full width | Named entities inspect context, explicit verbs act, evidence/freshness stay available. No mandatory cards or buttons per insight. R1/R2/R6. This hierarchy is Home-specific. |
| Review and local confirmation | Coherent action region with separate review and handled controls, quiet division when useful | Review never checks handled. Confirmation explains student report, persists by issue/source version and supports Undo. Material new evidence may reopen with a reason; regenerated wording alone cannot. Preserve focus. R2/R6; combined geometry remains a comparison (D12). |
| Home Upcoming | Compact flat colored graded-work rows, selective Karma Medium title, visible deadline and small authentic destination marks; no decorative previews | One-click prepared work launch, with destinations clear before activation. Verified resources/capabilities only; report partial failure per destination and retry only failures. Return restores origin; opening proves no completion. R1/R3/R6. |
| Home Study & Learn | Specific already-selected useful activity with a reason, compact vibrant surface and clear action | Start the selected source-grounded activity. The supporting Home row context is a verified date only, without clock time or extra course/topic/format metadata; omit when unknown. Put source detail and rationale in the opened workspace or associated evidence disclosure. No generic course menu, minutes selector or quiz/podcast thumbnail. An approaching exam can justify practice without invented mastery. Explain unavailability and offer a real alternative. R1/R2/R6. Session composition remains to be designed. |
| Home Today | Separate right-side timing context; readable hours when timed commitments exist; distinguish deadlines from timed events | Same underlying records and confirmed plan state as Calendar. No timed commitments: replace Home’s empty hour grid with a compact coverage-aware message, retaining due-today tasks and all-day entries. Show recovery only for missing/incomplete/stale coverage; never imply those states are a verified free day. Full Calendar keeps week/month grids. Preserve timezone and overlapping events. R8. Responsive placement must retain access. |
| Calendar | Current week by default; week and month views; normal content is commitments and accepted study blocks | Suggestions on request, easy to discover with context supplied. No silent insertion or automatic suggestion flood. “Suggest study time” is a proposed label, not exact approved copy. Density/overlap, proposal acceptance and narrow layouts still need demonstration. R1/R5/R8. |
| Courses overview | Prefer one card per course (D19), readable concise name + code, one useful current cue if supported | Stable course identity across sidebar/card/event/assignment. No mandatory progress ring or grade-to-mastery inference. Handle zero/many courses, long names and partial capture without deleting saved courses. R3/R6/R7. |
| Course/assignment detail | Course-specific requirements/materials and source access, using the shared language | Exact composition is provisional. Distinguish course navigation from expansion; dropdown uses sibling typography, hover/focus and selection. Preserve full official identity in detail. Overview → course → assignment/source → Back is the transfer journey. R1–R3/R5–R7. |
| Public website | Explain the product and provide legitimate download/GitHub access | Use Magic type/material/action roles with website navigation/footer and real URLs. It inherits no student source state, desktop window controls or fake installed capability. Branding divergence with Aiden needs human resolution. R1/R3/R7; actual transfer remains evidence-dependent. |

My UW's first useful task, chat's complete session layout and broader settings remain underspecified; do not invent their primary product requirements to fill a template. Use R4/R5 when an authorized concrete form/task calls for them. School submission and enrollment remain outside the app's authorized capability boundary.

## Current correction gates

No consumer may use decorative left-edge accent stripes or app-authored em dashes. Use semantic shared tokens and filled action/course surfaces for the richer Home reference color; do not assign color by list position to fake variety. These rules supersede conflicting older examples. Course labels retain stable account/course identity behind a concise structured display projection; see [content design](content-design.md). Existing font, glyph, geometry, focus and evidence constraints still apply.

## Representative Home journey and time-aware case

**Journey:** saved Home → named lecture → relevant requirements/assigned material → source/readings → Back to the same briefing place. This tests the intended understand → inspect → begin → return benefit. The work action prepares and verifies the required destinations before activation; success/failure concerns opening those destinations, not learning completion.

**Synthetic time-aware scenario:** a verified 2:30 lecture, explicitly associated reading, current source state and graded work are known. Before class, explain the relationship and offer “Review assigned readings.” Near class, opening relevant notes may be useful if the student supplied that habit. The reading remains accessible. Reaching the lecture time or opening the link never marks it read. A changed lecture time refreshes its facts without discarding an active review. Unknown preference or missing association stays unknown. An advisor update may need no action. These inputs test useful selection; they do not impose a clock-only algorithm or three-row template.

## Inspect the affected states

Use synthetic cases in development; their fixture identity belongs in the evidence path. Inspect only the changed family, its real consumers, a representative sibling and return path:

- Normal entry/populated, no data, loading, stale/partial/conflicting and recoverable failure where the capability produces them.
- Hover, focus, pressed, unavailable and keyboard activation; overlay dismissal and focus return.
- Long course/title, unbroken source label, dense day, no action, several related insights and no study recommendation.
- Source/version change during reading, removed source, interrupted launch, repeated activation, failed save and Undo.
- Narrow window, enlarged text, reduced motion when animated and collapsed navigation.

Visual inspection checks hierarchy/wrapping/materials; DOM and keyboard inspection check semantics and focus; deterministic domain checks establish IDs, time handling and persistence. Verify the actual integration before claiming the complete journey. Static links do not need fictional network state machinery to satisfy this list.

### Conversation action boundary (September 27, 2026)

Ben confirmed in the active desktop build conversation: “Navigate immediately; confirm consequential changes.” Internal navigation may proceed directly from a clear request. A consequential mutation needs the concrete target and effect presented for confirmation before dispatch. Draft origin and destination remain captured across page changes; sending accepts the text synchronously and opens its chat, with pending/failure shown there. This does not grant school submission/enrollment or prove voice/external control exists. Current text Chat reads saved coursework; real microphone and external Stop are separate unfinished capabilities.

### Default account image · September 27

Use the existing cardinal wizard head from `marketing/logo/head-color.svg` as the default profile image, including sample mode. Preserve its aspect ratio inside the 32px avatar; do not substitute the full wizard or place a logo beside the app title. A future explicit custom account photo takes precedence; the current renderer has no verified custom-photo DTO.
