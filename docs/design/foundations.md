# Foundations and application rules

Version 3. Magic's established Home is the language reference; these rules preserve its relationships while allowing new compositions. Exact seeds and assets live in the [baseline](visual-baseline.md) and [tokens](tokens.css). New examples demonstrate a rule only within their tested scope.

## Concrete identity gate

The language consists of concrete assets and construction as well as relationships. Desktop calibration starts at the reference's 1440 × 900 view with its observed 234px sidebar, compact 55px top region, 13px workspace corners and narrow outer wrap. Load the bundled Lora Medium (500) and supplied Geist and use real Lucide glyphs, with the observed 1.65 stroke seed. Reproduce the layered ember gradient and continuous ivory workspace through the shared tokens. These measurements are comparison anchors; changed viewport/content requires deliberate adaptation, not an arbitrary replacement shell.

Before presenting a new desktop family, compare its enclosing frame to Home: font shapes and rhythm, glyph family/optical weight, sidebar proportions and selected state, wrap thickness and workspace curves. An overlay on a generic warm frame is insufficient. Do not tune new components around fallback metrics or count generated lettering/icons as exact assets. A rejected imitation cannot become the new baseline. Website composition remains separate, but still needs the actual permitted identity assets and a demonstrated visual transfer.

## Typography and spacing

| Role | Magic application | Adaptation rule |
| --- | --- | --- |
| Identity / editorial emphasis | Supplied Lora Medium at weight 500 (`packages/ui/assets/fonts`, OFL; replaced Cooper Light BT September 27) for identity, the desktop page title and selected editorial/action text | Retain its contrast with Geist. Home explicitly permits serif in Briefing and Upcoming; this is not a requirement to make all prose serif. |
| Reading / operation | Geist at the single canonical weight 400 for sustained reading, controls, metadata and semantic emphasis | Use `--magic-font-interface-weight` and `--magic-tracking` (normal) everywhere; preserve role-specific size, line height and clear hierarchy under long content and enlarged text. |
| Grouping | Close label/value or action groups; more space between different jobs | Repeat spacing when its meaning repeats. Start new geometry from a small scale such as 4/8/12/16/24/32px; do not round accepted relationships to satisfy a scale. |

Use the actual fonts before judging wrapping and balance. Fallbacks can exercise behavior but cannot validate the visual match. Lora Medium and its OFL are tracked in `packages/ui/assets/fonts`; the Geist binary stays outside Git and its production distribution remains unresolved. Position, grouping, type size and selective color establish hierarchy before a larger heading does. A website may need a larger editorial scale than the app; compare the same type relationship, not identical point sizes. Never shrink type to preserve a convenient row height.

