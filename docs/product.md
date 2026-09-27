# Product brief

## Thesis and audience

Magic Canvas is an AI workspace that already knows a student's classes and turns available time into learning that fits the class, professor, rubric, and student's current understanding.

Students spend attention managing school: requirements are scattered, email is noisy, administrative systems are disconnected, and generic AI lacks course context. We want to give that attention back. The intended audience is any UW–Madison student, including students who already like their study methods.

The event audience will likely skew technical. The product story should still make sense to nursing, humanities, business, and math students. Testing only our own CS courses cannot establish broad coverage.

## What should feel magical

- The relevant assignment and its instructions are already together.
- The next action opens what the student needs in familiar apps.
- Asking a short question works because course context is already available.
- Practice reflects this course's expectations and what the student needs to work on.
- The product notices a meaningful change and explains it with evidence.
- Uncertainty is handled before it becomes a missed requirement.

**Working differentiation hypothesis:** the transition from knowing the class, to acting on its requirements, to useful practice is our advantage. Test this. Grounded answers, flashcards, and audio alone do not establish a distinctive product.

## Principles

1. Minimize total user effort, including correction and recovery. Avoid unnecessary setup or confirmation. Learning itself can require productive effort.
2. Respect the course's AI policy before helping. Cite the policy when it limits a request and offer an allowed next step. If vague or silent, coach.
3. Read school systems; do not submit, enroll, post, or send explicit completion commands. Reading may register views or satisfy must-view requirements. This incidental effect is accepted and must be disclosed; the exact affected endpoints remain unverified.
4. Keep the authoritative store and sessions on the student's device. Hosted inference is a separate data disclosure, not local-only processing.
5. Render cached facts immediately. Slow generation enhances a usable screen; it does not gate first paint.
6. Give consequential facts a source and freshness. Keep automatic links explainable and reversible.
7. Distinguish unavailable, unpublished, stale, empty, and genuinely absent information.
8. Use familiar interactions. Show an artifact when interaction helps more than reading.
9. Never invent a readiness percentage, calibrated confidence, latency, or reliability result.
10. A rehearsed or seeded demonstration is fine when labeled. Never silently substitute fixtures for failed live data.
11. Build and verify through [reference-driven design](reference-driven-design.md). Borrow inspected mechanisms intentionally, including from products outside education. Keep the whole student journey and actual content in the evaluation; a polished image is a hypothesis, not a completed product.

## AI choice, sign-in, and data transparency — decided

The accepted launch direction is a $5 one-time app license plus the student's own paid AI plan or key. Intended routes are Claude Code, Codex, Gemini CLI with a paid key, and OpenRouter. The license covers the service and company-funded Jev, not language-model usage. Exact account/plan compatibility and authorized connection methods still need verification. See [the pricing and AI resolution](decisions.md#pricing-and-ai-access-resolution--september-26).

Minimize setup by detecting supported installed clients and using their own authentication flows where permitted; otherwise guide the student through setup. UW sign-in, provider setup, and license activation are the intended prerequisites, without an extra Magic Canvas or Jev user account. The existing local-model adapter remains available in the development foundation; automatic local-model setup is no longer a launch requirement.

Explain what each hosted service receives and can use: selected course excerpts, prompts, conversation context, drafts or answers when relevant, and necessary metadata. Show the actual categories for each feature rather than implying every request sends everything. Obtain consent per provider, show context and receipts per request, and require a blocking preview for a newly shared sensitive category or an enabled always-preview preference. Keep the exact payload inspectable and enforce grants on every request. Never send UW passwords, cookies, or session tokens to an AI provider. Give clear, current provider-specific guidance for reducing optional data usage and explain which controls belong to Magic Canvas versus the provider.

Local storage is the default. Hosted Jev is separately disclosed: Magic Canvas pays through its gateway for Claude/Codex/Gemini routes; the accepted OpenRouter route uses the student’s key and bill, with implementation still pending. A local language model with hosted Jev is not a fully local processing mode; a fully local mode must replace or disable hosted judgments too. See [AI and privacy requirements](ai-and-privacy.md).

## Surfaces and interaction direction

**Desktop first:** the full workspace for Mac and Windows. **Website:** product information, working downloads, and GitHub links. **iOS later:** a focused companion if time permits.

The current [Home and visual direction](home-design-direction.md) is the canonical surface decision: briefing-first Home, compact graded Upcoming, tailored Study & Learn, a quiet right Today calendar, and one collapsible left Home/Courses/My UW/Calendar sidebar. Home is the hackathon flagship. It must connect evidence to a useful next action and the right working context. The earlier [organizing concepts](archive/product-directions.md) remain background exploration, not six still-unresolved Home choices.

