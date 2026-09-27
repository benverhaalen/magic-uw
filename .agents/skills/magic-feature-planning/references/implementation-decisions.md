# Mechanisms, architecture, and delivery

## Make references change the implementation

Start from the underlying problem rather than a product name. Search direct solutions and structurally similar systems outside education when a different mechanism could matter. Useful jobs include evidence, interaction, visual direction, architecture, or implementation; a named product is only a search handle.

Inspect the relevant current artifact, behavior, documentation, or permitted code. Record observed behavior separately from the author's stated rationale and your inference. Check strong alternatives and counterevidence before committing. For tools/models/dependencies, verify current maintenance, version, license (including weights when relevant), data destinations, benchmark authorship, and fit to this workload. Repository tool lists are candidate inventories, not adoption decisions.

Carry a concrete transfer through the result:

> Student problem → inspected mechanism and evidence → conditions/tradeoffs → chosen change → observable check → failure/reversal condition.

Adapt the smallest mechanism that serves the journey. For example, views can share existing source identity without importing a second database product; a workbench can isolate slow workers without acquiring a plugin platform. Conditional long-term scenarios can stress boundaries without becoming near-term scope. Preserve licenses and attribution; honor clean-room separation when requested.

For demos, distinguish demonstrated interaction from editing, hidden setup, fixtures, unavailable backend, and your reconstruction. Inspect actual media before claiming it was watched or reproduced. Follow `docs/reference-driven-design.md` for concept-image and demo methods. Do not use citations or screenshots as substitutes for implementing and checking the transferred behavior.

## Discover what our data enables

Inspect the real producing path: connector capture → normalization/claims → persisted records → derived state → retrieval/consumer. Use schemas, writer/read paths, tests, and authorized representative samples. A schema field is not evidence that it is populated; one student's successful capture does not establish coverage for all courses. Keep private samples out of committed briefs. State when live evidence is unavailable.

For the few inputs that determine this feature, record **available evidence → meaning and limits → permitted use → behavior it changes → fallback**. Check source authority, identity joins, time/version, missing versus empty, granularity, reliability, and correction history. Inspect useful overlooked inputs before proposing new collection: instructions, rubrics, linked materials, announcements, feedback, submission state, and observed learner interactions may contribute differently. Do not collect or send more data merely because it exists.

Keep source facts distinct from derivations and hypotheses. Canvas gradebook results, transcript outcomes, and DARS applied credits have different semantics; agreement does not prove mastery, and planning data is not automatically permitted tutoring context. A due date supports timing, a rubric supports assessment criteria, and a new unassisted attempt supports a limited learning inference. Show the chain that justifies the inference, including counterevidence.

Compare the benefit of richer evidence with refresh delay, coverage gaps, noisy joins, context budget, computation cost, and disclosure. Prefer a useful experience from existing permitted evidence over another setup step, while declining unsupported claims. Verify a counterfactual: change or remove the decisive evidence and check that the selected activity, explanation, timing, uncertainty, or fallback changes appropriately. Define what happens for a course with sparse data and a non-CS course before claiming general tailoring.

## Assign computation deliberately

Choose the least complicated mechanism that meets the task, not a mandatory AI pipeline:

| Responsibility | Appropriate mechanism |
| --- | --- |
| IDs, dates, counts, budgets, permissions, scheduling, exact checks | Deterministic code |
| Source lookup, course evidence, versioned context, citations | Existing storage and retrieval |
| A bounded semantic decision with a concrete consumer | Optional targeted Jev judgment, only if permitted and justified |
| Explanation, synthesis, teaching, complex reasoning | A supported reasoning model with selected evidence and validation |
| A specific external operation | A bounded tool/adapter with explicit authority and result checks |
| Multi-step work with uncertain intermediate choices | A bounded agent when orchestration earns its cost |

