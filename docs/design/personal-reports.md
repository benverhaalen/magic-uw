# Personal briefing reports

The student can report “I’ve handled this” for a specific reading review or deadline review and Undo it. This is the student's statement, not Canvas submission, verified reading completion, or learning evidence. The backend contract is implemented; desktop rendering and complete interaction verification belong to the Home integration.

## Identity and version

Use `personalReportIssue(purpose, resourceIds)` with `reading-review` or `deadline-review`. Include every resource that grounds this issue, such as both assignments involved in a deadline conflict. Identity is the semantic purpose and exact resource set, never generated wording. Different concerns requiring different reports need a new supported purpose rather than a fabricated resource ID.

Build evidence from actual current `Resource.id` and `Resource.contentHash`, then call `personalReportVersion(evidence)`. The store checks those hashes against current resources. Missing or unknown evidence cannot be acknowledged as a source-versioned report; show a recoverable explanation and allow source review. The hash covers captured resource content, not briefing copy. A changed hash makes the new version unchecked. This is intentionally conservative: even a source change that seems cosmetic requires review. The caller must include all underlying source resources; this API cannot infer an omitted dependency.

## Renderer integration

1. Derive `issueId`, `evidence`, and `sourceVersion` from the same current evidence.
2. Read `personalReportState(snapshot.personalReports, issueId, sourceVersion)` for `{ revision, record }`. Feed `record` to the shared Confirmation component. An old-version report yields no checked record but retains the revision needed for the next write.
3. On a new user intent, generate a fresh operation ID and send:

```ts
{
  type: "personal-report",
  value: { operationId, issueId, evidence, sourceVersion, handled, expectedRevision: revision }
}
```

4. While pending, keep the saved state visible and disable repeated changes for that issue. Retry an uncertain transport result with the **identical** request and operation ID. A changed intent or refreshed evidence gets a new operation ID.
5. Adopt the returned current snapshot. On a validation/stale-state error, refresh and display the recoverable reason; do not claim the action saved. Ignore responses from an obsolete view/evidence generation, and avoid replacing newer per-issue revisions with older ones. Undo uses the current version and revision with `handled: false` and a new operation ID.

The store returns an original operation receipt for exact duplicate replay, but the core command returns a newly computed snapshot. A delayed retry of “handled” therefore cannot reapply that choice after Undo. Undo appends another event and survives restart. It cannot undo an obsolete source version.

## Persistence and boundaries

The local SQLite preferences journal is written within `BEGIN IMMEDIATE`, using per-issue compare-and-swap revisions. It preserves operation IDs, exact evidence, server-assigned timestamps and account scope. Mutation validates current resource availability, course inclusion, term and account scope; one report cannot span accounts. Excluded or removed sources hide related report state. Existing cached evidence can remain usable during sign-in expiry; this report is never an external write.

The polling snapshot contains only the latest `{issueId, sourceVersion, handled, revision, reportedAt}` per accessible issue. History remains local, with bounded store retrieval (default 50, maximum 200). AI context and MCP exports do not include reports. Local-data purge clears the journal. No schema migration, school write, source-completion flag or project-work completion is involved. The journal refuses growth beyond 10,000 events or 1,000 issues rather than silently deleting provenance; this limit needs product handling if reached.

## Evidence and remaining integration

`tests/personal-reports.test.ts` exercises real file-backed SQLite close/reopen, Undo/history, second-connection stale revisions, duplicate retries after Undo, changed source evidence, account/exclusion/removal boundaries, typed core commands, context/MCP omission and purge. Synthetic coursework is used for these tests. The renderer must still verify click → saved state → restart → Undo, changed-source reopening, pending/error recovery and preserved return in the actual desktop app. Passing storage tests alone does not establish that journey.

## Desktop deadline consumer

`renderer/PersonalReport.tsx` binds shared Confirmation to `ResourceView.deadlineContributors`, projected from canonical `evidenceFor(...).contributors`. This supersedes the old calendar-only renderer mirror. Contributors include the assignment, accepted same-as evidence and every resource supplying a resolved or unresolved prose mention. The exact contributor set forms the issue identity; every content hash forms its version. Unknown, absent or mismatched provenance disables reporting with an explanation.

`resourceViews` filters evidence at use time with canonical course inclusion and inaccessible-source checks before resolving displayed claims. The storage write path independently validates current hashes, account scope, course access/selection and source access. No permission check relies only on the renderer hiding a row. Snapshot raw HTML/document parts are trimmed for IPC; stored source evidence remains intact.

