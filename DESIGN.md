# My Magic UW design system

Version 3 · September 26, 2026 · Component system candidate; foundation palette/type accepted (D27). Evidence for rendered components and transfer lives in the [coverage map](docs/design/system-coverage.md); a rule is not proof of implementation.

Magic helps students understand what matters, inspect the evidence, and begin useful work without assembling the context again. Its cohesive Home establishes the visual language. The original image collections helped establish that language; expert references now improve specific interaction and craft gaps within it. [D24 and the original decisions](docs/design/decision-record.md) govern this interpretation.

## What travels, and how far

| Layer | Keep | Adapt |
| --- | --- | --- |
| Reusable experience principles | Clear hierarchy, recognizable actions, honest state, recoverable changes, continuity, readable density | Apply to the audience and task; the principles do not prescribe a student dashboard everywhere. |
| Magic identity across surfaces | Lora Medium (500) / Geist roles, Lucide, warm outer material with ivory content, deliberate blue and colorful action/identity surfaces, restrained boundaries | Desktop extensions retain the actual fonts, Lucide glyphs, sidebar construction, shell gradient and corner treatment; task content can vary within that frame. A public website uses its own composition. Lora Medium and Geist ship from `packages/ui/assets/fonts` with their OFLs; the site's remaining branding difference is unresolved. |
| Product/page requirements | Home's briefing-first composition, flat Upcoming, specific Study actions and separate Today; desktop navigation; evidence and completion semantics | Keep explicit choices on their named surfaces. Courses, assignment detail, chat and website each need their own useful hierarchy. |
| Platform implementation | Same role meanings, resource identity, behavior and visible state | Use the actual framework's routing, semantics, focus, persistence and capabilities. Electron window controls belong only in the desktop adapter. |
| Ben's broader taste | Familiar operation, controlled distinctiveness, compact readability, consistency, assembled context | These are provisional preference hypotheses for unrelated projects, not a global serif/ember/sidebar brand. Revalidate against their users and brief. |

## Principles that decide a design

| Principle | Producing decision | Observable check |
| --- | --- | --- |
| Organize around the next useful understanding or action | Choose what must be noticed first, what can wait, and which context the action needs. Omit unnecessary controls. | At normal entry, the intended audience can identify the point and next step without a narrator. |
| Make meaning and operation legible | Differentiate object links, commands, selection and status. Color reinforces those meanings; wording and semantics carry them. | Keyboard and pointer users can predict what will happen, including in nested navigation and muted states. |
| Reveal enough evidence to judge a claim | Keep source identity, uncertainty and freshness available where they affect a decision. Preserve distinctions between observed, inferred and self-reported facts. | Missing, changed and conflicting inputs produce visibly different outcomes; attractive copy never implies unsupported certainty. |
| Preserve the user's place and ability to correct | Design return, reversal and interrupted work alongside the happy path. | Back restores useful context; failure preserves input; Undo changes the intended fact only. |
| Let density follow relationships | Use alignment, type and spacing before adding enclosure. Keep associated content close and unrelated tasks distinct. | Long content, no-action content and narrow layouts remain readable without shrinking the text or adding a card to every sentence. |
| Make consistency inexpensive to maintain | Reuse semantic values and recurring recipes; compose each page for its job. | A shared role change reaches its real consumers; new surfaces do not need copied page CSS or a second palette. |

These principles are working design rules, not measured claims about student outcomes. The [foundations](docs/design/foundations.md) apply them to the settled language; [recipes](docs/design/component-recipes.md) turn them into bounded reusable families; [product contracts](docs/design/component-contracts.md) bind them to Magic's facts and journeys.

## Authority and calibration

Current explicit human direction controls, followed by accepted decisions, the cohesive Home anchor with its recorded exceptions, and the system's rules and semantic tokens. Expert guidance supplies a mechanism for an identified gap; it cannot replace the language through a library preset. Conflicting human direction requires a concrete resolution, not an agent vote. Continue unaffected work.

The Home anchor is approximately 95% desired as a static screen in Ben's judgment. That establishes strong visual authority without approving every detail or state. Link backing, action/tag outlines, glyph scale and review/confirmation proportions remain comparisons. Preserve the original anchor; version refinements separately.

Before presenting a new desktop family as Magic, demonstrate the identity in code against the actual Home reference: loaded Lora Medium/Geist, real Lucide glyphs, the matched sidebar, shell treatment and curves. Approximate serif lettering, generic icons and a vaguely warm palette do not pass this gate. Generated images can explore a component but cannot establish exact typography or icon fidelity. Use the matched desktop context when judging shell relationships. Standalone component and foundation sheets are appropriate for bounded details; they do not prove whole-frame fidelity.

Calibrate a useful subset of typography, materials and recipes through **intended image → extracted roles/relationships → fresh component code → rendered comparison and interaction checks**. Then test a related surface from a fresh description without supplying its bespoke layout or the old Home CSS. A copied Home cannot establish transfer. New features may extend the first version as their needs become clear; all future screens need not be specified now. See the [image-to-code sequence](.agents/skills/magic-design/references/image-to-code.md).

## Accepted corrections that govern current consumers

