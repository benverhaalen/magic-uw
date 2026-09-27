# Frontend data bugs for backend follow-up

The active desktop work prioritizes the frontend. Backend data defects found while building it are recorded here for Nate/Nathaniel to assess; proposed ownership is not an accepted assignment. This page records observed behavior separately from suspected causes. It does not authorize backend implementation.

Ben, recorded September 27, 2026 (original message timestamp unavailable):

> keep your work on the frontend primarily and with backend bugs you notice that mess with things with data add them to docs for probably nates agent to pick up

Follow-up:

> maybe make a new doc just for these bugs

## Current findings

| ID | Finding | Status |
| --- | --- | --- |
| [FDB-001](#fdb-001-assignment-grade-share-lacks-account-and-capture-coverage-boundaries) | Assignment grade share lacks account and capture-coverage boundaries | Backend fix `0f7ac36`, tested in isolation; frontend adoption pending |
| [FDB-002](#fdb-002-sign-in-bridge-discards-the-cancelled-outcome) | Sign-in bridge discards the cancelled outcome | Backend outcome built and tested in isolation (`feat/client-health`); App.tsx consumer open |
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

**Resolution (backend, `0f7ac36` on `feat/critical-agenda`, not yet on `main`):** tested in isolation by `tests/grade-share.test.ts` (account isolation, partial capture, dropped scores, excused work, unweighted, mis-totalled, duplicate and missing groups). The frontend check is still open.

- `gradeShareDetail(resources, options?)` returns `{ basis, percent, groupWeight, groupTitle, accountScope, reason, text }`:
  - `basis: "listed"`: `percent` is the Canvas group weight as listed (the group's share, not the assignment's). `reason` says why no assignment share was computed: `partial_capture`, `drop_rules`, `excused` or `no_points`.
  - `basis: "computed"`: this assignment's share, only when `options.complete(accountScope, courseId)` confirms every assignment of that account's course was captured, the group has no drop rules and nothing in it is excused. Siblings count once per Canvas ID.
  - `basis: "unknown"`: `percent: null` with `reason` `no_group`, `group_not_captured`, `unweighted`, `weights_do_not_total_100`, `duplicate_group` or `zero_weight_group`.
- Groups, totals and siblings are keyed by `accountScope` plus course ID. `RailResource` and the new `GradeShareResource` gain an optional `accountScope`; rows without one count as a single account, as before.
- `gradeShare` keeps its call shape for the Today rail and adds `basis` and `reason` to the returned object; it returns null for `unknown`. Without `options.complete`, which the rail doesn't pass yet, it never computes: the rail now shows the listed group weight ("Counts in Homework, 40% of the … grade (the group's weight as listed in Canvas)") where it used to show a computed "About N%".
- The critical-action agenda (D49) ranks only on `listed` or `computed` and falls back to points for `unknown`.
- **Frontend next step:** pass `accountScope` on rail resources and label the figure by its `basis`.

## FDB-002: Sign-in bridge discards the cancelled outcome

**Status:** observed contract mismatch by code inspection at desktop integration `0eebf9e` (also reported at `d86a90e`). No live authentication or student session was used to reproduce this.

**Student impact:** closing the sign-in window is indistinguishable from confirmed sign-in to the renderer. A consumer can attempt a sync after cancellation and cannot accurately explain what happened from the bridge result alone.

**Code and reproduction:** in `apps/desktop/src/main.ts`, `signInWindow(): Promise<boolean>` waits for the window to close and returns `confirmed`; `openSignIn` preserves that boolean. The `magic:signin` handler awaits `openSignIn(requestedService)` without returning its outcome. `AppBridge.signInUW` in `packages/contracts/src/index.ts` is typed `Promise<void>`. Follow these code paths without opening a sign-in window: either boolean outcome becomes the same void IPC result. In the inspected `apps/desktop/src/renderer/App.tsx`, `startSignIn` awaits that void call and then calls `syncCanvas` when available.

**Expected / actual:** expected a typed confirmed/cancelled result so the frontend can keep cancellation quiet and only take actions supported by the outcome. Actual IPC erases the existing distinction. A resolved promise alone is not evidence that authentication succeeded.

**Frontend handling:** keep the unresolved sign-in affordance until fresh source evidence confirms access; do not announce successful connection merely because the window closed. The renderer can inspect subsequent source health, but cannot identify cancellation or suppress a follow-up sync based on this return value alone. No backend fix is included in the frontend work.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. **Next action:** agree an additive typed sign-in outcome and update its IPC/bridge contract; preserve consent and existing sign-in gating.

**Resolution proof:** cover confirmed, cancelled, and failed outcomes through the IPC contract and frontend consumer, including a cancellation that triggers no success claim or automatic follow-up sync. Verify the shell still offers recovery when access remains unresolved.

**Resolution (backend, built and tested in isolation; not merged):** commit `68624af` on `feat/client-health`. `magic:signin` now resolves with `SignInOutcome` (`packages/contracts/src/sign-in.ts`): `{ status: "confirmed" | "cancelled" | "failed", service, reason? }`, and `AppBridge.signInUW` returns `Promise<SignInOutcome>`. The call shape is unchanged, and an unknown service or a refused consent still rejects as before. Only `confirmed` means the service answered with the student's profile; `failed` carries a plain reason (the headless message, or a generic one; other error text never crosses). For consumers, `signInAndSync` in `apps/desktop/src/renderer/sign-in.ts` reads Canvas only after `confirmed` and returns `{ outcome, synced }`. `signInMessage` gives the words for each outcome. Tests: `tests/sign-in-outcome.test.ts` (confirmed, cancelled and failed through `handleSignInRequest`, the function `magic:signin` calls; a cancellation claims no success and starts no sync). The onboarding's UW step uses it. **Still open for the frontend owner:** `startSignIn` in `apps/desktop/src/renderer/App.tsx` still syncs unconditionally; switching it to `signInAndSync` closes the consumer side.

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
