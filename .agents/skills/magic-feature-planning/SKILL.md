---
name: magic-feature-planning
description: Inventory Magic Canvas feature gaps, recommend the next product capability, explore a selected feature, and carry its brief into authorized architecture, implementation, and review. Use for missing or minimal frontend features and what to build next; planning alone does not authorize product code.
---

# Magic feature planning

Turn the product thesis into complete student capabilities: learning tailored to the student, class, and professor, with less school-management effort. Desktop comes first. Aim for excellent, inspectable implementations; do not promise perfection or confuse a detailed plan with working software.

## Start at the requested depth

Locate the Magic Canvas repository from the working context; establish its root before resolving the repo-relative paths below. Do not assume a machine-specific path. Read `AGENTS.md`, `docs/README.md`, `docs/implementation-status.md`, and relevant sections of `docs/product.md`, `docs/decisions.md`, `docs/agent-work-principles.md`, and `docs/reference-driven-design.md`. Follow active coordination instructions if present; temporary handoffs may later be removed. Then inspect the affected code and relevant branch/handoff evidence. Read only what can change this task's decisions.

Briefly state the intended student outcome, why it matters now, scope, and consequential assumptions. Preserve the requested mode:

- **Inventory / next feature:** establish actual capability and recommend a small set of meaningful next outcomes.
- **Explore a selected feature:** develop its journey, mechanisms, alternatives, and a bounded buildable brief.
- **Architecture:** resolve the interfaces and uncertainties needed for that feature without building a general platform.
- **Implement / review:** only when authorized, carry the brief through the actual application and check the complete result. Existing authorization persists; do not ask again ceremonially.

A discussion, research question, or planning request produces discussion, research, or a plan. It does not authorize product code. Follow-up questions steer the existing objective unless the user changes it.

## Questions guide the agent, not a questionnaire for Ben

Answer most questions below from the conversation, accepted decisions, source evidence, inspected code, experiments, and professional judgment. Research technical unknowns rather than assigning them to Ben. Keep user questions few: ask when unresolved intent, privacy, scope, conflicting human decisions, or consequential clutter/complexity/cost would materially change the result. Explain the concrete tradeoff and recommendation; wait before dependent work and continue useful independent work. Never make silence an answer.

Preserve the near-approved Home and navigation. Use the repo's `magic-design` skill for UI design, implementation, or audit, with `DESIGN.md` as its entry point. Do not reopen accepted taste each time a feature is added. Compare only consequential open choices using concrete artifacts when needed.

## Establish the actual gap

Inspect the normal student entry point and default state, then trace renderer → bridge/API → service/worker → storage/evidence → visible result. A backend function, mock, test, or branch claim does not establish an available feature.

For each relevant capability, record its accepted/proposed status, implementation location and revision, user entry, and evidence of use. Distinguish:

- **Missing:** no implementation found within the explicitly searched scope.
- **Partial:** a useful portion exists; name what is absent, including minimal frontend behavior.
- **Unconnected:** implementation exists but the normal journey cannot reach or use it.
- **Unverified:** code or integration exists without evidence for the claimed behavior/environment.

These labels can overlap. Distinguish unavailable evidence from absent software, and proposals from accepted decisions. Inspect relevant branches and team handoffs before duplicating work; report search/freshness limits. Never merge or switch a shared checkout automatically. A branch name does not establish ownership or adoption.

Rank the next capability against the learning thesis, student value, reduction in management/recovery effort, reuse of available course evidence, desktop fit, BuildFest demonstration value, trust, feasibility, and remaining uncertainty. Read `docs/buildfest.md` when event priorities affect the ranking. Do not let the most recently touched subsystem set the roadmap. Separate a compelling end-to-end demo from evidence of broad readiness. Recommend a winner with reasons, dependencies, and what could change the choice; avoid invented precision in scores.

## Shape the complete capability

Start from available evidence and the complete student outcome. For learning features, use the tailoring loop in [learning and media](references/learning-and-media.md); other features need only the steps that help their actual task.

Resolve these guiding questions in the brief:

- **Outcome and timing:** What can the student do afterward, why now, and what observable result would show value?
- **Context and tailoring:** Which existing course, professor, rubric, material, and student evidence makes the experience fit? How does that evidence change the chosen task, explanation, support, or feedback? Name substitution is not tailoring. Reuse context instead of repeated uploads/setup; keep unknowns and corrections visible.
- **Data opportunity and limits:** Inspect what we actually capture and can lawfully use, not just schema slots or connector names. What useful capability does that evidence enable that the student would otherwise have to explain? Check field meaning, coverage, granularity, freshness, conflicting sources, and permitted destinations; compare richer context against latency, privacy, and cost. Follow the data review in [implementation decisions](references/implementation-decisions.md) for consequential data-dependent features.
- **Effort and agency:** What management work disappears, including repair after failure? Productive learning effort may remain. Prefer one relevant next action over nagging, mandatory diagnostics, or a dashboard of obligations. Include skip, dismiss, correct, and resume where relevant.
- **Form:** Does this task benefit from a short answer, existing app/resource, artifact, worked example, simulation, practice, or another surface? Choose by the learning/work task; neither chat nor quizzes are the default for everything. Add interactive controls only when interaction beats reading. A durable reading artifact, such as cited study notes or a permitted exam sheet, needs a concrete reuse, comparison, or export benefit over an inline answer.
- **Journey:** From the normal entry/default, what happens through meaningful success, return, and interruption recovery? Include empty, partial, stale, unavailable, policy-limited, and cancellation behavior where consequential. Cached evidence should remain useful while generation runs.
- **Mechanism and boundary:** What is already available, what must change, and which uncertainty deserves a small experiment? What are the non-goals and completion criteria?

Use [the feature brief](references/feature-brief.md) as a compact working record for substantial work, not mandatory paperwork for small changes. Read [implementation decisions](references/implementation-decisions.md) when evaluating mechanisms, architecture, AI use, or an authorized build. Read [learning and media](references/learning-and-media.md) only when those capabilities are relevant; its options are not a required feature bundle.

## Carry the decision into delivery

For authorized implementation, keep one driver responsible for the whole journey. Carry the objective, accepted constraints, exact evidence, selected mechanisms, and observable checks into any scoped delegate assignment, design, code, tests, and affected docs. Reuse the installed Jev agent workflow according to repository instructions; do not confuse that development workflow with a requirement to add hosted Jev to the student feature.

Trace each important requirement through the operation that actually produces the result. Verify the normal default journey and consequential recovery with appropriate real content, policy/privacy checks, rendered interaction, and technical checks. Test count, build success, screenshot polish, and a second model's agreement do not establish student value or correctness. Inspect delegated outputs yourself.

Finish the authorized scope, close material integration gaps, and update canonical docs when claims change. Report what is proposed, built, tested in isolation, integrated, and demonstrated only to the extent useful for the task. Describe remaining limits precisely. Keep private evidence out of Git; commit or publish only when authorized.
