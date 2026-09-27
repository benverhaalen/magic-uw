---
name: magic-design
description: Design, extend, implement, or audit My Magic UW interfaces and its website using the project's visual constitution, original user decisions, and complete interaction journeys. Use for UI work and design handoffs in this repository; load supporting references only for the current task. Use the near-approved Home and user corrections to calibrate a transferable system, then adapt its language across platforms.
---

# My Magic UW design

## Start with intent and the current artifact

Apply its [current correction gates](../../../DESIGN.md#accepted-corrections-that-govern-current-consumers) and [adoption audit](../../../docs/design/adoption.md#keep-corrections-connected); a docs update never establishes consumer compliance. Read [the design system](../../../DESIGN.md) for governing principles and the task-specific reading map. For a small change, read only the affected contract. Before substantial work, inspect local changes and relevant upstream docs/code; fetch remote refs when available. Fast-forward only a compatible clean checkout. Do not overwrite, stash, merge or commit another contributor's work to make synchronization convenient.

State the student's complete journey, normal entry/default state and observable benefit. The flagship is **evidence → useful synthesis → the right action and working context → a reliable return**. Optimizing a screenshot alone is insufficient. Determine the current requested stage: direction/system-only tasks stop there; an authorized image-to-code task proceeds through a working coded journey and verification.

Use the current user instruction, controlling quotes and accepted decisions together. The near-approved Home is a calibration reference for taste and Home hierarchy. Preserve explicit layout decisions while correcting its documented flaws; its exact coordinates and incidental details do not govern the system. Ben's 95% judgment is subjective satisfaction, not a numerical image threshold. Resolve consequential conflicts with the affected humans; label proposals. Silence does not approve a new direction.

The cohesive My Magic UW Home establishes this project’s design language. Earlier image collections were inputs to settling that language; do not reopen aesthetic discovery by blending them again. Use UX/UI research and external references to solve a named usability, interaction, accessibility or consistency gap within this language. Generalize Ben’s corrections with their purpose and scope; bring consequential identity changes back as explicit proposals. See D24.

## Load only what the task needs

- Visual task: [visual baseline and assets](../../../docs/design/visual-baseline.md), then relevant sections of [Home direction](../../../docs/home-design-direction.md).
- Information hierarchy or generated copy: [content design](../../../docs/design/content-design.md).
- Interaction/new feature: [component and behavior contracts](../../../docs/design/component-contracts.md), then the applicable [reusable recipe](../../../docs/design/component-recipes.md).
- Image-to-code build: [build and verification order](references/image-to-code.md).
- External skill mechanisms: [source adapters](references/source-adapters.md); load only the mechanism being applied.
- Generation, implementation, independent audit or handoff: [iteration and review](references/iteration-and-review.md).
- Shared implementation/adoption: [adoption agreement](../../../docs/design/adoption.md) and the relevant [component-local contract](../../../packages/ui/README.md). Inspect real consumers, reuse applicable code and attach the compact evidence record to the existing handoff.
- Desktop/site integration or parallel work: [platform handoff](../../../docs/design/platform-handoff.md).
- New mechanism or external skill: [reference selection](../../../docs/design/reference-selection.md). Select one useful mechanism; do not load a library of skills.

## Apply the system to a description

Turn the requested feature into a complete useful journey. Identify which decisions are shared Magic identity, reusable interaction rules, page-specific requirements, and platform implementation. Read only the matching recipes and visual examples. Home supplies the language, not the layout of a Calendar, form, dialog or website. For a new pattern, explain the missing mechanism, inspect an applicable expert reference, build a representative example and test it before promoting its rule. Do not make Ben supply specialist UI/UX decisions; ask him about consequential feel or product intent with concrete comparisons and your recommendation.

Use existing components when they fit their semantics. A matching color alone does not make a component suitable. Compose new page geometry locally, preserve shared type/material/control roles, and use the target framework's correct state and focus mechanisms. Report what is demonstrated in plain HTML, in the actual framework, and in the integrated app separately.

## Produce a coherent result

The current desktop work includes integrated production journeys. Improve shared foundations and component families through their actual page consumers: palette/gradient roles, exact typography and icons, surfaces/curves, controls and their states. Use image-to-code where it resolves a visual composition gap within Home's established language. Foundation-only requests still stop at their requested scope. Before presenting a specimen, verify the concrete identity against Home; similar colors with guessed fonts, icons or shell geometry fail. See D26 and the image-to-code reference.

Reuse the shared identity, font roles, semantic tokens and component recipes. Match an existing sibling before inventing a new treatment. Karma Medium (500) and Geist, Hugeicons Stroke Rounded, warm gradient shell, flat colorful actions and restrained borders are intentional. The [decision record](../../../docs/design/decision-record.md) preserves reasons and still-open details. Karma Medium (`Karma-Medium.ttf`) and Geist (`Geist-Variable.woff2`), with their OFL licenses, are bundled in `packages/ui/assets/fonts` and declared once in `packages/ui/src/fonts.css`. The desktop build verifies the emitted font bytes. A fallback is not a successful font match.

For a new surface, extend the language around its user journey rather than copy Home's layout. Desktop navigation is Home / Courses / My UW / Calendar; a website has a different entry journey. Keep visible facts grounded and capabilities honest. No inferred reading completion, invented readiness, or fake multi-app launch.

Use image generation autonomously where a raster asset or visual comparison resolves a real gap. Preserve approved composition in reference inputs. Use code for precise type, icons and gradients. Generated text, guessed font shapes and beautiful screenshots do not establish runtime behavior. For system-building tasks, first calibrate representative images and coded compositions, then test a fresh description against the system; only then extend into production Home. On implementation tasks, rebuild from that visual/behavior specification without inheriting the exploratory mock's cascade.

## Review, correct, and carry forward

Audit the actual rendered whole surface, including nested course navigation, menus and return states. Give a fresh reviewer the task, baseline image, controlling quotes and relevant states; withhold the creator's preferred verdict. Independently review consequential visual/interaction work when useful; verify requested model identity. Do not describe a model as used without receipts. Inspect findings yourself and fix supported gaps.

Use the milestone check-ins and bounded refinement loop in the review reference. Continue unaffected work while a question is pending. At a material correction, update the canonical rule, affected recipe/token, test example and future review packet; remove superseded instructions. Save a compact handoff with commit, owned files, evidence and remaining decision. Recheck relevant upstream changes before integration/publication. Do not create hooks, timers, global configuration or mandatory helper launches.

## First usable completion

For system-only work, demonstrate transferable foundations. For authorized product work, deliver the integrated journey in the runtime of record. Show a small but meaningfully diverse set of complete examples: source/action composition, form/overlay recovery, and a different page or platform journey from a fresh description. Trace important rules into actual component consumers and rendered behavior. Resolve material drift; disclose unsupported patterns and where further design work is needed. A passing doc validator, generated board, model agreement, or nominal component count is not a completion criterion. Keep human taste decisions pending until answered, while continuing unaffected work.
