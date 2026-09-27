# Direction and open points

A context register, not an implementation backlog. No ownership is assigned.

## Established direction

| Point                   | Current understanding                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thesis                  | Learning tailored to student, class, and professor, with school-management overhead removed                                                                                  |
| Audience                | UW–Madison students broadly, not only CS students                                                                                                                            |
| Priorities              | Win BuildFest and selected awards; optional event launch; earn word of mouth                                                                                                 |
| Entries                 | Applied AI & Automation, DoIT Badgers Building for Badgers, Art of the Break                                                                                                 |
| Experience              | Least user effort, familiar apps, no repeated context uploading, more than chat                                                                                              |
| Working method          | Reference-driven design across research, architecture, interface, implementation, and verification; inspect and test the transferred mechanism                               |
| Current technical focus | Data access, local records, provenance, linking, and freshness                                                                                                               |
| Computation             | Code for exact facts; Jev for typed judgments; language models for prose and deeper reasoning                                                                                |
| Jev billing             | One Magic Canvas–owned key; we pay. Students need no Jev account or key. Keep the credential server-side behind our proxy                                                    |
| Identity scrubbing      | Before hosted processing, remove student identities and unnecessary personal identifiers; retain relevant instructor/author names. Policy accepted; scrubber not implemented |
| School actions          | Read only: no submitting, enrolling, or posting                                                                                                                              |
| Learning policy         | Course policy first; coach when vague or silent                                                                                                                              |
| Honesty                 | No false reassurance or unsupported readiness, speed, or reliability claims                                                                                                  |
| Visual taste            | Warm ivory/ember-red compact shell; selective Cooper Light BT and readable Geist; vibrant flat cards under comparison                                                                              |
| Current collaboration   | Shared context is pushed; runnable skeleton is pushed and implementation is authorized. Keep teammates informed without assigning work ownership                             |

## Resolved product decisions — September 26

- **Privacy:** course data and UW sessions live locally. Selected context may be sent to Jev and the hosted AI the student chooses. Clearly disclose the recipient, data categories, purpose, and applicable usage/retention settings. Offer guidance for disabling optional provider data uses; do not imply that disabling training disables all retention.
- **Four AI options only for now:** ChatGPT, Claude, Gemini, and a local model. Supporting any account with the three named providers is the intended requirement, including avoiding an assumed paid-plan prerequisite. Provider-specific feasibility and connection methods are not yet verified.
- **Minimal sign-in:** UW plus the chosen hosted LLM account. No separate Magic Canvas, Jev, model-hub, or infrastructure account should be required. With local AI, only UW sign-in is needed. User-completed Duo and later session renewal remain part of UW authentication.
- **Local AI is a built-in default alternative:** if the student does not choose a hosted AI, automatically identify a suitable open-source model for their system and handle the selection without making them research hardware or quantization. Exact selector/runtime/model is open. Fully local processing must also disable or replace hosted Jev; merely choosing a local language model does not do that.
- **Desktop first:** Mac and Windows are the product focus. The website provides information, working downloads, and GitHub links. iOS is later if time permits.
- **Jev billing:** one team-owned key, our bill, server-side proxy. No student Jev setup.

These are accepted directions. Account compatibility, hardware suitability, and data-control behavior must still be verified before being described as working capabilities.

## Product choices that can remain open

Home and navigation are now settled at the structural level: briefing-first Home with Upcoming, Study & Learn, quiet Today rail, and a collapsible Home/Courses sidebar. See [Home and visual direction](home-design-direction.md) for the full current contract and the new flagship demo objective. Earlier organizing concepts are retained as exploration history.

Still open: exact card color/interaction treatment, detailed course and work surfaces, floating pill/voice activation, provenance detail presentation, degree audit's role, and personalization from observed behavior versus explicit preference. The local visual prototype does not establish integrated capability.