`desktop-report-evidence.test.ts` verifies calendar-only and prose-only contributor changes reopen handling while assignment hash stays fixed, and inaccessible/excluded contributors disappear from resolution and refuse reports. Existing native synthetic verification covers handled/Undo/restart and changed calendar evidence; no generic completed command is used. Broader Home selection and duplicate-claim presentation remain separate work.

## Personal work checkoff (Courses)

Courses uses the separate `personal-work` command and `ResourceView.personalWork` descriptor. This is a student report about doing a canonical task. It never updates submission, missing, grade, source completion, attendance, or learning evidence. The existing reading-review and deadline-review contracts above retain their original whole-resource version semantics.

The core builds each work descriptor from the saved canonical resource and its current canonical deadline contributors. Identity is account + course + canonical resource, never a display title or generated row label. Each descriptor includes the source obligations and a version: normalized instruction-text SHA-256, title, due/unlock/lock/module dates, deadline claim values and authority, points, submission types, rubric criteria and module completion requirements. The fingerprint deliberately excludes raw `contentHash`, capture/update timestamps, submission state, score, grade, comments and a module requirement's `completed` flag. Personal planning-date choices are separate from source obligations. Renderer-only extra calendar associations must first be recomputed by the core before they can ground a saved work report.

`personalWorkState(snapshot.personalWorkReports, descriptor)` returns the saved `checked` fact, revision, receipt, exact differences, `needsReview`, and `scheduleChanged`. Instruction or requirement changes retain the student's historical check and timestamp while requiring review. Date-only changes annotate the changed schedule; they do not say the student has not done the work. Canvas submission/grade/comment changes leave the report intact. Source state must be rendered independently, and a checked graded task whose submission is missing, unknown or unconfirmed stays visible in its date group.

Send `{type: "personal-work", value: {...descriptor, operationId, checked, expectedRevision}}`. Keep saved state visible while pending; repeated intent is disabled. Retry uncertain transport with that exact operation ID and body. A changed intent or refreshed descriptor uses a new ID. `CommandResult.personalWorkReceipt` is the exact stored receipt; `snapshot.personalWorkReports` is freshly read and may already contain a newer Undo. Adopt only current scoped snapshots and non-regressing per-issue revisions. Ignore responses after source/account/course/view invalidation or purge. Surface validation errors with refresh/retry, and never announce saved success from optimistic state.

Undo uses the current descriptor/revision and `checked: false`. It stays available indefinitely, including after genuine requirement changes. History is append-only. Removing a secondary contributor hides that contributor's historical content but retains the primary task's checked fact and CAS revision with an unavailable-evidence review reason. Removing/excluding the primary source or course hides its report and refuses mutation. Expired sign-in may still use admitted saved sources. Unknown course membership is not checkable; a lecture/event is never checkable. A material requires an explicit assigned link, captured module requirement, or a captured module item of type Quiz/Assignment with a content ID; merely opening a resource cannot check it.

The SQLite preferences journal partitions by account and captured course term, avoiding a schema migration and keeping the older personal-report capacity unchanged. Each partition accepts up to 20,000 events / 2,000 distinct tasks before refusing further checks with an actionable error. Existing Undo remains writable even at capacity; there is no timer or silent expiration. Old term partitions stay local until Delete local data. This is bounded per term, not automatic archival or unlimited future-scale optimization. Only current display receipts enter local snapshots; history and reports are absent from AI/MCP context and purge clears every partition.

`tests/personal-work.test.ts` verifies real SQLite persistence/reopen, Canvas submission/grade/comment/missing changes, date annotations versus changed-instruction review, source removal/access and unknown-course boundaries, source-set validation, CAS, idempotent retries, historical Undo, term capacity, exact command receipts, context/MCP omission and purge. Passing these isolated checks does not establish the desktop pending/failure/retry/return journey; that remains the Courses integration's native verification gate.


The snapshot producer uses `personalWorkSnapshot(requests, savedResources)` once. It builds an ephemeral admission and assigned-URL index from the core's full current store read and fresh sources, course overrides and term settings. All row descriptors and report access checks use that index. It is discarded after the synchronous snapshot; no cross-request cache can outlive a capture, exclusion, account change or purge. The write command still revalidates the actual saved resources inside its SQLite transaction. A synthetic 1,900-material regression verifies four SQL reads and no resource-body re-decoding within this producer, rather than one full-account scan per material. This does not measure the whole desktop snapshot or IPC latency.
