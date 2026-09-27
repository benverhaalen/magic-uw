# Frontend data bugs for backend follow-up

The active desktop work prioritizes the frontend. Backend data defects found while building it are recorded here for Nate/Nathaniel to assess; proposed ownership is not an accepted assignment. This page records observed behavior separately from suspected causes. It does not authorize backend implementation.

Ben, recorded September 27, 2026 (original message timestamp unavailable):

> keep your work on the frontend primarily and with backend bugs you notice that mess with things with data add them to docs for probably nates agent to pick up

Follow-up:

> maybe make a new doc just for these bugs

## Current findings

| ID | Finding | Status |
| --- | --- | --- |
| [FDB-001](#fdb-001-assignment-grade-share-lacks-account-and-capture-coverage-boundaries) | Assignment grade share lacks account and capture-coverage boundaries | Reproduced with synthetic inputs |
| [FDB-002](#fdb-002-sign-in-bridge-discards-the-cancelled-outcome) | Sign-in bridge discards the cancelled outcome | Typed backend outcome and App consumer integrated; live authentication remains separately verified |
| [FDB-003](#fdb-003-generation-pack-scope-cannot-select-the-requesting-account) | Generation pack scope cannot select the requesting account | Code-inspected; generation not run |
| [FDB-004](#fdb-004-student-record-freshness-uses-a-term-length-horizon) | Student-record freshness uses a term-length horizon | Code-inspected; live hold changes not reproduced |

Existing syllabus discovery, extraction, and capture gaps remain in [backend packet 12](../.agents/team/packets/backend/12-syllabus-discovery.md); that investigation belongs to Nathaniel and is not duplicated here.

## Entry format

Each finding receives a stable `FDB-###` identifier and a short title. Record:

- Status: observed behavior, suspected cause, or resolved with evidence.
- Student impact and a sanitized reproduction.
- Code path and inspected revision; expected and actual result.
- Current frontend handling and its limitation.
- Proposed backend owner: Nate/Nathaniel, pending acceptance.
- Next useful action and the proof needed to resolve the issue.

Private coursework, account identifiers, captures, logs, credentials, and sessions stay outside the repository. Link public code or synthetic reproduction evidence; summarize private observations without exporting their contents.

## FDB-001: Assignment grade share lacks account and capture-coverage boundaries

**Status:** observed with synthetic inputs through the exported `gradeShare` function; current implementation inspected at main `8dc51b1`. This is not a claim about any student's actual grades.

**Student impact:** a precise-looking assignment percentage can change solely because more assignments were captured. Identical course IDs from different accounts can affect the same calculation. That output cannot support personal grade-impact ranking without additional evidence.

**Code:** `packages/domain/src/today-rail.ts`, `RailResource` and `gradeShare` (function begins around line 222 at the inspected revision). The input has no account/source boundary or capture-completeness field. Group totals, group lookup, and assignment siblings use `courseId`; the denominator sums only supplied assignment points.

**Synthetic reproduction:** provide one course group with weight 100 and assignment A with 10 points. `gradeShare([group, A])(A)` reports about 100%. Add assignment B in the same group with 90 points: A becomes about 10%. Add another account's group with the same course ID and weight 100: the course total becomes 200 and the result is null. The first change demonstrates sensitivity to missing captured siblings; the second demonstrates the missing account boundary. Neither case requires private coursework.

**Expected / actual:** expected either a supported account-scoped estimate with known coverage and grading rules, or wording limited to the observed Canvas group weight. Actual computation derives assignment share from the available rows without knowing whether they cover the group, and has no way to distinguish accounts. Dropped-score wording does not establish complete coverage.

**Frontend handling:** do not use the estimate to rank personal impact or display it as a known share. Prefer source-grounded due dates, points, and the group weight explicitly labeled as listed in Canvas. This avoids an unsupported claim but does not repair the backend calculation. Adoption in each consumer still needs verification.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. **Next action:** determine the required account/source and completeness contract, plus behavior for partial, duplicate, dropped-score, and unweighted cases. See existing [syllabus investigation](../.agents/team/packets/backend/12-syllabus-discovery.md) for separately owned course-evidence gaps.

**Resolution proof:** tests must demonstrate account isolation and conservative partial-capture behavior, followed by a frontend check showing the resulting evidence-qualified wording. No fix is claimed here.

## FDB-002: Sign-in bridge discards the cancelled outcome

**Status:** observed contract mismatch by code inspection at desktop integration `0eebf9e` (also reported at `d86a90e`). No live authentication or student session was used to reproduce this.

**Student impact:** closing the sign-in window is indistinguishable from confirmed sign-in to the renderer. A consumer can attempt a sync after cancellation and cannot accurately explain what happened from the bridge result alone.

**Code and reproduction:** in `apps/desktop/src/main.ts`, `signInWindow(): Promise<boolean>` waits for the window to close and returns `confirmed`; `openSignIn` preserves that boolean. The `magic:signin` handler awaits `openSignIn(requestedService)` without returning its outcome. `AppBridge.signInUW` in `packages/contracts/src/index.ts` is typed `Promise<void>`. Follow these code paths without opening a sign-in window: either boolean outcome becomes the same void IPC result. In the inspected `apps/desktop/src/renderer/App.tsx`, `startSignIn` awaits that void call and then calls `syncCanvas` when available.

**Expected / actual:** expected a typed confirmed/cancelled result so the frontend can keep cancellation quiet and only take actions supported by the outcome. Actual IPC erases the existing distinction. A resolved promise alone is not evidence that authentication succeeded.

**Frontend handling:** keep the unresolved sign-in affordance until fresh source evidence confirms access; do not announce successful connection merely because the window closed. The renderer can inspect subsequent source health, but cannot identify cancellation or suppress a follow-up sync based on this return value alone. No backend fix is included in the frontend work.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. **Next action:** agree an additive typed sign-in outcome and update its IPC/bridge contract; preserve consent and existing sign-in gating.

**Resolution proof:** cover confirmed, cancelled, and failed outcomes through the IPC contract and frontend consumer, including a cancellation that triggers no success claim or automatic follow-up sync. Verify the shell still offers recovery when access remains unresolved.

**Resolution (backend integrated through main `4cadd8d`; App consumer corrected in the combined frontend checkpoint):** commit `68624af` on `feat/client-health`. `magic:signin` now resolves with `SignInOutcome` (`packages/contracts/src/sign-in.ts`): `{ status: "confirmed" | "cancelled" | "failed", service, reason? }`, and `AppBridge.signInUW` returns `Promise<SignInOutcome>`. The call shape is unchanged, and an unknown service or a refused consent still rejects as before. Only `confirmed` means the service answered with the student's profile; `failed` carries a plain reason (the headless message, or a generic one; other error text never crosses). For consumers, `signInAndSync` in `apps/desktop/src/renderer/sign-in.ts` reads Canvas only after `confirmed` and returns `{ outcome, synced }`. `signInMessage` gives the words for each outcome. Tests: `tests/sign-in-outcome.test.ts` (confirmed, cancelled and failed through `handleSignInRequest`, the function `magic:signin` calls; a cancellation claims no success and starts no sync). The onboarding's UW step uses it. The App consumer now syncs only when the typed outcome is `confirmed`. Native external authentication remains separately verified; the contract tests do not establish a live successful sign-in.

## FDB-003: Generation pack scope cannot select the requesting account

**Status:** code-inspected at main `ae66b91`; no model, generation, or real account data used. The Study frontend exposed this contract limitation during integration review.

**Student impact:** when two included accounts have the same provider course ID, a generation request cannot identify which account's course the student opened. Resource-specific requests can return no material despite that account having the requested source; a course-wide request can choose the other account's course.

**Code and sanitized trace:** `packages/contracts/src/index.ts` defines `packScopeSchema` with `courseId` and optional resource/module/assessment/topic IDs, but no account field. In `packages/core/src/pack-handler.ts`, `resolveScope` gathers every matching course ID, sorts their source account scopes, and chooses the first account before filtering `scope.resourceIds`. Trace two synthetic sources with account scopes `account-a` and `account-b`, both course `course-1`: a request from B with only `courseId` selects A; adding B's resource ID still selects A first and then removes A's resources. This is a code-path reproduction, not an executed generation test. Other guide/intent adapters require separate inspection; this finding does not claim every generation path has the same behavior.

**Expected / actual:** the requested account should be explicit or unambiguously derived from a verified resource before selecting course context, with ambiguity rejected. Actual pack selection is determined by sorted account scope rather than the requesting page or selected resource.

**Frontend handling:** maintain account-scoped resource selection and filter returned study artifacts by their actual course reference. Do not treat that output filtering as enforcing the account used for generation. When the target account cannot be established through the existing backend contract, keep generation unavailable rather than claim a correctly scoped run.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. **Next action:** establish an account-scoped pack contract or verified-resource resolution, including guide and command-router adapters that call it. **Resolution proof:** two-account synthetic tests must select the requested account, preserve policy and consent checks, reject ambiguity, and verify the frontend's requested/returned course references agree.

## FDB-004: Student-record freshness uses a term-length horizon

**Status:** code-inspected at main `ae66b91`; no live hold, enrollment appointment, or student-account change was reproduced. This records a freshness-policy gap for backend review rather than claiming a specific student's saved hold is wrong.

**Student impact:** a changed enrollment hold or appointment can remain presented as current by a consumer relying on the planning freshness classification for much of a term.

**Code and sanitized trace:** `packages/core/src/planning.ts`, `planningEvidenceKind`, maps `student_record` to `public`; `planningHorizon` gives every kind except enrollment during add/drop a 120-day horizon. A successful `student_record` capture observed ten days ago is therefore still within that horizon. `planningRefreshDue` also uses a term cadence outside a known add/drop window; an unknown window currently takes the conservative seven-day branch. No evidence here establishes how often a particular live account actually refreshes.

**Expected / actual:** decision-sensitive holds and enrollment appointments need an explicitly justified freshness policy that can differ from public catalog data. Actual classification shares the 120-day policy. A shorter exact interval is a product/backend decision, not established by this observation.

**Frontend handling:** My UW uses a conservative seven-day confirmation cue for saved holds/windows and retains a refresh action. This is a temporary renderer policy, not evidence that the source changed. Mirrored horizons can drift when the backend policy changes.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. **Next action:** distinguish student-record freshness where needed and expose a renderer-safe freshness result or shared policy. **Resolution proof:** synthetic boundary tests for holds/appointments versus public catalog data, cadence before a known enrollment window, and a UI check that stale saved facts remain visible with a clear confirmation action.


## FDB-005: Work preparation repeats expensive full snapshots on the worker queue

**Status:** observed through the real desktop entry point and IPC in a hidden copied-workspace run at the September 27 combined frontend checkpoint. Private instrumentation measured command receipt, snapshot creation and work-set construction. No source records or identifiers are included here.

**Student impact:** eager previews on Home and remounts can delay a detail's prepared actions or unrelated snapshot reads beyond the existing 30-second request limit. A timeout does not mean the queued computation was cancelled.

**Code and observed mechanism:** `packages/core/src/commands.ts` handles `work-set` by creating a complete snapshot and then building its set. The desktop worker serializes synchronous work. One measured navigation sequence queued eleven work-set requests and three snapshots; individual work-set snapshot phases took roughly 1.5–2.9 seconds and total preparation roughly 2.2–4.3 seconds. The protected original runtime also had a busy worker, so these numbers do not establish unloaded performance or explain the user's earlier uncaptured JavaScript error.

**Frontend handling:** `prepared-work/prepare-cache.ts` coalesces identical previews, serializes distinct bridge requests, evicts rejected promises and supports explicit retry. Keys include the assignment plus source/account, resource version, links, consent and configuration evidence. Background check timestamps alone no longer invalidate all previews. Launch still rebuilds and authorizes its reviewed preview in main. The same real navigation after this repair completed a snapshot in 12.0 seconds and the directly requested six-destination work set in 16.7 seconds without a renderer exception; this is improved completion, not acceptable backend latency proven in every state.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. Consider a lean preparation response or reusable evidence revision, preserving account/policy/preview-hash checks, and cancellation/priority semantics for obsolete reads. Do not increase the timeout to hide the queue. Resolution needs bounded cold/warm startup and navigation measurements under realistic workspace size, plus invalidation and rejection tests.

## FDB-006: Notes fill lacks the generation pipeline's outgoing-data and late-consent protections

**Status:** independently reproduced with synthetic identity/email, the real Notes service/store/model runner and a fake backend; no network or student content used. `packages/notes/src/fill.ts` passes raw selected content to the backend and can persist suggestions after consent is revoked during the call.

**Frontend boundary:** the pending Study output candidate keeps Notes generation unavailable. Display filtering or a disabled control does not repair the backend service. Existing LearningPanel generation also needs the requesting-account preflight described in FDB-003.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. Reuse the canonical outgoing-content scrubber, before-call authorization and post-call validation against current consent/account/policy state. Acceptance must show synthetic identity handling, revocation during an in-flight call, no stale persistence and accurate receipts before enabling Notes generation.

### FDB-005 follow-up: original-profile persistence and background read pressure

The controlled September 27 promotion of published `df0ab25` to the original workspace preserved its database and state and captured no renderer exception. It still recorded two 30-second `magic:execute` timeouts; Chat reached its conversation but remained Starting. A later private page check restored exact material focus and scroll, which does not resolve the original-profile latency. Do not describe the earlier unknown JavaScript error as diagnosed or fixed.

A separate renderer cause of sustained read pressure was identified: the two-second interval queued a follow-up while a slow snapshot was running, then drained that follow-up immediately at completion. The frontend now waits two seconds **after** a background read finishes, pauses hidden windows, and skips busy polls without queuing another read. Explicit refreshes and snapshot-less mutation refreshes retain their coalescing behavior. Focused scheduler/gate tests and typecheck pass; current original-profile performance after this change remains unverified. Full snapshot construction and queued command cancellation/priority remain backend work.

## FDB-007: A prerequisite reference is promoted to the current assignment's due claim

**Status:** reproduced through current domain extraction and core evidence resolution, using a synthetic equivalent and a private captured-target control. No backend fix or source mutation was performed.

**Cause and impact:** the due-word matcher accepts “submitted/submission”; core `proseDeadlines` confirms a single own-description due mention without establishing which obligation it describes. A sentence saying that an earlier design submission must already be complete, with a date pointer to that earlier assignment, becomes a confirmed due date for the current assignment. This creates a false conflict and advances the conservative planning date. A control containing a genuine current-project due sentence remains conflicting.

**Qualified captured evidence:** the target's structured due and day-precision title agree. Its separately captured availability-close date is a lock claim and is excluded from the due resolver. Removing only the suspect prerequisite sentence span from a private diagnostic rerun eliminates this target's fresh core conflict while preserving structured due, lock and title. This does not establish that all conflicting assignments are false, that previously saved projections were refreshed, or that every related copy has identical evidence.

**Requested producer repair:** retain prerequisite/reference dates as inspectable evidence without confirming them as the current obligation. Test prerequisite pointers, genuine disagreements, current obligations in the same paragraph, multiple steps and explicit announced changes; preserve the exact raw span and account/course boundary. Regenerate evidence versions when eligible claims change so stale personal choices reopen. Do not hardcode dates or suppress description conflicts in the frontend.

**Related persistence boundary:** canonical renderer families may include a trusted UID-only calendar contributor absent from backend option fingerprints. Keep personal choice saving unavailable when contributor coverage differs until backend and renderer use the same scoped, current relation evidence. Proposed backend owner: Nate/Nathaniel, pending acceptance.
