# Magic Canvas design foundation — start here

Version 1, recorded September 26, 2026. **Foundation and handoff; application integration has not been performed.**

The Home Ben described as approximately 95% desired is our visual anchor. Our job is to preserve its recognizable composition and finish the details, then extend that language to new journeys. The hackathon demonstration must make connected school context useful: a student sees an implication, can inspect its evidence, and starts the right work in one deliberate action. A judge should understand that benefit without our narration.

## A small entry point for builders

**Tell an agent:** “Read AGENTS.md and use the Magic design skill for this UI work.”

[Repo skill](../.agents/skills/magic-design/SKILL.md) routes Claude/Codex to task-specific context. Pulling makes files available; it does not prove a running agent reread them. At the next natural task boundary, explicitly ask an already-running agent to load the changed guidance. There are no hooks or background enforcement processes.

| Need | Read |
| --- | --- |
| Appearance and assets | [Visual baseline](design/visual-baseline.md), its reference image and small CSS token seed |
| Why this direction / exact corrections | [Decision record](design/decision-record.md); follow only relevant links into [Home direction](home-design-direction.md) |
| Design a component or complete interaction | [Component contracts](design/component-contracts.md) |
| Generate, build, judge and refine | [Iteration and review](../.agents/skills/magic-design/references/iteration-and-review.md) |
| Aiden's website or later Electron integration | [Platform handoff](design/platform-handoff.md) |
| Choose outside references or skills | [Reference selection](design/reference-selection.md) |

The constitution is this connected set of text, image, tokens and behavior contracts. It is not a new app framework. Each file has one job; contributors need not ingest all of them.

## Current decisions and remaining choices

- Preserve the compact Mac/Codex shell and briefing-first Home. Sidebar now includes **Home / Courses / My UW / Calendar**. The historical image predates the last two entries.
- Cooper Light BT + Geist; Lucide; warm ivory with ember/red gradients and deliberate blue/colored actions. Supplied fonts are not redistributed here.
- Flat graded Upcoming, specific Study & Learn actions, due items above a quiet readable Today schedule. No screen previews or generic study tiles.
- Local details still need comparison: action outlines, time-tag treatment, link backing, smaller glyphs, and the combined review/confirmation footprint. These are not permission to redesign the whole page.
- Calendar offers **week and month views**, defaults to the current week, and shows suggestions **on request**. Sean's implemented Today rail is reusable domain work; a full Calendar page remains to be built.
- A branch logo/Fredoka wordmark proposal differs from Ben's Cooper/no-logo Home decision. Ask the affected humans whether the website intentionally differs; do not silently reconcile their opinions.

## Scope and adoption

The current production desktop is React/Electron with a typed bridge and SQLite; the website is informational HTML. This package changes guidance and shareable reference assets only. It does not implement a live briefing, work bundles, generated learning activities, Calendar route or a new shell. The [platform handoff](design/platform-handoff.md) separates built code from proposals and gives the next complete implementation slice.

Keep the design foundation in ordinary docs and `.agents/skills/magic-design/`. The separately recorded September 27, 11 a.m. cleanup applies to temporary coordination paths; do not erase this durable skill by deleting all of `.agents`. History rewriting requires the already documented coordinated release procedure, not an automatic design-agent action.
