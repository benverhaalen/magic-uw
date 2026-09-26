# Agent work principles

Project guidance from Ben, September 26, 2026. Applies to research, design, implementation, and review. This guide preserves the general methods; [reference-driven design](reference-driven-design.md) makes them concrete for Magic Canvas. Apply methods when useful and keep simple work simple.

## Outcome and understanding

Finish the requested outcome with responsible use of time, model capacity, and context. Keep deep reasoning for uncertain or consequential decisions. Explain important choices and results plainly; keep routine coordination brief.

Identify the audience, outcome, constraints, and reason for the task. Separate requirements from examples, preferences, tentative ideas, and suggested methods. An example is evidence of intent, not the entire scope. Before substantial implementation, define a complete journey from its normal entry point and observable success. Ask focused questions when interpretations materially differ, and continue independent work while waiting. Carry corrections into the decisions and artifacts they affect.

Ask Ben if a proposal could add material clutter, complication, or unnecessary token/tool spend. State what it adds, why it might earn its cost, and the simpler alternative. Use judgment on routine choices and do not turn authorized work into repeated approval requests.

## Discover the mechanism

Describe a failure independently of the product's vocabulary: which data, control, incentive, or feedback relationship is failing? Investigate that mechanism before optimizing the current solution. Search direct solutions and structurally similar work in other fields, including older, neglected, or other-language work when it could change the decision. Preserve original wording where translation affects meaning.

Check whether an analogy's assumptions hold. When explanations predict different results, use a small discriminating check. Test the evaluator when results are surprising. If repeated local fixes do not improve the outcome, revisit the framing, objective, context, and measuring tool.

Look for a reputable specialist procedure when needed. Check its author, scope, maintenance, examples, and observed results. Load only relevant skill instructions. A skill is a method to try, not proof of quality; a task-specific method should not become an unsolicited global rule.

## References and existing work

Give each reference a specific job and inspect enough of its content, behavior, or code to transfer that property. Distinguish observations, author-stated reasons, hypotheses, and measured effects. Keep contradictory evidence visible and say what would invalidate the transfer. Follow the [reference guide](reference-driven-design.md) for the record and review method.

Before building a replacement, inspect existing software's behavior, license, maintenance, compatibility, and integration cost. Adapt the smallest useful mechanism and connect it to the normal entry point. Avoid a second framework or service where the current surface suffices. Keep boundaries easy to change. Use a skill or brief instead of runtime machinery when that solves the need. Preserve attribution and licenses; strict clean-room work separates source access from an approved behavioral specification given to the builder.

## Product judgment and idea selection

Infer the audience, real content, tasks, and constraints before selecting a visual direction. Inspect existing assets and the current product. Identify gaps in hierarchy, navigation, density, interaction, feedback, recovery, accessibility, and responsiveness; find references that address those gaps.

Generate materially different candidates when the solution space matters. Set criteria before scoring. Keep feasibility, expected value, uncertainty, and downside separate; calculate known values exactly. Do not treat model scores as calibrated outcome probabilities or multiply correlated judgments as though independent. Test the strongest opposing explanation.

Use concrete alternatives for consequential taste decisions, holding unrelated properties stable. Allow rejection, combination, or a new proposal. Resolve conflicts between references before composing the direction, then inspect the rendered artifact and complete journey. Technical checks support product judgment; they do not replace it. The [current organizing concepts](product-directions.md) remain separate proposals until Ben reacts.

## Delegation, context, and cost

Keep one driver responsible for the complete outcome. Give each worker one coherent deliverable, the goal and constraints, relevant evidence and reference roles, access to originals, and success checks. Use compact briefs instead of the entire conversation when sufficient. Let workers inspect, implement, check, and resolve ordinary failures; bring the driver back for changed requirements, architectural conflicts, and integration choices.

Delegate when separate context, expertise, or parallelism improves the result enough to repay handoff and review. Keep small lookups local. Collect an independent critique before revealing a favored answer. Agreement is not proof; disagreement points to evidence or a discriminating check. Review actual changed files, source claims, and effects before integration.

Keep the goal, constraints, corrections, and consequential decisions available. Store large captures outside active context and retain retrieval paths; private captures stay outside Git. Select evidence at the point of use, including contradictions. Prefer targeted reads and compact tool output. Avoid repeatedly loading the same material.

Compare total effort per accepted result: driver, workers, tools, retries, review, repair, latency, and quality. Use a strong model where its judgment matters and a cheaper capable model for well-specified work when supported. A cheaper individual call is not necessarily a cheaper completed task. Do not claim savings without measurements.

## Verification and continuity

Trace important requirements through the selection rule, code path, tool result, or artifact that produced the answer. Check default state, normal journey, corrections, and consequential failures. Close material gaps before claiming completion. Separate research, implementation, isolated testing, integration, and demonstrated use; report observed costs separately from estimates.

Preserve useful context in existing project notes. Use a private scratch area for operational details and never commit secrets or private captures. Update affected decisions rather than expanding global configuration. When feedback contradicts passing checks, revise the diagnosis and evaluator before repeatedly patching the same output.


### UI continuity across prompts

For UI work, combine the product objective, these principles, current project docs, and cumulative relevant feedback. Fetch and inspect upstream changes before substantial revisions and before sharing updates; integrate compatible changes safely without disturbing teammates’ local work. Preserve the reason and scope of corrections, distinguish decisions from suggestions, and verify that the actual rendered journey reflects them. [Home and visual direction](home-design-direction.md#cumulative-intent-and-ongoing-ui-review) carries the current UI contract and review loop. This is a per-work-session practice, not a promise of unattended monitoring.
