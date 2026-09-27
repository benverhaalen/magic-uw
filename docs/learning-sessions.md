# Course-aware learning sessions

Status: canonical N24/N25 integration built in the September 26 learning-session branch. Nathaniel’s course backend, reconciled with main at `780aaed`, supplied the learning engines and shared v6/v7 schema; this integration adds the SQL adapter, prepared-practice router and contextual desktop binding. The combined branch passes 637 tests, TypeScript, the build and the hidden Electron bridge check. No live coursework tutoring quality has been demonstrated.

## Student outcome and current journey

From an assignment, choose prepared practice without uploading the course again. The assignment anchors the course and navigation; its open graded text does **not** become study input. Eligible supporting materials supply source evidence. A checked pool must already exist: an empty pool produces an honest unavailable message, never generated or unlabeled sample questions.

The student can answer choice, numeric and typed questions, open a saved explanation, skip, save a response and return. Source versions and actual check outcomes are visible. An explanation is recorded as assistance; there is no separately generated smaller hint. Code grades against the stored answer/key ideas. An undecided typed answer stays in session history with a null score and creates no scored attempt. Repeated questions are legitimate parts of Nate’s progression, not duplicate-output failures.

This delivers prepared practice, not the whole learning roadmap. Explanations generated on request, worked examples, adaptive artifacts, new item generation and T42 integration remain unavailable. The renderer’s explicit explanation request receives `not_built`. Exam, card-review, assessment-filtered and other unconnected learning operations also remain `not_built`. There are no readiness percentages or claims of measured mastery from this feature.

## Canonical integration