No link threshold has been approved; the numerical sweep in [pipeline details](pipeline-details.md#link-thresholds-a-testable-starting-method) is an experiment proposal only.

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
- Apply [reference-driven design](reference-driven-design.md), including architecture by analogy, reference-led images, honest demo reconstruction, and verification of actual transferred behavior. Include relevant reference roles and checks in delegated briefs.
- Ask Ben about consequential ambiguity, clutter, complication, or unnecessary token/tool spend; keep ordinary coordination and context loading proportionate. Do not silently resolve conflicts with earlier direction.

## Accepted ingestion decisions — September 26

- Collect grader comments locally by default. Sharing them with hosted AI requires a separate category opt-in and, for MCP, a client grant.
- Accept and disclose incidental Canvas viewing/must-view effects caused by reads. This does not authorize explicit completion, submission, posting, or enrollment actions. Read accessible page bodies, prioritizing linked requirements; a teacher-controlled side-effect test is unavailable and is not a release gate for this behavior.
- Use app-owned UW sessions in the product; no personal-browser cookie importer. Ben subsequently authorized a narrow headless Firefox-session development check for planning/transcript evidence. That explicit exception supersedes the earlier prohibition for this investigation only. Approved browser bridges remain candidates, not product integrations.
- Preserve source-specific freshness during expiry; calendar feeds carry independent access and coverage. Excluded/restricted courses cannot enter AI context.
- Local MCP connections use explicit course/category grants and live revocation checks. Compatibility with each provider account is an evidence question, not a promise implied by implementing MCP.


## 2026-09-26 — Home briefing corrections and readable timing

See [Home design direction](home-design-direction.md) for the canonical current brief. Ben rejected fixed headline-per-task briefing units and vague labels. The briefing must surface specific, source-grounded implications, preparation needs, and useful updates, without requiring every sentence to have a button. Avoid redundant filler between Home regions. Filled time tags, prominent Upcoming deadlines, a readable top-task/bottom-calendar Today rail, and stronger blue accents are current direction. Color customization in Settings is accepted for later. Exact rendered treatment and the proposed allocation of today’s tasks versus future work remain under review. No production implementation is claimed.

The briefing also supports student-confirmed completion of specific actionable issues, with undo, persistent issue identity, source-version awareness, and explicit separation between self-report and source verification. Informational updates do not require checkboxes. This is accepted product direction; the local interaction does not update external course systems.


## 2026-09-26 — Cumulative UI direction and shared context

All UI work should synthesize the product goal, general guiding principles, shared docs, and relevant course corrections across the conversation. Check upstream changes regularly during substantial work and before pushing documentation; preserve teammates’ uncommitted changes. New prompts steer the existing objective rather than resetting the design. Record the reason and scope of corrections and verify their effect in the rendered journey. The full workflow is in [Home design direction](home-design-direction.md#cumulative-intent-and-ongoing-ui-review).


## 2026-09-26 — Named briefing references and continued alignment

Named objects within briefing prose should be visibly clickable and lead to context useful for the student's actual task. The current proposed routing distinguishes inspecting an object from explicit work launch; preserve one-click Upcoming behavior and avoid empty intermediary pages. See [clickable references](home-design-direction.md#clickable-references-and-useful-destinations) for the identity, evidence, keyboard, provenance, and return-position rules. Continue actual Opus 5.5 discussion and rendered audits for consequential UI work, retain cumulative corrections and relevant earlier-chat context, and ask when interpretations materially differ. Exact visual treatments remain under review.

## Planning decisions — September 26 update

- Primary navigation: **Home / Courses / My UW** with the Wisconsin crest; Email later. Holds and enrollment appointments can appear on Home.
- Rank evidenced degree progress before schedule preferences. Grades and professor ratings provide optional comparison evidence, never an easier-grading optimization target.
- Preserve independent Canvas, student-history, DARS, and eventual transcript claims. Do not convert percentages into letters, audit applications into earned credits, or recorded grades into mastery/readiness.
- Compare exact course/term identities only after fresh native account binding. Unknown/partial/stale evidence cannot establish eligibility, full degree coverage, or an all-clear state.
- Existing saved audits may be read; the app never generates audits or changes enrollment. Transcript access remains research-only until a production adapter is validated.
- All planning remains local and outside Jev, model context, and MCP. App-owned onboarding still needs live verification; the private developer transport does not satisfy it.

See [planning integration](planning-upgrade.md) for implementation evidence and remaining scope.