Recorded September 27, 2026 from the active build conversation; exact quotes and scope are in the [decision record](docs/design/decision-record.md#current-desktop-corrections--recorded-september-27-2026-original-message-timestamps-unknown).

- **Hard constraints:** visible name My Magic UW; no decorative left-edge accent stripes; no em dashes in app-authored UI copy. Preserve raw source evidence separately. Calendar grid separators and semantic full outlines are not accent stripes.
- **Reference-judged direction:** restore the original Home’s richer filled colors and warm gradient through meaningful identity, action and compact content selection. Arbitrary positional recoloring or higher saturation alone does not satisfy this direction. Compare the actual Home reference at the normal viewport.
- **Uniform interface typography:** “ensure the whole app only uses one font weight and spacing etc for geist. keep it consistent” (Ben, September 27, 2026). All app-authored Geist uses the canonical 400 weight and normal letter spacing, including controls, metadata, menus, notices and semantic emphasis. Role sizes and line heights remain distinct; Lora Medium remains 500. See the [record and adoption gate](docs/design/decision-record.md#uniform-geist--september-27-2026).
- **Editorial face:** supplied Lora Medium at weight 500 replaces Cooper in the same roles across app, website, lab and marketing drafts; Geist, geometry and branding are unchanged ([record](docs/design/decision-record.md#editorial-face--recorded-september-27-2026-original-message-timestamp-unknown)). Earlier Cooper captures are not Lora evidence.
- **Content and behavior:** audit source → structured projection → UI. Preserve raw titles and stable account/course identity while selecting concise labels. Home’s empty day uses a small honest message instead of an empty hour grid; due-today tasks and all-day entries stay independently accessible. Partial or stale coverage must not imply a free day. The full Calendar retains its week/month structure.

These corrections supersede any older examples showing accent stripes, authored em dashes, an always-visible empty Home hour grid or the former visible brand. They do not relax Lora Medium/Geist, Lucide, geometry, keyboard/focus, evidence or capability rules. Uncorrected consumers remain pending in the [adoption record](docs/design/adoption.md), regardless of passing documentation review.

## Read only the relevant packet

| Need | Specification |
| --- | --- |
| Identity and visual comparison | [Visual baseline](docs/design/visual-baseline.md), [tokens](docs/design/tokens.css), [foundations](docs/design/foundations.md) |
| Organize information or generate interface copy | [Content design](docs/design/content-design.md) |
| Inspect working foundations and components | [Foundations gallery](docs/design/lab/foundations.html), [component lab](docs/design/lab/index.html) |
| Build a recurring UI family | [Component recipes](docs/design/component-recipes.md) |
| Connect UI to Magic behavior | [Product and interaction contracts](docs/design/component-contracts.md) |
| Understand what is demonstrated | [Surface and evidence map](docs/design/system-coverage.md), [current validation](docs/design/validation-v3.md) |
| Begin a component implementation | [Compact v3 handoff](docs/design/handoff-v3.md) |
| Adapt to a framework or website | [Platform handoff](docs/design/platform-handoff.md) |
| Resolve product scope or provenance | [Home direction](docs/home-design-direction.md), [product](docs/product.md), [decision record](docs/design/decision-record.md) |
| Apply expert help to a specific gap | [Reference selection](docs/design/reference-selection.md), [source adapters](.agents/skills/magic-design/references/source-adapters.md) |

## Adoption in code

Use the [adoption agreement](docs/design/adoption.md) and [shared React patterns](packages/ui/README.md). The consumer map distinguishes examples from production use. Both agent entry points route here; no CI or hooks enforce it.

## Evolve while features proceed in parallel

Start with the audience, normal entry/default state, useful outcome and one complete journey. Choose the nearest recipe and state its domain binding. Reuse stable roles; keep page geometry local. A new family or consequential taste choice warrants a concrete comparison with Ben; routine fixes within accepted direction do not.

One integrator owns a shared token/contract edit at a time. Workers name their system revision and own bounded surfaces; inspect relevant upstream changes before integration. A contribution records changed rule/recipe, affected consumers, before/after evidence and remaining uncertainty. Review its actual dependents and a representative sibling, not every unrelated screen.

Use distinct claims: **proposed**, **accepted direction**, **demonstrated in isolation**, **integrated**, and **demonstrated in the real journey**. A passing screenshot does not prove source correctness, accessibility, framework portability or teammate adoption. Keep the smallest useful evidence and repair the producing rule when observed use contradicts it.

## September 27, 2026 · chrome and control correction

Latest user correction: “actually, decrease icon border outline size, increase the corner rounding of them a bit while also increasing the icon sizes.” This supersedes the earlier smaller-glyph direction. Glyph geometry is separate from the hit target: shared control/navigation glyphs are 18px, trailing glyphs 16px, and stroke is 1.35; existing comfortable button areas remain. Normal and hover feedback must not thicken icon outlines. Controls use 10px corners; this does not redefine card or pane shapes. Keyboard focus retains its distinct 2px outline.

Ben also asked: “ensure font color is consistent or at least has a hierarchy.” Use primary, prose, secondary, and action ink roles; keep metadata readable instead of fading it. The shell is a deeper red with a 6px outer perimeter. Preserve saturated coursework colors, Geist400/normal, and exact Lora Medium500. A restrained shadow identifies filled actions; quiet text actions and ordinary navigation stay flat.

The shell Canvas recovery action is white, visibly `Sign in to` followed by the official Canvas mark, accessible name `Sign in to Canvas`. Reuse the existing MIT Instructure asset and notice; pending labels reserve the same width. Global feedback stays compact in the red shell with details on demand, preserving dismissal and typed sign-in outcomes.

Home follows: “put horizontal lines that separate briefing from upcoming from study and learn similar to how the vertical line looks on the right hand side.” Use the same 1px quiet rule on the continuous reading surface; no enclosing panels or left accent bars.

Implementation lives in canonical tokens, shared Action/Glyph consumers, shell recovery, and Home section rules. Adoption requires actual default/hover/focus/pending/cancel/error screenshots at the normal window size, composed text contrast, and a fresh font sweep after integration. Source declarations alone do not establish compliance.

The expanded sidebar course tree may use the explicitly requested faint vertical nesting guide from Courses toward My UW. This is a navigation hierarchy cue, ending before the next navigation icon; collapsed navigation has neither guide nor reserved gap. It does not authorize decorative left stripes in content.
