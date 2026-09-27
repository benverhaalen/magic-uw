# Shared project context

For Ben and three teammates. Updated September 26, 2026.

This section gets everyone informed about what Magic Canvas is and where the thinking stands. It is not a build guide, ownership plan, or first-demo proposal. Treat the concept as established; resolve remaining choices without repeatedly reopening the thesis.

## The short version

**The future of learning, tailored to you.** Magic Canvas already knows your classes, brings the right materials together, opens what you need, and helps you practice for your professor's expectations. Students should spend their attention learning instead of managing school.

Least user effort is the central taste principle. Fit existing apps and study habits. Feel calm and capable, with interaction beyond a chatbot.

Reference-driven design is our working method: assign each reference a job, inspect its actual mechanism, transfer the useful part, and verify the resulting student journey. We use architecture analogies beyond education and current tools beyond familiar defaults. Ben should see consequential ambiguity, clutter, complexity, or excessive token/tool cost before we commit to it. See [agent work principles](agent-work-principles.md) and the repo's [agent instructions](../AGENTS.md).

The technical direction starts with local course data: connectors capture sources, code handles exact facts, Jev makes typed judgments, and a language model writes and reasons with relevant context. **Our gateway pays for Jev on the Claude/Codex/Gemini routes; OpenRouter users will pay through their own OpenRouter key. Our TypeSafe key stays server-side.** The OpenRouter path is accepted direction, not yet implemented.

Ben accepted Nathaniel’s $5 one-time license plus bring-your-own-paid-AI direction. Intended routes are Claude Code, Codex, Gemini CLI with a paid key, and OpenRouter; verified adapters and payment setup remain unfinished. See [the resolution](decisions.md#pricing-and-ai-access-resolution--september-26). Desktop comes first; the website is for information/downloads/GitHub; iOS is later if time permits.

Trust is part of the product: course AI policy first, no submitting/enrolling/posting or explicit completion commands to school systems, sources and freshness, reversible links, and honest uncertainty. Reading may register views or satisfy must-view requirements; this accepted effect is disclosed. Local storage and hosted processing must be described separately.

We are entering Applied AI & Automation, DoIT's Badgers Building for Badgers, and The Art of the Break. Winning matters; launching during the event is a bonus.

## Reading map

| Read                                                  | Contents                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Design system](../DESIGN.md) / [handoff](design-handoff.md) | Small entry point: visual anchor, semantic tokens, behavior contracts, platform handoffs and scoped audit workflow |
| [Marketing materials](../marketing/README.md)          | Website page directions, wizard logo pack, and team photos (design exports, not the built site)          |
| [Home and visual direction](home-design-direction.md) | Current flagship Home, near-approved layout/type, remaining local refinements and reference transfers |
| [Magic Canvas direction](magic-canvas-direction.md) | Course backend lane: the whole product, frontend surfaces, open-source academic data platform plus paid product, roadmap (open decisions marked) |
| [Course backend architecture](course-backend-architecture.md) | Course backend lane: system map, integration with main, what changed and why, implementation status and what is left |
| [Course-aware learning sessions](learning-sessions.md) | Assignment learning surface adapted to the shared backend; explicit integration dependencies and verification limits |
| [Product](product.md)                                 | Vision, student experience, learning loop, interface ideas, visual taste                                 |
| [Organizing concepts](product-directions.md)          | Earlier organizing alternatives; current Home decisions supersede their unresolved entry/navigation status |
| [Reference-driven design](reference-driven-design.md) | Reference roles, architecture analogies, images, demo inspection, and product verification               |
| [Agent work principles](agent-work-principles.md)     | Intent, discovery, expert methods, delegation, context/cost, and complete delivery                       |
| [Feature planning skill](../.agents/skills/magic-feature-planning/SKILL.md) | Inspect unfinished capabilities, choose useful next features, and carry bounded plans into authorized implementation and review |
| [AI and privacy](ai-and-privacy.md)                   | Paid AI direction, existing local adapter, sign-in, and data disclosures                                |
| [Technical direction](architecture.md)                | Access, connectors, records, deadlines, Jev, models, stack proposals                                     |
| [Pipeline details](pipeline-details.md)               | Actual endpoints and limits; proposed reconnect, scrubbing, citation checks, and link thresholds         |
| [Course ingestion](ingestion-upgrade.md)              | Expanded sources, refresh, local materials, privacy, and verified limits                                 |
| [Course intelligence](course-intelligence.md)          | Versioned course claims, source-bound policy interpretation, optional local extraction, and evidence limits |
| [Planning integration](planning-upgrade.md)           | My UW adapters, source reconciliation, privacy, live evidence, and remaining work                         |
| [Implementation status](implementation-status.md)     | Actual capability boundaries, evidence, and the remaining product scope                                  |
| [Development](development.md)                         | Run the workspace and checks; configure the shared gateway safely                                        |
| [Decisions and open points](decisions.md)             | What is established and what still needs input                                                           |
| [BuildFest context](buildfest.md)                     | Event facts, judging audiences, opening-slide notes                                                      |
| [Engineering principles](engineering-principles.md)   | How we choose tools, judge evidence, test alternatives, and preserve privacy                             |
| [Tool evaluation](tool-evaluation.md)                 | Current candidates, licenses, benchmark provenance, and adoption tests                                   |
| [Research status](research.md)                        | Checked references and unresolved evidence                                                               |
| [Plans](plans/README.md)                               | **Start here to pick up the work:** notebook and study-tracking spec, backend optimization, measurement, complete-app plan |
| [Research notes](notes/README.md)                     | Research and decisions: where we differ from the current plan, competitive comparison, benchmarking, local DB, Jev, practice, integrity and more |

## Status matters

- **Direction:** Ben's stated intent or constraint.
- **Proposal:** a possible approach, not an accepted team decision.
- **Verified:** checked against a cited source; not a claim our software implements it.
- **Implemented:** present in code; its validation scope is stated separately.
- **Tested in isolation:** exercised with controlled inputs, without establishing live service compatibility.
- **Integrated:** connected through the application; live and cross-platform results still need their own evidence.
- **Open:** a product decision or technical fact still unresolved.

A detailed idea is not automatically a commitment. These notes preserve the broader vision without implying every capability exists. They summarize the discussion rather than reproduce it word for word.

When a point is resolved, update the decisions page and the affected description. Keep private course data, credentials, sessions, and unpublished research captures out of this repository.
