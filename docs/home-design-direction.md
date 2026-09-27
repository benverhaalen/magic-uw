# Home and visual direction

Updated September 26, 2026. **Current product direction from Ben; visual alternatives are still under review.** This page supersedes the older neutral/no-serif direction and the unresolved Home/navigation discussion. It does not claim these screens are integrated in the Electron app.

## The flagship experience

Home is the hackathon flagship. Its job is to demonstrate that Magic understands a student's school context and removes the effort between noticing a commitment and beginning useful work. The differentiation hypothesis is the complete sequence: **connected evidence → useful synthesis → a specific action → the right working context**. Attractive task cards, generic chat, flashcards, or audio by themselves do not demonstrate that advantage.

Normal entry is Home with saved course context already available. The briefing explains what matters now and why; source-shaped action links get the student into the relevant material. Upcoming launches graded work with the right pages/apps. Study & Learn offers specific, already-chosen learning activities from course evidence. Today supplies time context. On return, the student retains their place; verified changes refresh the relevant content without surprising navigation changes.

A representative demo should show a non-obvious requirement recovered from its source, an upcoming class connected to its preparation, and a work item opening its relevant resources. A judge should be able to explain what Magic connected, inspect the evidence, and take the action without assembling the context manually. This is an acceptance target, not a demonstrated result. Do not imply that colors or a model critique prove competitive superiority.

## Settled structure and interaction

- One collapsible left navigation sidebar: Home, Courses with expandable individual courses, and My UW with the Wisconsin symbol. Email is deferred. My UW holds planning; consequential holds and enrollment windows also appear on Home. Course overview uses one card per course.
- Home content order: **Briefing → Upcoming → Study & Learn**. The briefing is the focal point. Home may scroll vertically.
- Explicit exception to the earlier no-right-column rule: a quiet right-hand **Today** calendar. Today’s tasks and their times anchor at the top right; a readable hourly lecture/event timeline anchors at the bottom right while the main Home content scrolls. It is not a second navigation sidebar.
- Compact native Mac/Codex-like window. Traffic controls, history arrows, sidebar toggle, and context-aware new-chat control live at the top. Current page name is centered.
- Magic Canvas wordmark has no logo yet; its ellipsis shares the brand row. Bottom-left profile shows avatar and name when expanded, avatar alone when collapsed, with an account popover.
- Clicking Upcoming should open the relevant Canvas page, readings, notes, and needed apps/windows together. Assignment-specific destination icons may communicate this. Do not add a mandatory intermediate chooser or expansion.
- General Magic chat knows the originating page and relevant course context.

## Briefing content contract

Natural language, not “Today's agenda,” a marketing greeting, or a reformatted to-do list. Choose useful information from available schedules, assignment instructions, linked materials, announcements, and explicitly connected communications. Explain dependencies, meaningful changes, consequential requirements, conflicts, and preparation needs. Facts must earn their space: merely reciting assignment metadata or inventing a headline does not create useful synthesis. A source being absent or unreadable cannot imply the student has nothing else to do.

The briefing is flexible prose, not a mandatory series of cards, headings, time groups, or action buttons. Short blurbs are not a fixed requirement. Some days contain many updates; some useful information needs no action. Group related information naturally and let information importance determine emphasis and length. A headline, when used, must name the actual course, requirement, or consequence. Rejected examples include “One template for the whole team” and “Check the essay’s submission format”: they withhold the specific information a student needs. Do not hide critical conditions behind Details toggles.

The lead should demonstrate connected evidence, for example an upcoming lecture plus its specific assigned readings plus the reason to prepare, with an immediate route to those materials. Another useful case is a verified conflict across course schedules. A generic greeting, schedule paraphrase, or manufactured insight is not sufficient for the hackathon entry screen. Never turn an optional reading into a required reading or imply reading is unfinished without evidence.

Use selective bolding and **filled-background time/date tags** for scanning. Keep emphasis consistent rather than combining many competing highlight styles. Deadlines in Upcoming must be plainly visible, not tiny or low contrast. Calendar hour labels, event names, start/end times, and locations must be readable at a laptop viewport.

