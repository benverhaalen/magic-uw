# Foundations and application rules

Version 2. This page turns the [visual anchor](visual-baseline.md) into choices for unfamiliar surfaces. Extracted numbers are seeds; new layout rules below are proposals to test, not additional claims of Ben's approval.

## Typography and readable density

Use the actual supplied Cooper Light BT for identity, centered page title and selected editorial/action roles; Geist for controls, metadata and sustained reading. Selective serif in Briefing and Upcoming is permitted. Verify loaded fonts before visual judgment; a fallback may test behavior but cannot settle wrapping or type balance. Keep private font binaries outside Git. Production font distribution remains a separate decision.

Start from the measured scale in the baseline. Retain normal readable tracking unless a rendered comparison improves it. Do not create oversized page titles to signal importance. Establish hierarchy through position, spacing, weight and selective color first. Long course names, small metadata, narrow windows and enlarged text are primary design cases, not cleanup. Never shrink text merely to preserve a screenshot's row height.

Spacing expresses relationships: closest within a label/value or action group, modest between related rows, more between different student jobs. Start new compositions with a small repeated spacing set such as 4/8/12/16/24/32 CSS px; this is an implementation convenience, not a rule to round existing accepted geometry. Reuse a value only when its role repeats.

## Color and gradients

| Role | Application | Failure to catch |
| --- | --- | --- |
| Brand | Ember/red shell wrapping ivory content | Gradient or large decoration competes with the student's briefing |
| Action | Blue review/link affordance with readable paired ink | Blue used for unrelated status makes an action ambiguous |
| Identity | Stable rose/blue/coral course or work association plus text | Reordering a list changes course identity; color alone identifies a course |
| Learning | Warm gold activities with dark readable type | Decorative topic cards replace an already-selected useful activity |
| Status | Explicit words and an appropriate signifier | A coral identity fill is mistaken for an error; a grade is shown as mastery |
| Focus | Visible, contrasting keyboard locator | Border removal also removes focus indication |

Keep fill/ink pairs together. Brand, identity and status are separate meanings even when hues overlap. CSS handles precise gradients; raster generation is optional for actual imagery with a defined role. Do not add imagery to every class because an asset pipeline exists. A generated subject illustration never establishes factual course content.

Use bounded gradients on flat surfaces, with quiet interiors and controlled saturation. Test the least contrasting region beneath text, not just one endpoint or a screenshot average. Alpha overlays must be checked against the composed background. Customizable shell color is later scope: any implementation must preserve ink/focus pairings and must not silently recolor semantic warnings.

The seed palette is not an accessibility certification. Normal text targets at least 4.5:1; qualifying large text at least 3:1. Necessary visual control boundaries and indicators need relevant non-text contrast checks. Test actual focus, hover, disabled and error treatments. See [research and standards](system-research.md).

## Borders, elevation and icons

Give each boundary a job: a workspace edge, quiet separator, grouped-control division or keyboard focus. A filled Upcoming row usually needs no additional outline; this does not prohibit a useful boundary in another context. Avoid a card surrounding another card merely to separate headings. Reserve elevation for real overlays/popovers, not ordinary work rows. Candidate action/tag/link tokens remain unresolved comparisons.

Use Lucide consistently with round stroke caps/joins; start from the baseline stroke seed and inspect optical weight. Glyph size and target size are different. Small visible icons can sit in generous invisible targets. Favor at least 32px controls in compact desktop toolbars when layout allows; satisfy WCAG's 24px minimum or applicable exceptions without mistaking that minimum for ideal usability. Inline sentence links have different sizing constraints. Use accessible names; critical meaning must survive without hover.

Provider marks identify the actual verified destinations, using legitimate assets. Never substitute a Lucide glyph for a claimed provider logo. Do not imply VS Code, GitLab or a notes app will open unless that destination is matched and available.

## Responsive behavior and platform adapters

Preserve semantic reading order before preserving coordinates. Proposed adaptation order: reduce nonessential whitespace; collapse navigation using its existing control; reflow cards and optional action regions; move Today's context into the content flow when the reading pane would become cramped. Do not silently hide deadlines or source access. Keep relevant choices and scroll stable during resize. Breakpoints follow tested content pressure, not a device name. A Calendar may need a separately labeled agenda alternative for constrained layouts; this is an unresolved product proposal, not permission to delete the requested week/month views.

For web, use semantic HTML and a small mapping of the same tokens. For React/Electron, keep domain/source state outside presentational components and use the existing typed bridge for capabilities. Navigation identity must not be a display label. Use native link/button semantics and framework-appropriate routing/focus restoration; do not bolt page reloads onto an in-app Back operation. The public site's information/download journey uses its own composition. It shares identity/material/type roles, not fake desktop controls.

Minimum practical checks for an affected surface: baseline laptop viewport, narrower window, enlarged text, keyboard-only entry/action/return, visible focus, and reduced motion if animated. For continuous prose, check reflow without horizontal scrolling; two-dimensional Calendar data may need a deliberate alternative. These checks are necessary evidence, not a claim of complete accessibility conformance.

## Content, freshness and motion

Prefer concrete object + consequence + useful next action. “CS639's lecture uses chapter 4” is helpful only when sources establish the association; “prepare for success” is not useful synthesis. Dates retain source timezone; relative times need an unambiguous exact value on inspection. Tags inherit prose type size and add padding around it.

Use pending feedback immediately and show failure where its recovery lives. Keep saved facts readable while refresh is incomplete. Announce consequential status changes accessibly without making every streaming word a live announcement. New facts must not move the active reading target unexpectedly.

Movement explains a change, is interruptible, and respects reduced motion. Many frequent actions need no animation. Test rapid reversal and interrupted input rather than selecting durations as a style checklist.
