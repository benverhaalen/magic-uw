# Home and visual direction

Updated September 26, 2026. **Current product direction from Ben; latest cohesive Home is the near-approved visual anchor (Ben described it as approximately 95% desired). Remaining local refinements are still under review.** This page supersedes the older neutral/no-serif direction and the unresolved Home/navigation discussion. It does not claim these screens are integrated in the Electron app.

Use the [design system](../DESIGN.md) for the portable visual asset, tokens, component contracts and scoped agent workflow. This page remains the canonical Home product/visual explanation. The recorded 95% is a satisfaction judgment, not a measured image-match threshold.

## The flagship experience

Home is the hackathon flagship. Its job is to demonstrate that Magic understands a student's school context and removes the effort between noticing a commitment and beginning useful work. The differentiation hypothesis is the complete sequence: **connected evidence → useful synthesis → a specific action → the right working context**. Attractive task cards, generic chat, flashcards, or audio by themselves do not demonstrate that advantage.

Normal entry is Home with saved course context already available. The briefing explains what matters now and why; source-shaped action links get the student into the relevant material. Upcoming launches graded work with the right pages/apps. Study & Learn offers specific, already-chosen learning activities from course evidence. Today supplies time context. On return, the student retains their place; verified changes refresh the relevant content without surprising navigation changes.

A representative demo should show a non-obvious requirement recovered from its source, an upcoming class connected to its preparation, and a work item opening its relevant resources. A judge should be able to explain what Magic connected, inspect the evidence, and take the action without assembling the context manually. This is an acceptance target, not a demonstrated result. Do not imply that colors or a model critique prove competitive superiority.

## Settled structure and interaction

