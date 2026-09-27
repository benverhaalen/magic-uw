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
| Jev billing             | Company gateway pays for Claude/Codex/Gemini; OpenRouter users pay through their own key. Our TypeSafe key stays server-side. OpenRouter route is not built |
| Identity scrubbing      | Before hosted processing, remove student identities and unnecessary personal identifiers; retain relevant instructor/author names. Policy accepted; scrubber not implemented |
| School actions          | Read only: no submitting, enrolling, or posting                                                                                                                              |
| Learning policy         | Course policy first; coach when vague or silent                                                                                                                              |
| Honesty                 | No false reassurance or unsupported readiness, speed, or reliability claims                                                                                                  |
| Visual taste            | Warm ivory/ember-red compact shell; selective Lora Medium (500, bundled; replaced Cooper Light BT September 27) and readable Geist; vibrant flat cards under comparison |
| Current collaboration   | Shared context is pushed; runnable skeleton is pushed and implementation is authorized. Keep teammates informed without assigning work ownership                             |

## Resolved product decisions — September 26

- **Privacy:** course data and UW sessions live locally. Selected context may be sent to Jev and the hosted AI the student chooses. Clearly disclose the recipient, data categories, purpose, and applicable usage/retention settings. Offer guidance for disabling optional provider data uses; do not imply that disabling training disables all retention.
- **Paid AI and app license:** Ben accepted Nathaniel's direction later on September 26: a $5 one-time app license, with the student paying for their own supported AI plan or API key. This supersedes the earlier any-account/no-paid-plan requirement and local AI as the launch default alternative. See [the recorded resolution](#pricing-and-ai-access-resolution--september-26).
- **Minimal setup:** reuse supported installed provider clients through their own sign-in where permitted; otherwise guide setup. UW sign-in, a supported provider plan/key, and license activation are the intended prerequisites. No extra Magic Canvas or Jev user account is intended. User-completed Duo and later session renewal remain part of UW authentication.
- **Existing local AI:** retain the installed-model adapter and local privacy controls as implemented capabilities; they do not establish a free-account launch offering. Managed model installation is deferred. Fully local processing must disable or replace hosted Jev.
- **Desktop first:** Mac and Windows are the product focus. The website provides information, working downloads, and GitHub links. iOS is later if time permits.
- **Jev billing:** Claude/Codex/Gemini use our funded gateway and its server-side key. OpenRouter users pay for Jev through their own OpenRouter key; no separate TypeSafe account is intended. This exception is accepted direction, not an implemented route.

These are accepted directions. Account compatibility, hardware suitability, licensing/payment behavior, and data controls must still be verified before being described as working capabilities.

## Product choices that can remain open

Home and navigation are now settled at the structural level: briefing-first Home with Upcoming, Study & Learn, quiet Today rail, and a collapsible Home/Courses/My UW/Calendar sidebar. See [Home and visual direction](home-design-direction.md) for the full current contract and the new flagship demo objective. Earlier organizing concepts are retained as exploration history.

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

- Primary navigation: **Home / Courses / My UW / Calendar** with the Wisconsin crest; Email later. Holds and enrollment appointments can appear on Home.
- Rank evidenced degree progress before schedule preferences. Grades and professor ratings provide optional comparison evidence, never an easier-grading optimization target.
- Preserve independent Canvas, student-history, DARS, and eventual transcript claims. Do not convert percentages into letters, audit applications into earned credits, or recorded grades into mastery/readiness.
- Compare exact course/term identities only after fresh native account binding. Unknown/partial/stale evidence cannot establish eligibility, full degree coverage, or an all-clear state.
- Existing saved audits may be read; the app never generates audits or changes enrollment. Transcript access remains research-only until a production adapter is validated.
- All planning remains local and outside Jev, model context, and MCP. App-owned onboarding still needs live verification; the private developer transport does not satisfy it.

See [planning integration](planning-upgrade.md) for implementation evidence and remaining scope.


## Pricing and AI access resolution — September 26