Each region has a distinct job: Briefing explains implications/preparation/changes; Today locates today’s tasks and events in time; Upcoming makes graded work ready to launch; Study & Learn starts specific learning activities. Avoid repeating the same fact/action merely to fill every region. A current proposal shows today’s due items once in Today and future graded work in Upcoming, with chronological labels and complete access via View all. This specific allocation remains under visual review.

Keep source-shaped links right aligned near the claim. Labels describe the action, such as “Review assigned readings,” rather than merely naming Canvas. Every AI reference should expose its supporting source; provenance inspection and refresh information must remain available without overwhelming the main prose.

### Clickable references and useful destinations

Ben wants named items in briefing prose, such as an assignment or a specific lecture, to be immediately identifiable as clickable. A link should resolve to the actual source object; do not make an uncertain title match look verified. Link the first useful mention, not every repeated course code. Preserve readable prose and avoid adding a sentence just to exhibit a link.

Current treatment under review: blue underlined inline links, real hrefs, keyboard activation, and a visible focus ring. Underline supplies a non-color cue. Do not style static time tags like links. The exact treatment is a local mock, not an approved universal token system.

Routing rule proposed from the product goal and expert review:

- **Named object: inspect.** Open useful context in the existing pane: relevant requirements, due/source time, source freshness, supporting material, and direct original-source links. Keep the source object identity through refresh. Return to the prior Home position and preserve confirmations.
- **Verified original with no useful cached detail:** go directly to the original with an external-link affordance; avoid an empty intermediary screen.
- **Explicit action: do.** “Review assigned readings” opens the assigned materials; an explicit work-launch action opens the prepared work set. Preserve the previously requested one-click Upcoming launch, rather than requiring a new chooser. The local mock only demonstrates routes/resource links, not real multi-app launch.
- **Uncertain match:** retain the uncertainty and resolve it before presenting an apparently authoritative destination.

A noun should not unexpectedly launch several applications. Conversely, do not force someone who explicitly chose to start work through a detail screen. Upcoming's destination icons and whole-row action must make its launch intent clear; do not nest a competing title link inside a clickable row.

The local Persona example exposes the actual instruction: one completed team template, a shared grade, and Word upload or a publicly shared Google Doc URL. It does not merely repeat the deadline in Today. Showing this requirement does not authorize the app to change sharing or submit coursework. The detail route preserves the original Canvas page and assigned template.

### Student confirmation and briefing memory

The student can check off a specific actionable issue in the briefing, such as having handled an exam conflict. Keep this a small contextual control, not a checkbox on every informational sentence. A suggested label is “I’ve handled this.” Provide an immediate undo/reopen path. Retain the issue’s source links and a concise handled state rather than losing its context.

A student confirmation is an explicit **self-report**, separate from source-verified completion. Remember it across briefing regeneration using the underlying issue identity and relevant source version, so paraphrasing the briefing does not recreate the task. Suppress repeated prompts for that handled issue. Reopen only when material new evidence changes the situation, with a clear explanation; do not silently uncheck it on every refresh. Marking a conflict handled does not change a university schedule, submit a form, or prove an alternate exam arrangement was approved. A confirmed reading can be recorded as reported read; it still does not prove understanding.

Do not infer reading completion from a view. Homework, projects, grades, or submissions are weak evidence of understanding. Direct study interactions supply the most useful learning evidence, with assistance and uncertainty retained. No invented mastery, readiness score, or completion claim. Points from different courses are not comparable course weights. Preserve source timezone and distinguish due dates, events, lock dates, and conflicting claims.

## Upcoming and Study & Learn

Upcoming primarily contains graded/weighted assignments, exams, and similar commitments. Keep the cards flat, compact, and actionable. No screen/window previews. Where an assignment requires multiple resources, select the set from actual evidence and known user tools; don't imply a local environment is verified when it is only suggested.

Study & Learn contains concrete activities already chosen for the student: a particular explanation to hear, concept to practice, or question to work through. Use source-specific titles and reasons. No generic class-by-class menu, minute toggles, quiz/podcast thumbnails, or fake learning-history claims. The latest request favors smaller action cards so the briefing keeps priority.