For each proposed inference, state exact input, output/schema, downstream consumer, evidence required, validation, abstention/fallback, cache key and invalidation, latency/cost budget, and privacy/data destination. If no consumer or discriminating check exists, the inference is probably premature. Jev judgments cannot establish authorization, truth, or calibrated confidence by themselves. A fully local mode excludes hosted Jev as well as hosted language models.

If Jev earns a targeted role, code must supply grounded candidates and allow abstention; check candidate validity separately when a forced winner would be unsafe. Use independent yes/no judgments when several choices may apply. Tune task-specific thresholds on relevant labeled cases rather than treating concentration as correctness; do not multiply correlated judgments. Compare against a deterministic or retrieval baseline before accepting extra inference.

Research unfamiliar APIs, models, or libraries through current primary sources and a bounded experiment. Do not ask Ben to choose technical details that professional investigation can resolve. Ask only when the resulting tradeoff changes intended scope or a consequential user preference.

## Fit the existing runtime

Inspect relevant branch implementations before adding another agent runtime, course database, retrieval stack, or NotebookLM-like subsystem. Check ownership and integration rather than inferring adoption from research notes. Prefer existing authoritative records, IDs, evidence links, shared session state, and bounded adapters. New views should not create divergent copies of the same coursework.

Keep session/task state explicit across UI and workers. Budget context, concurrency, retries, and model/tool spending. Preserve provenance in compact retrieval instead of reloading whole courses or transcripts. Cache work against the source, task, policy, consent, and model versions that can invalidate it. Cancel obsolete work and reject late results after edits, deletion, account changes, revocation, or replacement requests.

Background preparation must have a likely user benefit, a bounded trigger/budget, an owner, and cancellation/invalidation. Do not precompute every possible tool or learning format speculatively. Render cached facts immediately and retain useful evidence when inference fails.

For suggestions, name the trigger, why now, and stopping condition. Submission should stop obsolete start/submit nudges for that work; new feedback, a revision request, or student-invoked review can justify a different action. Dismissal should suppress repetition until meaningful new evidence or an explicit user request. Preserve handled/dismissed state across refresh and return. Keep student-requested help, quiet contextual suggestions, and interrupting notifications distinct. Do not infer preferences solely from model guesses.

## Enforce trust in the operation

Read relevant current sections of `docs/ai-and-privacy.md`, `docs/pipeline-details.md`, `docs/course-intelligence.md`, and `docs/decisions.md` when their boundaries apply. They are authoritative over a stale feature proposal.

- Course policy, account/course/category grants, recipient consent, preview requirements, and revocation must affect the actual request path. Model recommendations and retrieved instructions cannot grant permissions.
- Preserve source identity, scope, freshness, contradictions, uncertainty, and reversible links. Exact citation validation is a check to implement or verify, not a claim implied by displaying a source badge. Failed/partial capture cannot erase earlier evidence or establish an all-clear state.
- Keep private coursework, credentials, sessions, and unredacted captures out of Git and logs. A field allowlist does not scrub identifiers inside free text. Do not quietly widen data sharing or add a hosted service.
- Current academic planning records remain outside AI/Jev/MCP context unless an explicit later decision changes that boundary. Do not treat all local records as usable personalization input.
- School systems expose no submit, enroll, post, or explicit completion actions. Reads may register views; preserve the accepted disclosure. Never automate Duo or bypass expiry. Agent verification on Ben's computer and Canvas stays headless with authorized sessions.

## Acceptance follows the causal path

Choose a representative complete journey early. It is a probe of the approach, not a substitute for the full authorized scope. Trace evidence selection → policy/consent → computation/tool → persisted result → visible action → correction/resume. Check whether actual selected evidence changes the result as intended and whether missing/conflicting evidence degrades honestly.

Use checks proportionate to the changed artifact and unresolved risk. For product changes, inspect normal entry/default and rendered behavior, including consequential recovery and accessibility. Use controlled fixtures when useful, label them, and distinguish them from live compatibility or learning-quality evidence. Do not replace a failed live path with unlabeled fixtures. If feedback contradicts passing checks, revisit the framing and evaluator before repeating the patch.