The [course-backend spec](plans/2026-09-26-course-backend/spec.md), [tasks §L](plans/2026-09-26-course-backend/tasks.md#l-the-learning-tasks-status-rewritten-dependencies-amendments-these-win-over-the-learning-tasks-own-lines), and learning spec [integrity rules](plans/2026-09-26-notebook-and-study-tracking/spec.md#10-integrity-and-privacy-rules) govern this binding.

```text
Assignment LearningPanel
  → existing execute({ type: "learning", request }) bridge
  → core learning channel → N25 createLearningRouter
  → N08 grading / N09 Learn progression / N10 session planning
  → N24 LearningStore on the existing workspace SQLite connection
```

The earlier parallel `learning*` IPC methods, session service, independent session contracts and direct Ollama activity pack have been retired. Practice has no provider/model dependency. Future generation belongs to the shared pack runner and its consent, receipts, budget and evidence checks; this integration does not bypass or claim that path.

### Persistence and operations

`study.plan` starts a contextual round from the newest eligible, active, checked item versions. `study.sessions`, `study.session` and `study.resume` read saved rounds. `study.draft`, `study.answer`, `study.hint` and `study.advance` mutate them. The renderer receives `StudySessionView`; answer keys and internal knowledge-model parameters are not exposed.

Session state, drafts, history, source disclosures and operation fingerprints live in the canonical `learning_sessions.plan_json`, not another table family. Each mutation supplies a revision and operation ID. `commitSession` atomically compares the revision and writes the session with any scored attempt. Retries do not duplicate attempts; a reused operation ID with a different request or a stale revision cannot overwrite work. Undecided answers are saved only as session events.

The N24 SQL adapter uses the workspace store’s existing connection and transaction wrapper. Storage-owned **v8** preserves v6/v7 and fills concrete engine/schema gaps: numeric item units, chosen option IDs, coverage decision authorship, and cards with explicit course/concept scope and pinned item versions. Concept tracks no longer require an invented learning item. The migration conservatively preserves existing non-proposed coverage decisions. This is schema alignment for Nate’s records, not a second course database.

### Evidence, policy and recovery

The worker constructs trusted account/course context. Renderer-supplied IDs do not authorize another account’s history. Excluded, missing or foreign-course context is unavailable. Policy restriction blocks practice; silent policy is not a verified permission statement. Source health and a context hash track source, policy and privacy changes separately from the assignment content hash.

IP-2 eligibility is checked again at use time: an assignment closes at a confirmed lock time, otherwise its conflict-free resolved due time; no date or an invalid date remains open. Submission does not close it. Ordinary supporting materials can be eligible. Planning, transcript/DARS and historical grades are not inputs to this feature.

Every item source must match the current eligible resource’s content hash and exact quoted span. A newer quarantined item cannot cause fallback to an older active version. Required passed checks include policy, schema, quote, flaws, near-duplicate and tags; any failed check excludes the item. Optional model support checks may be `not_run` and are disclosed accordingly. Passing source and format checks does not prove the answer is independently verified or pedagogically good.

Saved explanations require their own passed citation check and use the same current source gate. No live model is called for answer, explanation exposure, skip or advance. Source changes make the round stale and suppress its current question; original source-version disclosures and saved responses remain available within authorized scope. Draft recovery can continue while freshness or policy blocks practice. A new round uses current evidence. Cancellation is checked before mutation, and purge removes canonical learning records through the workspace store.

## Reference-driven transfer

| Inspected reference and job | Mechanism transferred | Failure check |
| --- | --- | --- |
| Nate N08 `grade.ts`; deterministic grading | Reuse exact/numeric/key-idea grading; undecided stays null rather than becoming an incorrect answer | Ambiguous typed response persists with no scored attempt |
| Nate N09 `learn.ts`; progression | Persist its pure state transitions, including recognition/recall and deliberate repeats | Wrong/undecided answers can return; no blanket repeated-item ban |
| Nate N10 `session.ts`; planning | Feed real course concepts, checked pool and evidence into the existing planner | Empty/ineligible pool cannot start a fabricated session |
| Shared LearningStore and SQLite transaction boundary; persistence | Atomic revision comparison plus session/attempt write, on one connection | Retry produces one attempt; failed comparison preserves prior revision |
| Learning spec IP-2 and existing source-version evidence; integrity | Assignment remains a navigation anchor while open graded text is excluded; exact source spans revalidated | Missing/invalid closing dates, changed quotes/hashes and cross-account context block use |
| Existing assignment design and execute bridge; interaction | Contextual learning surface, source disclosure and recoverable drafts without another navigation/runtime system | Actual assignment entry, return and recovery require rendered inspection |

These are inspected code/spec mechanisms and their local tests, not evidence of learning outcomes. Broader references such as the [IES practice guide](https://ies.ed.gov/ncee/wwc/PracticeGuide/1) still inform the future worked-example/practice roadmap; they do not validate the current product.

## Verification and remaining checks

Ten focused router tests pass using synthetic course material run through the actual item-check pipeline and canonical memory store. They cover the normal saved-round journey, idempotency/revision conflicts, unscored uncertainty, deliberate repeats, assistance, exact evidence and account/policy/cancellation gates, newest-version invalidation, original source disclosure and failed-CAS recovery. They make no provider calls. Earlier standalone-service tests are retired and are not evidence for this architecture.

SQL tests cover reopen, v7 migration, account isolation, atomic revision writes and rollback. Five production-context tests cover source eligibility, policy, freshness, course exclusion and context invalidation. The combined 637-test suite passes; the hidden Electron check exercises the canonical study channel and honest empty-pool response, plus workspace import/export/purge. Passing isolated tests does not establish app integration or live course quality. Production preparation of a checked question pool, explicit explanation generation, broad course coverage, and student learning evaluation remain separate work.

## Concurrent integration decisions

Substantial conflicts are evaluated through `magic-feature-planning`: compare the actual student journey, available evidence, accepted constraints and remaining gaps before choosing. Mechanical conflicts need only preserve both valid changes. The September 26 reconciliation found Nate's learning engines unchanged from the earlier integration; retained the new main calendar/Outlook and storage-clock behavior, and added N24/N25 rather than replacing his engine. No new AI/runtime or mastery policy was chosen by resolving Git markers.

### Observed desktop journey

Headless synthetic preview after the main merge: sample onboarding → workspace → assignment → prepared practice → saved explanation → typed answer/feedback → next/end; source disclosure and skip/end also passed. Explicit Explain reports unavailable without erasing saved work; coursework stays unchecked. Draft navigation/reload recovery passed before the merge on the same canonical path. No browser console errors were observed. Numeric/choice controls were not exercised in this browser pass; native app restart and real-course teaching remain unverified. The synthetic preview runs the actual item-check pipeline, router and SQL store; it does not prove production question preparation exists.

Team integration: implementation is on `feat/course-learning-sessions`, with canonical integration at `73bce37` and main reconciliation at `ba24140`. This document may land on main before the implementation. Avoid duplicating N24 or this bounded N25 path; the remaining preparation/T42 work should connect through Nate's existing contracts.