Ben resolved the pricing/provider disagreement with: "nathaniels is the way" (this project conversation, recorded September 26; original message timestamp unavailable). The question explicitly contrasted Nathaniel's paid-AI/$5 direction with the earlier any-account/local alternative. Nathaniel's original proposal is preserved in [business model](https://github.com/benverhaalen/magic-uw/blob/5bf86f7be3eac8e85fa5ccb2a0e925a721ca24f3/docs/notes/business-model.md) and [agent runtime](https://github.com/benverhaalen/magic-uw/blob/5bf86f7be3eac8e85fa5ccb2a0e925a721ca24f3/docs/notes/agent-runtime.md).

- A **$5 one-time app license** covers the service and company-funded Jev; it does not include the student's language-model usage. Payment provider and license activation are unimplemented. This decision does not change the repository's MIT license.
- Intended paid routes are **Claude Code with a supported paid Claude plan, Codex with a supported paid ChatGPT plan, Gemini CLI with a paid API key, and OpenRouter with the student's key**. Installed-client detection, isolation, authorized authentication, current terms, data destinations, and actual inference must be verified per route. These names describe intended integration paths, not working adapters or legal conclusions.
- Keep school data local and hosted sharing off until consent. Buying the app or connecting a paid provider is not permission to upload every record. Planning remains outside AI/MCP context under its existing boundary.
- **Jev exception accepted:** Ben chose "Adopt Nathaniel’s exception": OpenRouter users pay for Jev through their own OpenRouter key. Claude/Codex/Gemini users use the company-funded gateway. Our TypeSafe key stays server-side; a student's OpenRouter key must stay in protected local credential storage and never enter model context, logs, or Git. The actual OpenRouter judgment adapter and billing route remain unverified.
- **Disclosure flow accepted:** Ben chose "Adopt this flow (Recommended)": consent once per provider, visible selected context and a receipt per request, with a blocking preview for the first sharing of a new sensitive category or when the student enables **always preview**. Keep the exact outgoing payload inspectable. Code must enforce course/category grants and revocation on every request; ongoing consent does not permit new categories or recipients. Disclosure timing does not relax data minimization or identity scrubbing.
- These answers resolve commercial direction, paid-provider access, Jev billing, and disclosure timing. Other research-branch choices, including runtime permissions and storage/MCP architecture, still need scoped integration review; this is not a blanket branch merge.
- Existing local-model code stays documented honestly. Automatic local model setup is no longer a launch requirement. No runtime, payment, or account settings were changed by this documentation correction.

## Design foundation and handoff — September 26

Ben selected foundation/handoff before Electron implementation and described the cohesive Home as approximately 95% desired. Preserve it through the [portable constitution](design-handoff.md). His latest Calendar decision accepts week/month views, current-week default, and suggestions on request; detailed interaction and implementation remain pending. Original quotes, scoped inferences and open refinements live in the [decision record](design/decision-record.md). The repo skill routes by task and uses independent reviews with original constraints; neither a pull nor a passing critic proves adoption or product integration.

## 2026-09-26 — Today rail suggestions and day plan

Implemented on `sean/today-calendar-rail`. **Aligned with Ben's accepted Today/Calendar contract** ([component contracts](design/component-contracts.md)): normal content is commitments and accepted study blocks, with suggestions on request; proposed and accepted minutes stay separate; one work projection (`projectWork`) feeds both Home's Upcoming and the rail. Sean confirmed on September 26: “build based on bens design docs, agree to what he has.” The ranking details below remain proposals for Ben's review. Source: Sean, this project conversation, September 26 (original timestamps unavailable). Exact requests include:

> i dont want the calendar to feel crowded … look at priority of assignments and things to get a deeper understing on how to suggest ways to fill your day

> these tasks should cross out if submitted on canvas, as it pulls this data or be manually done if it is a task like studying or going over notes

Implementation choices, in code at `packages/domain/src/today-rail.ts`:

- **Priority order:** overdue work Canvas still accepts before its lock date; due within 24 hours; tight for its estimated effort; spaced exam review; then other work due this week. Soonest due date breaks ties. Grade share orders only the last group, and only when that course's assignment-group weights total 100%. Raw points are never compared across courses.
- **Effort** is a typical range by item type, labeled an estimate; unknown types say so. **Exam review** is split into sessions (up to three) because spaced practice outperforms cramming.
- **Breathing room:** at most 3 hours of suggested work, 3 work blocks, 15-minute breaks after blocks and classes, nothing within 15 minutes of now or after 10 PM, and prep only before titled class sessions.
- **Completion:** assignment blocks cross out only on a Canvas-reported submission; study blocks (prep, exam review) are marked done by the student as a self-report. Skipped blocks do not return that day; edited blocks keep the student's time and title.
- **Storage:** decisions are one local `preferences` entry (`dayPlan`), chosen over a new table to avoid changing the shared schema version during the event. Revisit with a dedicated table if the plan grows beyond a day view.

Open for Ben: styling within the Home visual direction, whether the cap/cutoff should become settings, and multi-day planning.

## 2026-09-27 — Editorial face: Lora Medium

Ben supplied `Lora-Medium.ttf` and asked: “replace the cooper font with this font across everything in the app including website and everything mentioning cooper and then push the changes” (recorded September 27; message time unknown). Unmodified Lora Medium at weight 500 now fills the former Cooper roles in the desktop app, the informational website headings, the design lab and the marketing drafts' display text. Geist and layout are unchanged. The font and its OFL are tracked in `packages/ui/assets/fonts` and copied into both build outputs. Provenance and the treatment of earlier Cooper screenshots are in the [decision record](design/decision-record.md#editorial-face--recorded-september-27-2026-original-message-timestamp-unknown).
## 2026-09-27: Today rail meeting details from the Microsoft calendar

Merged in [PR #15](https://github.com/benverhaalen/magic-uw/pull/15). The Graph calendar ([#12](https://github.com/benverhaalen/magic-uw/pull/12)) supplies each meeting's join link, provider, and the student's response; before this, the rail ignored all three and a declined meeting still blocked study suggestions. Rules, in code at `packages/domain/src/today-rail.ts` and `apps/desktop/src/renderer/TodayRail.tsx`:

- **Declined** meetings stay on the schedule, struck through, so the student can see what they turned down. They hold no busy time, get no prep block, and do not trigger an overlap warning when a study block is edited over them.
- **Tentative and unanswered** meetings still hold their time. This is the cautious choice: a suggestion placed over a meeting the student later accepts is worse than a missed free slot. They are outlined dashed and dotted.
- **Join** appears only for a plain https link with no embedded credentials, checked in the rail and again by the https-only `openLink` bridge, and never for a declined meeting. Opening it is always the student's own click.
- **Provider badges** name Teams, Zoom, Webex, or Meet from the calendar's own field, not a guess from the title.

Proposed for Ben's review, not yet accepted direction: whether declined meetings should disappear instead of showing struck through.

## 2026-09-27: Manual UW GitLab project links

Merged in [PR #18](https://github.com/benverhaalen/magic-uw/pull/18). GitLab projects were discovered only when Canvas material linked them, so a course that names its repository in prose or in class had no way to connect it. The fallback:

- A student pastes a project link; the existing `gitlabProjectFromUrl` accepts only `git.doit.wisc.edu` group/project paths, not user pages or the API. Anything else is refused with a message saying what to paste.
- The course must be in the student's saved coursework for that account, so a link cannot attach to a course the app does not know.
- Links are local preferences, capped at 200 and cleared by Delete local data. No new network access: a linked project is read by the existing GitLab connector with the app-owned GitLab session.

Open for Ben: where the "link a GitLab project" input belongs on screen (Sources, or the course page). Until it has a screen, students cannot use it.

## 2026-09-27 — Notifications and Jev announcement triage

Implemented on `feat/notifications` (Aidan's session). A bell in the top bar opens a notifications dropdown built from stored changes. Source: Aidan, this project conversation, September 26–27 (original timestamps unavailable). Exact requests:

> lets think through all of our data sources and what new information should be flagged as important enough to warrant a notification … This should be in some way evaluated by our deterministic model.

> we are going to implement jev to run through announcements … we trust that we can train the model to work so we want to follow through with this as a feature

Decisions and their reasons:

- **Code decides every level** (urgent, important, info) from typed changes, current Canvas state and source health. Rules and thresholds live in one file, `packages/domain/src/notifications.ts`. A source's first import is a baseline, never news.
- **Jev triages new course messages only** (announcements and discussions), through a new `message.triage.v1` gateway question. It may only **raise** a message's level, never lower, hide or dismiss one. It never receives grades, comments, planning records, URLs or account identifiers. It runs only with selective cloud, Jev enabled, a Jev consent record, and permission to share communications and course text.
- **Deviation from the proposed Jev rules:** [Jev usage](notes/jev-usage.md) proposes shadow mode and 20–30 labelled examples per question before enforcing. By Aidan's decision above, triage is enforced from the start, raise-only, with provisional uncalibrated thresholds (Choice top ≥ 0.70 with a 0.15 lead; yes ≥ 0.70). Consequence: early false alarms are possible; nothing can be hidden. Refit the thresholds on labelled announcements and record the evaluation before calling triage accurate.
- **Grades show the score in the row** (“Research outline: 18/20”), by Aidan's choice over score-on-open. The grade is visible whenever the dropdown is open; it stays local.
- **Email (added after main gained Graph mail, #12).** Aidan chose which email can notify: advisor mail, course staff, university offices, meeting cancellations, job-interview invitations, clubs and publication updates, and relevant campus events; mail already read in Outlook never counts toward the badge. Canvas notification emails are dropped because the Canvas change already notifies. Code sets every level from the mail's code category and literal subject/preview rules. Jev (`mail.triage.v1`) may raise, never lower; it receives only the code's sender role, the subject and Outlook's ≤255-character preview (identity-scrubbed), plus a matched course's upcoming work, never a sender name or address. Mail reading itself has not yet run against Microsoft or UW (E1 pending), so email notifications are demonstrated on synthetic mail only.
- **Placement:** mounted in the current top bar; Ben's Home layout owns the final position.
- **Announcement rule tightened after the field-test benchmark.** Any single keyword ("deadline", "quiz", "location") used to make an announcement important, which marked about half of a real student's announcements important. It is now judged per sentence: a clear change phrase (cancelled, no class, postponed, moved to, room change) or a topic word together with a change word in the same sentence, unless a negation says nothing changed. Aidan, September 27: “exam should always flag as important, different than deadline or assignment” — so exam, midterm and final mentions stay important on their own. Quizzes follow the change-word rule. The same test decides urgent course-staff email.