Spaces and familiar external apps support the assignment/work journey. Voice and the floating control remain open interaction ideas; Ben has explicitly requested Calendar alongside Home: current week by default, week/month views, commitments and accepted study blocks normally, and suggestions on request. Home's Today rail remains a compact daily projection. See the [calendar review](design/platform-handoff.md#seans-calendar-work).

**Assignment detail:** cached title, course, submission location, points, date claims/resolution, source age, supporting materials, and an actionable brief. Later: evidence-backed progress, rubric feedback, relevant policy, and meaningful changes. A personal checkbox and verified submission are different states.

**Spaces:** prefer a small useful default set with more resources available, rather than making every launch a long selection form. This is a hypothesis to compare with Ben's prechecked resource-list idea.

**Voice:** direct the workspace naturally. Resolve commands and targets from known options. Jev receives text from speech recognition, not raw audio. Explore no-wake-word detection, but measure unintended activations. Start with safe prefetch and explicit listening in an experiment before relying on ambient execution. Reversibility alone does not make a premature action welcome.

## Learning direction

Use one general loop: **inventory → profile → spec → candidates → gates → deliver → observe → audit**.

- Build the assessment specification from cited rubrics, exams, schedules, and lectures.
- Generate variants from the skill and misconception being tested. Check both copying and drift from the course.
- Independently solve questions; use executable checks when possible. Model agreement alone is not proof.
- Coach with short feedback: what is right, one gap, one next step. Use the smallest helpful hint and one question at a time.
- Record exposure, hints, assistance, confidence before feedback, and performance. A newly explained answer is weak evidence of independent ability.
- Use honest skill states: solid, shaky, untested, or overconfident. Initial readiness may be “not enough evidence.”
- Evaluate readiness with unseen exam-style items. If there are no past exams, identify the available evidence and limits.

Possible modules include quizzes, faded examples, error spotting, simulations, concept maps, comparisons, flashcards, code sandboxes, derivations, discussion prep, and exam replays. Later ideas include lecture clips, audio, concept side threads, policy-compliant exam sheets, and rubric pre-grading with evidence and ranges. These are the learning feature ideas currently under discussion.

Scheduling ideas include prep anchored to real classes, review after lectures, practice spaced before exams, and assignment starts based on effort bands. Avoid hardcoding “nothing new in the last two days” as a universal learning rule.

## Visual direction

Current direction: warm ivory content, an ember/red gradient sidebar with a thin wrapping frame, compact native Mac/Codex-like controls, and deliberately colored action cards. Supplied Lora Medium (500; replaced Cooper Light BT on September 27) is used selectively for identity and editorial titles, with readable Geist prose and controls at normal tracking. Vibrant card mechanisms are under comparison. This supersedes the earlier little-color/no-serif preference. The [canonical visual direction](home-design-direction.md) records the constraints and open choices.

For concept images, use inspected reference folders as inputs, repair bad downloads, prompt minimally around the task and essential constraints, and iterate with Ben's feedback. For implementation, inspect hierarchy, navigation, density, feedback, failure recovery, accessibility, and responsiveness in the rendered journey. Raise clutter and complexity instead of accumulating every reference pattern. The [reference guide](reference-driven-design.md) records the exact method and what each reference contributes.

## Claims and competitive posture

Complement the AI and study tools students already use. Do not criticize Google. Do not promise every existing study feature “but better” before testing. A fair comparison gives the competing tool a strong setup, uses questions written beforehand, and reports where it wins.

Avoid promises of universal course coverage, guaranteed correctness, impossible cheating, instantaneous updates, universal subscription access, or validated readiness. Broad ambition is compatible with a specifically demonstrated prototype.

## Planning: current scope

The accepted primary sidebar is **Home / Courses / My UW / Calendar**, with a Wisconsin crest for My UW; Email is deferred, and Sources/Data & AI remain utilities. My UW makes degree requirements, course options, holds, and enrollment timing understandable while leaving every academic decision and school-changing action to the student. Home can surface holds and appointments. The official service handles enrollment.

The [planning handoff](planning-upgrade.md) states what is implemented and proven: native enrollment/history/saved-audit adapters, public course search and packages, a separate local planning store, and source-preserving academic comparisons. Progress outranks schedule fit; historical grades remain evidence. Results are individual options, not a combined schedule or guaranteed requirement approval. Unknown evidence stays unknown. Canvas gradebook results, recorded attempts, and DARS applied credits are distinct facts; agreement does not prove mastery. Existing unofficial transcript access has been researched, but production ingestion is unfinished. Natural-language planning and proposed calendars remain future work.
