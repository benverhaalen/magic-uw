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
