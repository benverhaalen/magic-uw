# Home and visual direction

Updated September 26, 2026. **Current product direction from Ben; visual alternatives are still under review.** This page supersedes the older neutral/no-serif direction and the unresolved Home/navigation discussion. It does not claim these screens are integrated in the Electron app.

## The flagship experience

Home is the hackathon flagship. Its job is to demonstrate that Magic understands a student's school context and removes the effort between noticing a commitment and beginning useful work. The differentiation hypothesis is the complete sequence: **connected evidence → useful synthesis → a specific action → the right working context**. Attractive task cards, generic chat, flashcards, or audio by themselves do not demonstrate that advantage.

Normal entry is Home with saved course context already available. The briefing explains what matters now and why; source-shaped action links get the student into the relevant material. Upcoming launches graded work with the right pages/apps. Study & Learn offers specific, already-chosen learning activities from course evidence. Today supplies time context. On return, the student retains their place; verified changes refresh the relevant content without surprising navigation changes.

A representative demo should show a non-obvious requirement recovered from its source, an upcoming class connected to its preparation, and a work item opening its relevant resources. A judge should be able to explain what Magic connected, inspect the evidence, and take the action without assembling the context manually. This is an acceptance target, not a demonstrated result. Do not imply that colors or a model critique prove competitive superiority.

## Settled structure and interaction

- One collapsible left navigation sidebar: Home, Courses with expandable individual courses. Course overview uses one card per course.
- Home content order: **Briefing → Upcoming → Study & Learn**. The briefing is the focal point. Home may scroll vertically.
- Explicit exception to the earlier no-right-column rule: a quiet right-hand **Today** calendar. Due items and their times sit above an hourly lecture/event timeline. It is not a second navigation sidebar.
- Compact native Mac/Codex-like window. Traffic controls, history arrows, sidebar toggle, and context-aware new-chat control live at the top. Current page name is centered.
- Magic Canvas wordmark has no logo yet; its ellipsis shares the brand row. Bottom-left profile shows avatar and name when expanded, avatar alone when collapsed, with an account popover.
- Clicking Upcoming should open the relevant Canvas page, readings, notes, and needed apps/windows together. Assignment-specific destination icons may communicate this. Do not add a mandatory intermediate chooser or expansion.
- General Magic chat knows the originating page and relevant course context.

## Briefing content contract

Natural language, not “Today's agenda,” a marketing greeting, or a reformatted to-do list. Choose useful information from available schedules, assignment instructions, linked materials, announcements, and explicitly connected communications. Explain dependencies, meaningful changes, team/submission conditions, and preparation requirements. A source being absent or unreadable cannot imply the student has nothing else to do.

Keep source-shaped links right aligned near the claim. Labels describe the action, such as “Review assigned readings,” rather than merely naming Canvas. Every AI reference should expose its supporting source; provenance inspection and refresh information must remain available without overwhelming the main prose.

Do not infer reading completion from a view. Homework, projects, grades, or submissions are weak evidence of understanding. Direct study interactions supply the most useful learning evidence, with assistance and uncertainty retained. No invented mastery, readiness score, or completion claim. Points from different courses are not comparable course weights. Preserve source timezone and distinguish due dates, events, lock dates, and conflicting claims.

## Upcoming and Study & Learn

Upcoming primarily contains graded/weighted assignments, exams, and similar commitments. Keep the cards flat, compact, and actionable. No screen/window previews. Where an assignment requires multiple resources, select the set from actual evidence and known user tools; don't imply a local environment is verified when it is only suggested.

Study & Learn contains concrete activities already chosen for the student: a particular explanation to hear, concept to practice, or question to work through. Use source-specific titles and reasons. No generic class-by-class menu, minute toggles, quiz/podcast thumbnails, or fake learning-history claims. The latest request favors smaller action cards so the briefing keeps priority.

## Settled visual constraints

- Warm ivory main pane, bold ember/red sidebar and a thin wrapping frame; gradients welcome. Compact borders and comfortable interior spacing.
- Color should feel deliberate and distinctive. More vibrant cards are the current exploration. No predominantly green direction, primary blue, or primary purple; blue/purple may be minor gradient notes.
- Exact supplied **Cooper Light BT** in private mocks for selective headings and action titles; **Geist** for prose, navigation, metadata, and controls. Readability and cohesion take precedence over negative tracking. Normal tracking is the current baseline. Forrest and approximate substitute serifs are superseded.
- No landing-page-sized titles, excessive icons, nested panels, or visual previews. Preserve the agreed structure while transferring design language from references.
- Screenshots look like a MacBook app screenshot. No “concept preview” language inside them. Artifact notes separately disclose scenario and capability limits.
- Supplied font files, private captures, and personal-course mock screenshots stay outside this repository. Production font selection/distribution remains a separate decision.

## Current visual comparison — proposals

Three locally rendered alternatives preserve the same shell, briefing, Today rail, and section order:

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

Actual Claude CLI **Opus 5.5** participated in an independent critique and follow-up debate. Useful challenges included preserving briefing focus, including consequential submission details, and explaining each source action. The driver rejected comparing raw points across courses, mandatory row expansion, and nested card frames. Further screenshot review and Ben's preference are still required.

## Delivery and team synchronization

Ben asked for continuing updates and pushes so teammates can follow direction. Update this canonical page and the affected decision/status entries after material corrections and completed review rounds. Separate accepted direction, proposals, rendered prototypes, and integrated capability. Commit only documentation authorized for sharing; keep raw captures, credentials, coursework, private research, and licensed font assets out of Git.

Current work is a separate local visual prototype with navigation and mock interactions. It does not demonstrate live multi-app launching, generated audio, live briefing refresh, or a connected AI chat. The production capability inventory remains [Implementation status](implementation-status.md).