## Settled visual constraints

- Warm ivory main pane, bold ember/red sidebar and a thin wrapping frame; gradients welcome. Compact borders and comfortable interior spacing.
- Color should feel deliberate and distinctive. More vibrant cards are the current exploration. No predominantly green direction. The earlier restriction to only minor blue notes is superseded: stronger blue accents are welcome alongside the warm shell. Purple remains restrained. Color must preserve text contrast and carry a consistent meaning.
- Background/shell color should eventually be customizable in Settings; this is an accepted future design direction, not an urgent implementation task. Preserve contrast and semantic distinction under customization.
- Exact supplied **Cooper Light BT** in private mocks for selective headings and action titles; **Geist** for prose, navigation, metadata, and controls. Readability and cohesion take precedence over negative tracking. Normal tracking is the current baseline. Forrest and approximate substitute serifs are superseded.
- No landing-page-sized titles, excessive icons, nested panels, or visual previews. Preserve the agreed structure while transferring design language from references.
- Screenshots look like a MacBook app screenshot. No “concept preview” language inside them. Artifact notes separately disclose scenario and capability limits.
- Supplied font files, private captures, and personal-course mock screenshots stay outside this repository. Production font selection/distribution remains a separate decision.

## Current visual comparison — proposals

Three card treatments were locally rendered with the same shell and section order. These remain historical comparisons; the latest correction requires clearer deadlines and a flexible, information-bearing briefing:

1. **Course color:** full-width compact colored launch rows. Stable color connects an item to its source-action chips and calendar marks. Risk: lower cards overpower prose. Test whether the briefing remains the first useful read and course identity is understood without relying solely on color.
2. **Action zone:** quiet title area with a more saturated destination/launch zone. The color points toward the action rather than indicating urgency. Risk: the zone looks like a separate required button. Test whole-card discoverability and one-click destination expectations.
3. **Prepared bundles:** two compact graded-work cards expose the assembled resource categories, with the next item below; learning remains a short action list. Risk: more visible resource detail and column scanning steal attention. Test whether users understand what opens with less effort, without losing the briefing.

These are proposals, not a chosen winner. Ben may reject all three or combine useful properties. Model recommendations and rendered checks are not user preference evidence.

## Professional references and transfer limits

Inspected September 26, 2026. Official product pages and their actual product imagery were reviewed; this was not a logged-in usability study. No reference implementation code was copied.

