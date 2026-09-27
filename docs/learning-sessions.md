# Course-aware learning sessions

Status: being adapted to Nathaniel’s authoritative course-backend architecture, September 26, 2026. The session surface and orchestration are a feature-branch integration candidate. Nathaniel’s concrete runner, repository and learning-engine bindings are not present in this checkout; this is not a functioning production tutor yet.

## Student outcome and scope

From an assignment, start a useful learning activity without uploading its context again. The activity uses the assignment's available instructions, accepted supporting materials and course policy. Answer, ask for a hint, skip or pause; return to the saved activity and draft. Feedback identifies what the response supports, one gap and one next step. Unknown performance remains unknown.

The initial module catalog is explanation, worked example and practice. These are reusable forms, not course-specific pipelines. The model can choose a form from these bounded options using the request, course evidence and recent session evidence. The student can redirect through a short optional goal. No mandatory diagnostic, scheduling screen, readiness percentage, automatic notification or second course database is introduced. Media, simulations and hosted-provider adapters remain independent extensions, not implied capabilities.

## Alignment with the course backend

Ben directed this feature to use Nathaniel’s architecture as its foundation. The [course-backend spec and tasks](plans/2026-09-26-course-backend/spec.md) are authoritative; [the architecture summary](course-backend-architecture.md) explains their current implementation status. The docs at `8d91ceb` are the integration reference. This does not mean uninspected lane code has been demonstrated here.

| Earlier session implementation | Adaptation |
| --- | --- |
| Independent SQLite migration 6 and session tables | Remove them. Storage owns the shared v6 course core and v7 learning tables. Session DTOs are a UI projection, not a second schema. |
| Direct local Ollama activity/feedback calls | Remove the separate transport. Explicit explanations go through the shared pack runner, with its consent, receipts, budgets and checks. |
| Model call on answer, hint and next | Study uses prepared checked items, stored hints/explanations and the existing deterministic learning engine. No model calls on ordinary study actions. |
| Assignment text automatically supplies generation context | Preserve assignment entry as scope/navigation, but exclude open graded assignment content under IP-2. Use permitted supporting material; missing evidence remains missing. |
| A runnable alternative backend | A narrow binding to the shared repository, checked study pool and pack executor. If these are absent, report unavailable; do not silently use another provider or temporary persistence. |

Renderer → typed preload IPC → worker → learning-session orchestration → shared learning repository / checked-item engine / explicit explanation pack.

The injection boundary is this feature’s proposed adapter, not a claim that Nathaniel already exports identical TypeScript signatures. Bind it to his concrete APIs when available; do not recreate his runtime to satisfy the interface. Production readiness requires this final binding and a real app-path check.

The preserved journey includes source disclosure, draft recovery, skip, cancellation, return, and retry where appropriate. Code rechecks account/course membership, exclusions, policy and evidence changes. Excluding a course hides historical excerpts while retaining local work for a later permitted return. Purge must prevent late results from restoring deleted work.

Open explanations and studying are distinct operations. The explicit explanation pack may use a model; prepared practice must not. No readiness estimate or Boolean correctness is inferred from free-form model feedback. The shared checked-item engine owns supported grading; unsupported answers remain ungraded.

Jev is not a required extra call for this session orchestration. The shared generation/verification pipeline determines its targeted uses. No new hosted request bypasses that pipeline.

## Data opportunity and limits

| Available evidence | Behavior it changes | Limit and fallback |
| --- | --- | --- |
| Permitted source material linked to the assignment | Skill/topic, source passages, context and activity | An assignment can anchor navigation without allowing its open graded content into generation. Missing permitted support cannot justify invented course knowledge |
| Course policy/compiler claims | Allow or block help; coach conservatively when unclear | Source text is evidence, not authorization; stale or unknown policy cannot grant permission |
| Rubric/assessment expectations present in permitted source text | What the activity asks the student to explain or demonstrate | Structured rubric arrays are not yet projected into this feature’s source text. Do not claim the professor's exam pattern without examples; do not turn rubric language into a predicted grade |
| Saved session responses, hints and explanations | Continuation and scaffolding | No inference of learning style or mastery; initial feedback is formative model output |
| Source versions, capture times and health | Freshness, invalidation and evidence display | Saved/partial data is not proof of complete course coverage |

Planning, transcript/DARS records and historical grades are not learning evidence sent through this feature. No extra collection is required. Input selection must be bounded; source counterfactual tests must show that replacing/removing decisive evidence changes the actual model input or blocks unsupported activity.

## References and concrete transfer

- [IES practice guide: Organizing Instruction and Study to Improve Student Learning](https://ies.ed.gov/ncee/wwc/PracticeGuide/1), inspected September 26: a research synthesis published in 2007, including worked-example/problem alternation and explanatory questions. **Role:** learning mechanism. **Transfer:** multiple forms, small feedback and a next question, assistance recorded separately. Applicability depends on task and source quality; this is not an evaluation of Magic Canvas or a reason to force quizzes after every answer.
- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs), inspected September 26: JSON schema supplied through `format`, with separate Zod validation. **Role:** implementation mechanism. **Transfer:** bounded typed activity/feedback rather than parsing arbitrary chat prose. Valid JSON does not establish grounded or correct teaching; source-span and semantic limitations remain explicit.
- Existing `local-service.ts`, `local.ts`, core context and SQLite versioned capture paths, inspected at `2478ab1`. **Role:** architecture and safety reference. **Transfer:** worker isolation, fixed local recipient, reverified model identity, no arbitrary tools, cancellation and post-inference evidence checks. Extend this path instead of importing another agent runtime.
- Existing design component contracts. **Role:** interaction reference. **Transfer:** optional contextual action, compact evidence disclosure, recoverable failures and reliable return within assignment detail; preserve Home/navigation.

## Acceptance and audit

The earlier standalone implementation passed 30 focused tests and TypeScript checking. Those results do not verify the adapted architecture. Adapter tests must separately establish that ordinary study makes zero model calls, missing bindings are explicit, and open graded assignment content is excluded. Runtime-backed restart, receipts and provider checks remain integration requirements until the shared bindings land.

1. Normal assignment entry starts a context-grounded activity, accepts a response, gives formative feedback, and resumes with the same draft/history after storage reopen.
2. Quoted evidence must match the exact supplied source version. Foreign-course, invented and stale references are rejected.
3. A restricted policy makes no inference call. Unknown policy stays coaching. Source/policy/privacy changes, deletion and purge during inference reject late results.
4. Hint, explanation, skip and repeat exposure are recorded honestly; no generated assessment writes a fabricated Boolean correctness or readiness percentage.
5. Missing sources, unavailable runtime, invalid output and cancellation leave useful saved state and an actionable recovery path.
6. Synthetic STEM and humanities cases exercise different requests/evidence; remove decisive context and inspect the producing request/fallback. Fixture success does not establish live tutoring quality.
7. Actual renderer entry, keyboard controls, navigation/return and draft recovery are inspected headlessly. Build/tests alone do not establish the experience.

Independent architecture review was requested through the installed Jev harness before implementation. Its read-only report recommended explicit resumable session/item state, reuse of the verified local generation and policy-context boundaries, and tests for assistance, source drift, interruption and untrusted text. The driver accepted those mechanisms; its weak report-consistency check is not independent verification of software. Final code review and observed results are recorded below when available.
