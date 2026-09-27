# Calibrate the system with image-to-code, then build from a description

## The outcome and the role of the old Home

Ben wants a reusable design system that can produce coherent new interfaces from a student journey and feature description. The cohesive Home is strong evidence of his taste, roughly 95% desired as a static screen. It is not a complete specification, an approval of every detail, or a layout template for every page. See D23 in the [decision record](../../../../docs/design/decision-record.md) for the surrounding original messages.

Use the image together with corrections, product goals and relevant references. Distinguish:

- **Explicit decisions:** one sidebar, briefing prominence, flat Upcoming, separate Today context, Karma Medium/Geist, Lucide, specific learning actions and truthful evidence/completion.
- **Useful visual evidence:** density, color relationships, gradient character, typographic contrast, restraint and rhythm. Extract their jobs and relationships, not an immutable coordinate map.
- **Open or criticized details:** action/tag outlines, link backing, icon scale, review/handled proportions, course-dropdown consistency and untested responsive/interactive states. Do not reproduce these to earn a similarity score.
- **Incidental content/geometry:** synthetic names, number of passages/rows and exact widths are observations, not domain rules.

The clean rebuild must not inherit the exploratory HTML/CSS cascade or use it as hidden design authority. Reuse safe existing platform/data plumbing. Reconsider component construction and local placement from the current description and system. Retain explicit accepted layout constraints; expose a consequential change rather than quietly turning clean-room work into a new aesthetic. This is a practical design/implementation separation, not a legal clean-room claim.

## Correct build order

### 1. Establish a provisional system from evidence

Read the relevant original decisions and actual Home image. Record accepted properties, their purpose, known flaws and unresolved choices. Inspect source skills only for a named contribution using [source adapters](source-adapters.md). Downloads references are fallback evidence for an identified gap, not a requirement to blend every reference. Exact fonts and permitted assets must be available for visual judgment.

### 2. Use images and code to calibrate the system

**Current unit of design is foundations and component families, not a complete Calendar or another page (D26).** Start with Home-derived palette roles and gradient samples, exact typography, icon sizing, curves, surface/border treatments, then related controls and states. Use readable, focused image studies for unresolved component appearance; translate selected treatments into exact coded specimens. Avoid a tiny all-in-one board. Full pages are later composition/transfer tests, not the first image-generation deliverable.

Before showing a new family, compare concrete identity against the original Home: actual bundled Karma Medium and supplied Geist files, Lucide glyphs and scale, curves, spacing, material and color relationships. The Home image shows the former Cooper face, so judge its composition and color, not letterforms. A desktop context fixture must preserve the established shell treatment; it need not rebuild Home's content. A standalone specimen can omit the shell if clearly presented as a component study, but cannot claim to prove shell fidelity. Reject guessed typography and a merely similar palette. Current rejected raster studies are not appearance targets.

Create focused refined images when they resolve appearance, composition or asset uncertainty. Give generation the actual relevant reference inputs and the user's corrections. Use precise coded specimens for fonts, gradients, borders, controls and states that raster generation cannot specify faithfully. These are complementary parts of image-to-code, not competing pipelines.

Implement representative compositions fresh from the intended images and behavior descriptions. Capture the actual rendered specimens, compare them to the intended visual direction, inspect the states, and refine the target/rule/code that caused the mismatch. Keep the original screenshot unchanged as evidence; version candidates separately. A full Home image may help judge overall coherence, but do not integrate a production Home merely to test the foundation.

The durable system has **words + visual examples + semantic values + reusable component/state recipes**. An image without implementation rules cannot ensure transfer. A Markdown constitution without demonstrated visual output cannot establish taste. A code screenshot alone cannot establish interaction quality.

### 3. Test generalization from a description

Give a fresh builder the compact system, approved/refined component images, relevant framework constraints and a new bounded feature description. Do not give the old Home markup or a bespoke layout solution for that new feature. Example: a course's assignment detail with long instructions, source evidence and return to Home; or one website section serving an actual visitor need.

Check whether it produces the same language while choosing a task-appropriate composition. A critic receives original requirements and actual result without the builder's self-evaluation. If it needs a large corrective prompt, identify what the system failed to communicate; repair the rule/example and repeat the affected case. Do not solve generalization by copying Home's layout everywhere.

### 4. Check in at a meaningful milestone

Show Ben the calibrated direction in concrete images and code, with one or two remaining consequential choices. Reuse accepted decisions; no approval ceremony for routine craft fixes. While awaiting a taste decision, continue independent behavioral, source, accessibility or platform work; silence does not accept dependent styling.

### 5. Use the calibrated system for Home and later surfaces

Build Home from its current description, product/interaction contract and the system. Consult the historical image as a calibration reference, with recorded exceptions. Build the minimal complete Electron journey so parallel feature work can start against stable component/data seams. New surfaces get their own useful hierarchy; desktop and website share identity and roles, not window chrome or screen layout.

### 6. Verify the actual journey and feed lessons back

Separate the fresh interaction designer from the implementer/critic when useful. Specify entry, every consequential action, resource identity, preserved scroll/focus/draft state, selective refresh, recovery and source changes. Verify actual rendered default/hover/focus/disabled/pending/error/return states in the appropriate framework. Use independent visual and interaction checks; exact model claims need receipts.

Apply supported fixes to the rule, component and affected siblings. Preserve accepted reasons and quote provenance. A change is not accepted simply because judges agree or pixels match. Keep bounded handoffs and source/version evidence; do not load all research into every agent. See [iteration and review](iteration-and-review.md) for repair and parallel-work mechanics.

## Stop conditions and honesty

A calibration is successful when its visual result fits the accepted taste, the described behavior works, and a fresh description produces a coherent related surface without extensive rescue. State which of these was actually demonstrated. Keep unfinished candidates isolated and unmerged. When a user corrects the process, pause dependent implementation, reread original evidence, update the producing workflow, and resume from the corrected stage.