| Reference / job | Observed mechanism | Proposed transfer, condition, and failure test |
| --- | --- | --- |
| [Craft Plan](https://www.craft.do/plan) — contextual actions | Tasks live with their document context; the daily note brings writing and schedule context together. Product imagery uses restrained content surfaces. | Keep reason/source close to the briefing action and show a small prepared resource set. Reject if this produces nested containers or a document editor on Home. |
| [Things features](https://culturedcode.com/things/features/) — progressive detail | Compact to-dos reveal optional detail when needed; calendar commitments remain distinguishable from tasks. | Keep launch rows short and expose secondary destination names on hover/focus or in the work context. Do not copy an expansion step that would block the authorized one-click launch. Reject if hidden details make destination choice ambiguous. |
| User's Codex screenshots — shell behavior/appearance | Top controls, collapsing navigation, thin wrap around main pane, bottom profile popover. | Preserve compact familiar navigation and inspect both expanded/collapsed states. Reject if a second nav strip or oversized chrome appears. |
| User's Apple Calendar day screenshot — timing structure | Hour lines, timed event blocks, current-time line. | Quiet Today rail with deadlines above events. Reject if its visual weight exceeds the briefing or incomplete data implies a free day. |
| User's refined warm/red references — palette/material preference | Concentrated warm color and restrained typography. | Compare stronger card color within the existing structure. Do not import marketing heroes, page layouts, or unrelated features. |

Actual Claude CLI **Opus 5.5** participated in an independent critique and follow-up debate. Useful challenges included preserving briefing focus, including consequential submission details, and explaining each source action. The driver rejected comparing raw points across courses, mandatory row expansion, and nested card frames. Rendered screenshot review was completed with the actual model. It preferred time anchors, but Ben subsequently rejected always splitting the briefing into fixed units; that correction takes precedence. The layered alternative also incorrectly placed an unrelated project beneath a team-template heading, illustrating why visual grouping must preserve meaning. Treat on-paper Canvas metadata as a listed submission type, not proof that a student must print or physically hand in something. Do not infer that differing lecture/project topics mean the lecture is irrelevant. New flexible-briefing work is under review; no student usability result is claimed.

## Cumulative intent and ongoing UI review

Ben explicitly asked that every UI revision combine the project goal, the general guiding principles, current shared documentation, and the full sequence of relevant course corrections. The latest prompt steers the work; it does not erase earlier compatible decisions. Infer the intended outcome from that combined context rather than applying isolated requests as a series of cosmetic patches.

Before substantial UI work or resuming a design thread, fetch remote changes and inspect the affected documentation, implementation status, and local work. Pull compatible upstream changes when safe; preserve teammates’ uncommitted changes and resolve consequential conflicts before building on a stale assumption. Check again before publishing shared documentation. Keep these checks proportionate to material revisions, not every small edit.

Use [Product brief](product.md), [Agent work principles](agent-work-principles.md), and [Reference-driven design](reference-driven-design.md) together with this page. Preserve a correction’s reason, scope, and what would make us revisit it. Explicit newer decisions supersede older conflicting proposals; examples and tentative ideas do not silently become universal requirements. Raise genuine conflicts rather than choosing whichever document was read last.

For each material revision, connect the changed treatment to the student journey and inspect the actual default screen and relevant interaction. For Home, success means the student can see a useful course-specific implication, understand its evidence, take the next step, and correct or confirm the state with little effort. A visually polished screen or expert agreement alone does not establish that result. Use relevant previous chats when needed to recover intent or the reason for a correction; keep historical proposals distinguishable from current decisions and avoid unrelated private context. Continue bounded discussion with actual Opus 5.5 on consequential UI/UX choices and rendered audits, verifying model identity and integrating critiques with independent judgment. Expert preference never overrides Ben’s direction or substitutes for user evidence. Ask focused questions when uncertainty would materially change the experience, using a concrete artifact or tradeoff where possible; make routine choices autonomously from the shared intent. Record what is accepted, proposed, rendered, tested locally, and integrated; update affected docs and push shareable decisions so teammates can follow the direction.

## Delivery and team synchronization

Ben asked for continuing updates and pushes so teammates can follow direction. Update this canonical page and the affected decision/status entries after material corrections and completed review rounds. Separate accepted direction, proposals, rendered prototypes, and integrated capability. Commit only documentation authorized for sharing; keep raw captures, credentials, coursework, private research, and licensed font assets out of Git.

Current work is a separate local visual prototype with navigation and mock interactions. It does not demonstrate live multi-app launching, generated audio, live briefing refresh, or a connected AI chat. The production capability inventory remains [Implementation status](implementation-status.md).


### Latest local audit — September 26

The adaptive Home mock was rendered at a 1440 × 900 laptop viewport with the supplied Cooper Light BT and Geist. It contains flexible source-grounded prose, inline object links, actionable reading/exam routes, contextual handled/undo controls, clearer upcoming deadlines, and a fixed Today rail while the main content scrolls. Browser checks demonstrated assignment link and keyboard navigation, direct route refresh, reading links, handled-state persistence after reload and undo, and Home scroll restoration after returning from an assignment. The calendar stayed fixed while Home scrolled; no horizontal overflow was observed.

Actual Opus 5.5 reviewed the routing alternatives and a rendered screenshot. The driver retained blue plus underline for recognizable clickability; Opus agreed after inspecting the image. Its useful challenges led to contextual detail rather than surprise app launching, source-aware fallback, consistent course color, a neutral cross-course date tag, clearer separation around confirmation controls, and correction of an overlapping calendar time label. This is local prototype evidence, not a student usability test or an integrated app capability. Final visual approval remains with Ben.