- One collapsible left navigation sidebar: Home, Courses with expandable individual courses, My UW with the Wisconsin symbol, and Calendar. Email is deferred. My UW holds planning; consequential holds and enrollment windows also appear on Home. Course overview uses one card per course. Calendar opens to the current week, offers week/month views, and shows suggestions on request; normal content is real commitments and accepted study blocks. See the [review of Sean’s Today rail](design/platform-handoff.md#seans-calendar-work).
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
- Supplied **Lora Medium** at weight 500 (bundled; replaced Cooper Light BT on September 27) for identity, centered page title and selective section/action text, including Briefing, Upcoming and Study & Learn. Ben permits some additional serif in those areas; this is not a heading-only prohibition. The current reference uses **Geist** for prolonged prose, navigation, metadata and controls. Keep readability and cohesion; tracking is flexible, with normal tracking the current baseline. Forrest, Cooper and approximate substitute serifs are superseded.
- No landing-page-sized titles, excessive icons, nested panels, or visual previews. Preserve the agreed structure while transferring design language from references.
- Screenshots look like a MacBook app screenshot. No “concept preview” language inside them. Artifact notes separately disclose scenario and capability limits.
- Private captures, personal-course mock screenshots and the Geist file stay outside this repository. The supplied Lora Medium and its OFL are tracked in `packages/ui/assets/fonts`; Geist production distribution remains a separate decision.

## Earlier visual comparisons — historical proposals

Three card treatments were locally rendered with the same shell and section order. These remain historical comparisons; the latest correction requires clearer deadlines and a flexible, information-bearing briefing:

1. **Course color:** full-width compact colored launch rows. Stable color connects an item to its source-action chips and calendar marks. Risk: lower cards overpower prose. Test whether the briefing remains the first useful read and course identity is understood without relying solely on color.
2. **Action zone:** quiet title area with a more saturated destination/launch zone. The color points toward the action rather than indicating urgency. Risk: the zone looks like a separate required button. Test whole-card discoverability and one-click destination expectations.
3. **Prepared bundles:** two compact graded-work cards expose the assembled resource categories, with the next item below; learning remains a short action list. Risk: more visible resource detail and column scanning steal attention. Test whether users understand what opens with less effort, without losing the briefing.

These were proposals at that stage. Ben subsequently described the latest cohesive Home as approximately 95% desired. Use the [current visual baseline](design/visual-baseline.md), not these older alternatives, for future implementation. Model recommendations and rendered checks are not user preference evidence.

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

The adaptive Home mock was rendered at a 1440 × 900 laptop viewport with the supplied Cooper Light BT (since replaced by Lora Medium) and Geist. It contains flexible source-grounded prose, inline object links, actionable reading/exam routes, contextual handled/undo controls, clearer upcoming deadlines, and a fixed Today rail while the main content scrolls. Browser checks demonstrated assignment link and keyboard navigation, direct route refresh, reading links, handled-state persistence after reload and undo, and Home scroll restoration after returning from an assignment. The calendar stayed fixed while Home scrolled; no horizontal overflow was observed.

Actual Opus 5.5 reviewed the routing alternatives and a rendered screenshot. The driver retained blue plus underline for recognizable clickability; Opus agreed after inspecting the image. Its useful challenges led to contextual detail rather than surprise app launching, source-aware fallback, consistent course color, a neutral cross-course date tag, clearer separation around confirmation controls, and correction of an overlapping calendar time label. This is local prototype evidence, not a student usability test or an integrated app capability. Final visual approval remains with Ben.

## September 26 — action placement, link treatment, and cohesion review

Source: Ben, Magic Canvas design conversation. Recorded September 26, 2026; original message timestamps/IDs unavailable. The following are exact excerpts; the implementation choices below are agent interpretations and review proposals, not blanket approval.

> maybe rather than having the review assigned readings thing on a separate line, have a button on the right side and wrap the text around early. but if a thing has no action, there is no need to have a button or an early wrap.

> then if there is a review button or something and a checkbox, you can split the button in half vertically.

> less of a gap between the sections of it while not making it too much of a blurb of text.

> also is there a more desirable cool ui way to highlight things like "CS639's Next Lecture" while ensuring intuitive ui still sees it as a clickable link

> also for any icons - think canvas or my uw or anything - you can pull these from the sites themselves too.

> i think colored buttons would be cool for the review assigned readings or something making certain actions really clear

> also make sure those link things keep the ui look we have been going for and everything seems consistent. also the buttons for reviewing should have a more cohesive design with the rest of the product

### What these corrections change

- Try right-side action controls beside the associated prose. Reserve that space only when an action exists; informational content retains full width. This supersedes the mock's dedicated action row underneath every actionable paragraph. It does not require every briefing item to have a button or become a card.
- Interpret the vertical split as a shared compact control with review above and an independent student-confirmation checkbox below. Keep distinct hit targets and a visible divider. Clicking review must not check completion; checking must not navigate. This interpretation is awaiting Ben's visual feedback.
- Tighten paragraph spacing while preserving scan boundaries through selective links, filled date tags, and aligned controls. Do not compress the whole briefing into one paragraph or shrink typography simply to fit more content.
- Color should make genuine actions apparent while matching the established material, corner radius, type, and spacing. The latest local proposal uses soft blue gradients and dark text, echoing the existing card family; the earlier saturated solid-blue buttons were revised for cohesion. This is not a new universal button palette or a course/urgency meaning.
- Entity links remain navigation; action buttons initiate the named activity. Compared a lightly highlighted underlined link against a bounded inline chip. The driver favors the inline treatment because it preserves sentence rhythm and distinguishes links from filled time tags; the chip remains a review alternative. Neither treatment has final human approval. Preserve real hrefs, visible keyboard focus, and useful destinations regardless of visual choice.
- Prefer recognizable first-party service assets where available, with recorded source and fit at small sizes. This permission does not require an icon beside every noun. Canvas's official favicon was retrieved from https://canvas.wisc.edu/favicon.ico and used in the local mock. MyUW's favicon was retrieved from https://my.wisc.edu/favicon.ico but is not placed on Home. Do not mistake a university sign-in page's icon for the connected service's icon. Asset availability does not establish redistribution rights for unrelated uses.

### Review and evidence

Local artifacts: `magic-canvas-briefing-inline.html` and `magic-canvas-briefing-pills.html` in Ben's design workspace outputs; screenshots have matching names. These are private review artifacts, not repository assets or integrated production screens. Existing typography, navigation, course content, Upcoming, Study & Learn, and Today structure were preserved.

Actual Claude CLI Opus 5.5 reviewed both first-pass screenshots (model identity verified in local receipt). It preferred inline links, flagged date/link ambiguity and overemphasis, and cautioned about confusing review with completion. Subsequent user cohesion feedback drove the softer action treatment; date tags became consistently neutral and filled, excessive lead bolding and inline chevrons were removed in the preferred alternative. The driver retained the user's shared split-control idea and broad handled wording rather than adopting the reviewer's narrower claim that an exam time was confirmed. These are judgments from screenshots, not evidence of student usability.

Browser verification passed for both alternatives: action beside text; full-width informational paragraph; named-link keyboard activation; readings and exam navigation; separate checkbox behavior; handled state after reload and Undo; assignment route; sidebar collapse; supplied fonts loaded; official Canvas image loaded; no page errors; no horizontal page overflow at 1440, 1280, 1100, and 900-pixel widths. Final screenshots were inspected after initial animation settled. Real multi-app launching, live briefing regeneration, and external completion remain unimplemented in this mock.

## September 26 — familiar icons and cohesion across the whole surface

Source: Ben, Magic Canvas design conversation; recorded September 26, 2026. Original message timestamps/IDs unavailable. Exact excerpts:

> really intuitive familiar icons. less sharp compared to the current ones.

> also make sure borders are all cohesive and such, if there is one, when there is one, etc.

> also something you never noticed. under the courses dropdown, those dont follow the vision the high level the taste.

> with the inline like "tomorrow 1PM" thing id rather that the outline and border extends out of the text line with the text being the same size as everything else.

> also for the study thing at the bottom, we probably know things that users would want to be studying. like an easy one is an exam in a week. you know what they want to study. there are a few different ways to study.

> i want to be able to tweak things in one spot in case things change. but not everything needs to be absolutely abstracted.

> also magic canvas text should be the serif.

> also make the "Home" at the top in cooper.

### Applied interpretations; visual approval pending

- **Recognizable shapes before decoration.** Compared actual Home/sidebar/compose/books/bell SVGs from [Lucide](https://lucide.dev/), [Phosphor](https://github.com/phosphor-icons/core), and [Tabler](https://tabler.io/icons) at toolbar size. Lucide with rounded joins at 1.65 stroke is the current local choice. Its book-open is clearer than its abstract library glyph here. This is a visual match judgment, not identification of Codex's actual library. If small-size recognition suffers, change the glyph within the family before mixing families. Source SVGs and upstream license are retained with the private mock; asset commit recorded there.
- **Interface and provider icons have different jobs.** Use one family for navigation/actions, official recognizable marks for actual app destinations. First-party assets: [VS Code](https://code.visualstudio.com/brand), [GitLab](https://about.gitlab.com/press/press-kit/), and previously recorded Canvas/MyUW favicons. Preserve source/licensing and brand colors; no hand-redrawn product marks. Destination marks do not establish that an app is installed or launch integration exists. Internal card navigation uses a chevron; external references use an outward arrow.
- **A border must explain a boundary.** Current proposal: no extra outline around already distinct colored work/study surfaces; one soft 1px outline around a review control, with one internal divider for independent confirmation; quiet neutral dividers between schedule/task regions; a filled neutral time tag with a fine outline; visible focus rings only when focused. Cohesion means consistent roles, not outlining everything. Keep the user's colored review actions; blue there denotes interaction, not exclusive course ownership.
- **Type and navigation are part of the same product.** Supplied Lora Medium (formerly Cooper Light BT) on the wordmark and centered page title; Geist for readable controls/prose. Time text inherits the surrounding body size, with padding/border extending beyond its baseline. The course submenu now pairs a readable short course name with its code, using the same navigation rhythm and states. Colored dots alone were a weak replacement for meaningful identity. Course selection preserves course identity in the local destination and on refresh.
- **Study selection starts with an actual need.** An approaching assessment is one useful trigger, not the only trigger or a fixed seven-day rule. Select a specific source-backed topic and suitable activity, then offer a ready action. The local comparison offers listening and practice for SQL ahead of the captured Oct 14 midterm. It does not assert verified exam coverage, a known weakness, or generated audio. Mode choice should not become another configuration task. Do not crowd out higher-value needs just to show multiple formats.

### General lesson and modest edit surface

The missed course submenu exposed a scope error: evaluating the edited briefing alone allowed a neighboring surface to drift. For the next change, inspect the affected component **and its siblings, nested states, destination, and return path** at actual size. Apply the same meaning, type roles, icon weight, and boundary rules. Record a real exception with its reason. This is a project-local inference from Ben's correction, not a new global aesthetic prohibition.

Repeated corrections justify a small shared identity/type/palette/radius/border/icon layer. The local mock introduces an app-name value and semantic CSS roles for fonts, control/card/tag radii, quiet/action/tag lines, link ink, focus, and icon weight. Existing course/layout values are not fully refactored. Product implementation should use its established token/component structure; avoid an abstraction for every measurement. Background customization remains deferred. Discuss a broader cohesion mechanism after this visual review, as Ben requested.

### Evidence and limits

Local `magic-canvas-cohesive-home.html` and matching screenshot, rendered at 1440×900 with 2× pixels. Actual Opus 5.5 screenshot review verified in a local model receipt: adopted clearer book icon, stronger submenu metadata, and compacted secondary cards so their source links clear the bottom edge. Rejected a proposed neutral-button reversal because Ben explicitly requested colored actions; retained his serif card direction. Review is expert judgment, not student usability evidence.

Browser checks passed for exact fonts, body-size time tags, loaded assets, right-aligned actions, full-width informational prose, keyboard links, readings/exam/assignment routes, independent confirmation and reload/Undo, individual course identity and refresh, course expansion, sidebar collapse, profile menu, and SQL practice feedback. No page errors or horizontal overflow at 1440/1280/1100/900 widths. This remains a local visual prototype: audio generation, live selection, multi-app launching, and the teammate's newer My UW implementation are not integrated into it. Raw course captures, fonts, screenshots, and CLI logs stay outside Git.

## September 26 — foundation, autonomous refinement and latest scope

Ben selected **“Design foundation and handoff first”** and asked for a repo-specific skill shaped by the accumulated conversation. The [design system](../DESIGN.md) now routes to a synthetic visual reference, semantic token seed, component/state contracts, platform boundaries, selective reference use and independent audit process. These are documented implementation targets; they do not integrate the prototype into production.

Ben’s later assessment — “the thing we made earlier is like 95% of what id want that static home page to look like essentially.” — makes preservation the starting point. Clean rebuild means a fresh implementation from this composition and behavior contract; it does not reopen the aesthetic. Keep exact font roles, hierarchy and current structure while resolving outlined actions/time tags, source-link backing, glyph scale and combined review/handled footprint. Original source: September 27, 2026 at 00:54:50.387 UTC (September 26 in Chicago), decision-record source B:803.

Newest navigation instruction: “on the side with the Home and Courses, My UW, and Calendar should be things too.” This supersedes the previous omission of a separate Calendar destination. Sean’s unmerged code supplies a Today rail; a full Calendar page has not been built. Ben subsequently accepted week/month views with suggestions on request; detailed interactions still require design. Follow the platform review for reusable code and material gaps.

Generation and independent judging may proceed autonomously within accepted intent. Human checkpoints occur for a meaningful new surface/visual family, a first complete coded journey, or a material departure/conflicting opinion. Continue unaffected work while awaiting input. A generated image is not a runtime test; reviewers must receive controlling original excerpts and inspect the actual output. See the [decision record](design/decision-record.md) and [iteration process](../.agents/skills/magic-design/references/iteration-and-review.md).


## Active build correction — recorded September 27, 2026 (original message timestamps unknown)

Ben: “Use My Magic UW”. Visible identity adopts this name, preserving the editorial wordmark face (then Cooper, now Lora Medium)/no logo and stable internal app/user-data identity.

Ben: “you know when a component has like a vertical line on the left side. never do that. also use more color like the original picture”. Remove decorative left-edge accents. Color belongs in the original Home's filled actions, course surfaces and shell gradient; semantic full outlines and calendar grid lines remain useful. Actual-data Upcoming must be compact and meaningfully varied so Study stays visible; do not invent courses or recolor rows by position. See the [decision record](design/decision-record.md).


Home Today correction, recorded September 27 from the active conversation: when there are no known timed commitments, use a small coverage-aware message rather than an empty hour grid. Keep due-today tasks and all-day entries independently accessible. Missing/partial/stale calendars do not establish an empty day; offer recovery only where useful. Full Calendar retains week/month navigation. App-authored UI copy never uses em dashes. Governing rules and superseded examples are tracked in [DESIGN](../DESIGN.md#accepted-corrections-that-govern-current-consumers); actual consumer compliance remains in [adoption](design/adoption.md).
