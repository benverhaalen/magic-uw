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

Focus on four options: ChatGPT, Claude, Gemini, and a local model. The intended experience supports any account with the named hosted providers; exact account/plan compatibility and connection methods remain technical unknowns, not solved integrations.

The only required sign-ins should be UW and, when chosen, the hosted AI account. No extra Magic Canvas or Jev account. Local AI should require no model-service account: automatically pick a suitable open-source model for the student's system as the default alternative to hosted AI.

Explain what each hosted service receives and can use: selected course excerpts, prompts, conversation context, drafts or answers when relevant, and necessary metadata. Show the actual categories for each feature rather than implying every request sends everything. Never send UW passwords, cookies, or session tokens to an AI provider. Give clear, current provider-specific guidance for reducing optional data usage and explain which controls belong to Magic Canvas versus the provider.

Local storage is the default. Hosted Jev is separately disclosed and paid for by Magic Canvas. A local language model with hosted Jev is not a fully local processing mode; a fully local mode must replace or disable hosted judgments too. See [AI and privacy requirements](ai-and-privacy.md).

## Surfaces and interaction ideas — not settled

**Desktop first:** the full workspace for Mac and Windows. **Website:** product information, working downloads, and GitHub links. **iOS later:** a focused companion if time permits.

The [six organizing concepts](product-directions.md) compare time, task spaces, courses, outcomes, connected evidence, and the student's current activity as different foundations. They are open alternatives for Ben to react to; the existing Today screen does not settle the choice. The view ideas below remain available within that discussion, rather than constituting an agreed combined layout.

Potential home views:

- **Day:** a calm feed around today, with one useful action per item. Before class: prep. After class: review. Before an exam: practice. After grading: review feedback. Changed dates can show the previous value. Past work remains visible if incomplete.
- **Spaces:** resumable working sets for assignments, projects, clubs, applications, or personal study. Open the relevant browser pages, local files, editor, and terminal. Learn preferences from actual behavior, with visible correction.
- **Calendar:** fixed events and deadlines with an understandable workload indication. Estimated effort is a band, not a fabricated exact duration.

A persistent small text/voice control may work across views. Sidebar organization, artifact placement, default view, and floating pill placement are open. A recommendation is to keep navigation stable while adapting content and suggested actions; test whether dynamic rearrangement makes things harder to find.

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

Calm, familiar, neutral and light. Thin borders, compact spacing, small readable sans serif text, little color, and one clear focus. Course color, if used, is a tiny accent. No serif fonts, colored dots beside class names, filler greetings, or motivational copy. Use actual student content in evaluation; use clearly synthetic content in public fixtures.

The Codex desktop app is an interaction/visual reference, not a specification to clone. Compare concrete screens before settling the layout.

For concept images, use inspected reference folders as inputs, repair bad downloads, prompt minimally around the task and essential constraints, and iterate with Ben's feedback. For implementation, inspect hierarchy, navigation, density, feedback, failure recovery, accessibility, and responsiveness in the rendered journey. Raise clutter and complexity instead of accumulating every reference pattern. The [reference guide](reference-driven-design.md) records the exact method and what each reference contributes.

## Claims and competitive posture

Complement the AI and study tools students already use. Do not criticize Google. Do not promise every existing study feature “but better” before testing. A fair comparison gives the competing tool a strong setup, uses questions written beforehand, and reports where it wins.

Avoid promises of universal course coverage, guaranteed correctness, impossible cheating, instantaneous updates, universal subscription access, or validated readiness. Broad ambition is compatible with a specifically demonstrated prototype.
