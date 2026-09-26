# Shared project context

For Ben and three teammates. Updated September 26, 2026.

This section gets everyone informed about what Magic Canvas is and where the thinking stands. It is not a build guide, ownership plan, or first-demo proposal. Treat the concept as established; resolve remaining choices without repeatedly reopening the thesis.

## The short version

**The future of learning, tailored to you.** Magic Canvas already knows your classes, brings the right materials together, opens what you need, and helps you practice for your professor's expectations. Students should spend their attention learning instead of managing school.

Least user effort is the central taste principle. Fit existing apps and study habits. Feel calm and capable, with interaction beyond a chatbot.

Reference-driven design is our working method: assign each reference a job, inspect its actual mechanism, transfer the useful part, and verify the resulting student journey. We use architecture analogies beyond education and current tools beyond familiar defaults. Ben should see consequential ambiguity, clutter, complexity, or excessive token/tool cost before we commit to it. See [agent work principles](agent-work-principles.md) and the repo's [agent instructions](../AGENTS.md).

The technical direction starts with local course data: connectors capture sources, code handles exact facts, Jev makes typed judgments, and a language model writes and reasons with relevant context. **Magic Canvas owns one Jev key and pays for usage. Students do not supply a Jev key.**

The four AI choices are ChatGPT, Claude, Gemini, and an automatically selected local model. Only UW and the chosen hosted AI should require sign-in. Desktop comes first; the website is for information/downloads/GitHub; iOS is later if time permits.

Trust is part of the product: course AI policy first, no submitting/enrolling/posting to school systems, sources and freshness, reversible links, and honest uncertainty. Local storage and hosted processing must be described separately.

We are entering Applied AI & Automation, DoIT's Badgers Building for Badgers, and The Art of the Break. Winning matters; launching during the event is a bonus.

## Reading map

| Read | Contents |
| --- | --- |
| [Product](product.md) | Vision, student experience, learning loop, interface ideas, visual taste |
| [Organizing concepts](product-directions.md) | Six different organizing ideas, each with a journey, risk, reference, and quick test; no winner selected |
| [Reference-driven design](reference-driven-design.md) | Reference roles, architecture analogies, images, demo inspection, and product verification |
| [Agent work principles](agent-work-principles.md) | Intent, discovery, expert methods, delegation, context/cost, and complete delivery |
| [AI and privacy](ai-and-privacy.md) | Four AI options, automatic local selection, sign-in, and data disclosures |
| [Technical direction](architecture.md) | Access, connectors, records, deadlines, Jev, models, stack proposals |
| [Pipeline details](pipeline-details.md) | Actual endpoints and limits; proposed reconnect, scrubbing, citation checks, and link thresholds |
| [Implementation status](implementation-status.md) | Actual capability boundaries, evidence, and the remaining product scope |
| [Development](development.md) | Run the workspace and checks; configure the shared gateway safely |
| [Decisions and open points](decisions.md) | What is established and what still needs input |
| [BuildFest context](buildfest.md) | Event facts, judging audiences, opening-slide notes |
| [Engineering principles](engineering-principles.md) | How we choose tools, judge evidence, test alternatives, and preserve privacy |
| [Tool evaluation](tool-evaluation.md) | Current candidates, licenses, benchmark provenance, and adoption tests |
| [Research status](research.md) | Checked references and unresolved evidence |

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