For image-to-code, record type size/weight/line-height relationships, text-to-action spacing, surface/ink pairs and boundary purposes before building. Compare an actual render at a known viewport; name the discrepancy and revise its cause. This adapts [Taste's extraction mechanism](../../.agents/skills/magic-design/references/source-adapters.md), not its compulsory generation quotas or landing-page defaults.

## Materials and semantic color

| Role | Magic starting point | Keep separate from |
| --- | --- | --- |
| Outer identity | Warm ember/red material framing an ivory working surface | Warnings and the page's primary information |
| Main content | Continuous ivory surface with readable neutral ink | A mandatory card around each section |
| Action | Deliberate blue and other established vibrant action surfaces with paired ink | Status or selected state without an explicit signifier |
| Stable identity | Rose/blue/coral association for courses or work, always accompanied by text | List order and success/error meaning |
| Learning activity | Warm gold with dark readable type | A universal color for all secondary actions |
| Status | Explicit state words, appropriate signifier and readable treatment | Course identity, inferred mastery or decorative urgency |
| Focus | Visible contrasting locator around the actual control | The default decorative border |

Share roles across Magic surfaces; their proportions follow the job. The website can express warm identity without reproducing an application window. No new palette or aesthetic is implied by a new framework.

Keep fill/ink pairs together. Gradients are bounded, with quiet interiors and controlled saturation. Check the least contrasting region behind text and the final composed alpha overlay. CSS supplies exact gradients; raster assets need a genuine content or visual role. Generated images cannot establish course facts. Later shell customization must preserve ink/focus pairs and status meanings.

The seeds are not an accessibility certification. Normal text targets at least 4.5:1 and qualifying large text 3:1; necessary control boundaries and indicators require the applicable non-text contrast checks. Inspect actual hover, focus, disabled and error treatments. [Standards and research](system-research.md) provide the supporting scope.

## Boundaries, icons and targets

A boundary should identify a workspace edge, control, separator, group or focus. Prefer alignment and spacing for ordinary related content; reserve elevation for overlays. A filled work row commonly needs no extra outline. This does not ban borders from fields, selection or another useful context. Tag/action outlines and inline link backing remain local refinement candidates.

Lucide is the chosen UI family, with round caps/joins and optically consistent weight. Centralize repeated glyph sizes in the component role; separate visible glyph size from the hit target. Start compact desktop targets at 32px where practical; check the WCAG 24px minimum or applicable exception, without treating a minimum as ideal usability. Inline links have different spacing constraints. Provide accessible names; critical meaning cannot depend on hover.

Use legitimate marks only for verified provider destinations. Profile images need a readable fallback. The shadcn contribution is role-level icon ownership and correct semantic composition, not adoption of its default glyph scale or theme. [Recipes](component-recipes.md) specify the operation.

## Feedback and motion

Every activation gives timely visible feedback. Keep usable content readable during refresh and preserve input after failure. Place recovery beside the affected result; make consequential updates available to assistive technology without announcing every streamed word. Refresh should not unexpectedly move the reading target.

Apply Emil's **frequency → purpose → simplest mechanism → interruption** sequence before adding motion. Frequent navigation should feel immediate. A transition must explain location, acknowledge input or clarify a state change; otherwise omit it. Name transitioned properties, retarget from current values on rapid reversal, and anchor an animated popover to its trigger. Ship reduced-motion and fine-pointer hover handling with it. Instant layout changes can be appropriate; a GPU-only recipe must not distort text or dictate product behavior.

Recovery precedes animation. If a timer can remove an action, account for hidden tabs, hover and keyboard focus, or provide persistent recovery. Exercise rapid input and leaving/returning to the app. Adopted [Emil mechanisms](../../.agents/skills/magic-design/references/source-adapters.md) explain these checks; a duration table or code inspection cannot establish the feel.

## Content and evidence

Write the concrete object, consequence and useful next step. Do not fill empty space with generic encouragement, invented facts or an unnecessary button. Keep complete identity available when display names are shortened. Long labels wrap or truncate deliberately, without hiding facts required for the decision.

Separate source facts, inference, self-report and view state. A changing source version invalidates dependent conclusions until checked; missing, partial and conflicting coverage need different explanations. Dates retain timezone and all-day semantics; relative time has an exact value on inspection. Domain bindings in [component contracts](component-contracts.md) give these principles their Magic meaning.

## Responsive and platform adaptation

Preserve semantic reading and focus order before coordinates. Use tested content pressure to select breakpoints. Reduce optional whitespace, reflow groups and collapse navigation through its existing control before making reading cramped. Keep source access and consequential timing available. Home's Today rail may move into content flow at constrained widths; this is an adaptation proposal to test, not permission to remove it. Calendar's week/month views remain required; an agenda alternative is a separate proposal.

Web implementations use semantic HTML, real URLs and appropriate history. React/Electron separates domain and source state from presentation and uses existing typed capabilities; stable IDs, not display labels, identify routes and saved state. The public website shares identity roles while serving explanation and legitimate download/GitHub journeys. It does not inherit Mac controls, student data or implied app capabilities.

Inspect a baseline laptop, a narrower window, enlarged text, keyboard entry/action/return and reduced motion when animated. Continuous reading reflows without horizontal scrolling; two-dimensional data needs a deliberate constrained treatment. These are practical checks on the affected output, not proof of complete accessibility or equivalence across platforms.
