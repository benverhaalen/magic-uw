# Magic Canvas design system

Version 3 · September 26, 2026 · Component system candidate; foundation palette/type accepted (D27). Evidence for rendered components and transfer lives in the [coverage map](docs/design/system-coverage.md); a rule is not proof of implementation.

Magic helps students understand what matters, inspect the evidence, and begin useful work without assembling the context again. Its cohesive Home establishes the visual language. The original image collections helped establish that language; expert references now improve specific interaction and craft gaps within it. [D24 and the original decisions](docs/design/decision-record.md) govern this interpretation.

## What travels, and how far

| Layer | Keep | Adapt |
| --- | --- | --- |
| Reusable experience principles | Clear hierarchy, recognizable actions, honest state, recoverable changes, continuity, readable density | Apply to the audience and task; the principles do not prescribe a student dashboard everywhere. |
| Magic identity across surfaces | Cooper Light BT / Geist roles, Lucide, warm outer material with ivory content, deliberate blue and colorful action/identity surfaces, restrained boundaries | Desktop extensions retain the actual fonts, Lucide glyphs, sidebar construction, shell gradient and corner treatment; task content can vary within that frame. A public website uses its own composition. Font distribution and the site's current branding difference remain unresolved. |
| Product/page requirements | Home's briefing-first composition, flat Upcoming, specific Study actions and separate Today; desktop navigation; evidence and completion semantics | Keep explicit choices on their named surfaces. Courses, assignment detail, chat and website each need their own useful hierarchy. |
| Platform implementation | Same role meanings, resource identity, behavior and visible state | Use the actual framework's routing, semantics, focus, persistence and capabilities. Electron window controls belong only in the desktop adapter. |
| Ben's broader taste | Familiar operation, controlled distinctiveness, compact readability, consistency, assembled context | These are provisional preference hypotheses for unrelated projects, not a global Cooper/ember/sidebar brand. Revalidate against their users and brief. |

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

Before presenting a new desktop family as Magic, demonstrate the identity in code against the actual Home reference: loaded Cooper/Geist, real Lucide glyphs, the matched sidebar, shell treatment and curves. Approximate serif lettering, generic icons and a vaguely warm palette do not pass this gate. Generated images can explore a component but cannot establish exact typography or icon fidelity. Use the matched desktop context when judging shell relationships. Standalone component and foundation sheets are appropriate for bounded details; they do not prove whole-frame fidelity.

Calibrate a useful subset of typography, materials and recipes through **intended image → extracted roles/relationships → fresh component code → rendered comparison and interaction checks**. Then test a related surface from a fresh description without supplying its bespoke layout or the old Home CSS. A copied Home cannot establish transfer. New features may extend the first version as their needs become clear; all future screens need not be specified now. See the [image-to-code sequence](.agents/skills/magic-design/references/image-to-code.md).

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

## Evolve while features proceed in parallel

Start with the audience, normal entry/default state, useful outcome and one complete journey. Choose the nearest recipe and state its domain binding. Reuse stable roles; keep page geometry local. A new family or consequential taste choice warrants a concrete comparison with Ben; routine fixes within accepted direction do not.

One integrator owns a shared token/contract edit at a time. Workers name their system revision and own bounded surfaces; inspect relevant upstream changes before integration. A contribution records changed rule/recipe, affected consumers, before/after evidence and remaining uncertainty. Review its actual dependents and a representative sibling, not every unrelated screen.

Use distinct claims: **proposed**, **accepted direction**, **demonstrated in isolation**, **integrated**, and **demonstrated in the real journey**. A passing screenshot does not prove source correctness, accessibility, framework portability or teammate adoption. Keep the smallest useful evidence and repair the producing rule when observed use contradicts it.
