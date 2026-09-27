# Magic Canvas design system

Version 2 · September 26, 2026 · **Design specification and handoff, with independent document review. Production adoption is separate.**

This is the governing entry point for Magic Canvas interfaces. The repo skill routes agent work; it does not replace the system. Read this page, the relevant contract and its reference. Do not load every linked document for a small change.

## What the experience must accomplish

A UW–Madison student arrives with fragmented course information. Magic makes the important implication understandable, shows where it came from, and brings the right working context within reach. The hackathon demonstration must show this complete benefit: **understand → inspect evidence → begin the right work → return without losing your place**. A polished dashboard that sends the student searching again misses the goal.

## Governing principles

| Principle | Decision it changes | Evidence to inspect |
| --- | --- | --- |
| Be useful before being impressive | Lead with assigned reading needed for a lecture, a changed requirement or a deadline conflict. Omit a greeting/title that adds no information. | Can a student say what matters and take the next step without the presenter explaining the screen? |
| Assemble context without overstating knowledge | Source-backed work bundles and topic-specific practice; distinguish verified status, student report and inferred knowledge. | Missing/stale sources remain visible; opening a reading never establishes understanding. |
| Familiar operation, recognizable identity | Compact native-feeling shell, Cooper/Geist, Lucide, warm wrap, continuous ivory workspace, deliberate vibrant action surfaces. | Compare the entire page and nested navigation with the accepted image, including menus and focus states. |
| Density follows meaning | Briefing first; optional actions; compact flat graded work; specific learning actions; Today supplies timing. | No mandatory card per sentence, redundant summary or decorative preview. Test long and no-action content. |
| Preserve continuity | History restores place, selection, focus and drafts while changed facts refresh honestly. | Exercise Back after scrolling, opening a source, refreshing and a recoverable failure. |
| Make consistency affordable | Shared semantic values and recurring behavior recipes; local page composition. | Changing a font/color role updates consumers without a second palette or copied component cascade. |

These principles generalize the reasons behind Ben's corrections; they do not authorize changing accepted composition. [Exact decisions and provenance](docs/design/decision-record.md) distinguish his words from our inferences.

## Authority and unresolved choices

Current explicit human instructions and resolutions control. Then use accepted decisions, the near-approved visual anchor with its documented exceptions, component contracts and tokens. External skills and agent preferences are proposals. A newer statement from a different teammate is a conflict to resolve, not automatic replacement. Tell the affected people directly and request their agreement; continue unaffected work.

Home is approximately 95% desired in Ben's judgment. Preserve its structure. New navigation adds My UW and Calendar. Action/tag outlines, link backing, glyph scale and combined review/confirmation proportions remain local comparisons, not settled universal rules. Cooper font distribution and intentional website branding divergence remain open.

## Find the right specification

| Building or evaluating | Read |
| --- | --- |
| Visual language, exact asset, token values | [Visual baseline](docs/design/visual-baseline.md) and [tokens](docs/design/tokens.css) |
| Type/color/boundary choices, accessibility, responsive adaptation | [Foundations](docs/design/foundations.md) |
| Controls, evidence, Courses and complete interaction states | [Component contracts](docs/design/component-contracts.md) |
| Scope of each screen and what is actually demonstrated | [Surface and evidence map](docs/design/system-coverage.md) |
| Platform integration / website handoff | [Platform handoff](docs/design/platform-handoff.md) |
| Original product detail | [Home direction](docs/home-design-direction.md) and [product](docs/product.md) |
| Why external advice was adopted or rejected | [Reference selection](docs/design/reference-selection.md) and [system research](docs/design/system-research.md) |
| Independent generation, critique and repair | [Iteration and review](.agents/skills/magic-design/references/iteration-and-review.md) |

The [intent-to-output audit trail](docs/design/validation-v2.md#intent-to-output-audit-trail) connects your source decisions and inspected references to the affected rule and the observation that should catch drift. It is a scoped check set, not an instruction to load every source.

## Extend without drifting

For a new feature, choose its student job and nearest existing recipe; provide source/identity, all consequential states, destination and return behavior. Change an existing recipe only when the new case shows it is insufficient. Keep new geometry provisional until an actual render and complete journey support it. Show Ben a concrete comparison at a new visual family or consequential workflow choice; routine repairs need no approval ceremony.

A contribution names the changed rule, affected consumers, representative before/after state, evidence and outstanding choice. Mark it **proposed**, **accepted direction**, **demonstrated in isolation**, or **integrated**; no global “approved” badge hides untested states. Review only the affected siblings and journeys. Keep original quotes immutable and link superseding decisions. Do not accumulate a parallel transcript.

One integrator owns a shared token/contract change at a time; other workers build bounded surfaces against a named revision. Pull/fetch relevant changes at natural boundaries, inspect before integration, and never overwrite another worker's changes. A new feature can proceed against stable behavior and visual roles while a local detail is being refined. No hooks, new platform framework or global agent settings are required.
