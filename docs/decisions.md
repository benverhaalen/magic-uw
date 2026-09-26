# Direction and open points

A context register, not an implementation backlog. No ownership is assigned.

## Established direction

| Point | Current understanding |
| --- | --- |
| Thesis | Learning tailored to student, class, and professor, with school-management overhead removed |
| Audience | UW–Madison students broadly, not only CS students |
| Priorities | Win BuildFest and selected awards; optional event launch; earn word of mouth |
| Entries | Applied AI & Automation, DoIT Badgers Building for Badgers, Art of the Break |
| Experience | Least user effort, familiar apps, no repeated context uploading, more than chat |
| Current technical focus | Data access, local records, provenance, linking, and freshness |
| Computation | Code for exact facts; Jev for typed judgments; language models for prose and deeper reasoning |
| Jev billing | One Magic Canvas–owned key; we pay. Students need no Jev account or key. Keep the credential server-side behind our proxy |
| School actions | Read only: no submitting, enrolling, or posting |
| Learning policy | Course policy first; coach when vague or silent |
| Honesty | No false reassurance or unsupported readiness, speed, or reliability claims |
| Visual taste | Calm neutral light interface, thin borders, small readable sans serif, minimal color and filler |
| Current collaboration | Shared context is pushed; runnable skeleton is pushed and implementation is authorized. Keep teammates informed without assigning work ownership |

## Resolved product decisions — September 26

- **Privacy:** course data and UW sessions live locally. Selected context may be sent to Jev and the hosted AI the student chooses. Clearly disclose the recipient, data categories, purpose, and applicable usage/retention settings. Offer guidance for disabling optional provider data uses; do not imply that disabling training disables all retention.
- **Four AI options only for now:** ChatGPT, Claude, Gemini, and a local model. Supporting any account with the three named providers is the intended requirement, including avoiding an assumed paid-plan prerequisite. Provider-specific feasibility and connection methods are not yet verified.
- **Minimal sign-in:** UW plus the chosen hosted LLM account. No separate Magic Canvas, Jev, model-hub, or infrastructure account should be required. With local AI, only UW sign-in is needed. User-completed Duo and later session renewal remain part of UW authentication.
- **Local AI is a built-in default alternative:** if the student does not choose a hosted AI, automatically identify a suitable open-source model for their system and handle the selection without making them research hardware or quantization. Exact selector/runtime/model is open. Fully local processing must also disable or replace hosted Jev; merely choosing a local language model does not do that.
- **Desktop first:** Mac and Windows are the product focus. The website provides information, working downloads, and GitHub links. iOS is later if time permits.
- **Jev billing:** one team-owned key, our bill, server-side proxy. No student Jev setup.

These are accepted directions. Account compatibility, hardware suitability, and data-control behavior must still be verified before being described as working capabilities.

## Product choices that can remain open

Sidebar by course/source/intent; default home view; relationship between day/spaces/calendar; artifact placement; floating pill and voice activation; visible source detail; degree audit's role; how personalization follows behavior versus explicit preference. Do not force these decisions merely to make the document look finished.

## Technical assumptions requiring evidence

- NetID SSO coverage and session lifetimes per UW system.
- Canvas authorization, calendar coverage, and view-tracking effects.
- UW Microsoft Graph consent availability.
- Provider-specific MCP, CLI, subscription, and retention rules.
- Jev precision, latency, and cost on our data; no threshold is established.
- Browser embedding, signing/distribution, and phone relay behavior.
- Coverage beyond our own courses.
- Exact dependency/model licenses. The repo currently has an MIT license; proposed closed distribution needs a deliberate licensing decision. No license was changed.

## Proposed refinements, not settled policy

Count recovery effort when judging least effort. Keep navigation stable while adapting content. Separate conservative planning dates from established deadlines. Model confidence does not grant action permission or prove correctness. User deletion controls must remain possible with versioned capture history.

## Additional accepted engineering direction

- Investigate current alternatives instead of stopping at familiar defaults. Check recency, licenses, benchmark authorship, and applicability to our data.
- Keep candidate tools separate from adopted choices. Selection requires a concrete task and an observable acceptance test.
- Prefer a minimal in-app sign-in browser with reusable app-owned sessions where supported; Search is an interaction reference, not a mandated engine.
- All current agent work on Ben’s computer and Canvas must be headless. Never open an interactive sign-in window during testing.
- Full selection and evidence policy: [engineering principles](engineering-principles.md).
