# Personal planning date choices

The desktop “Review dates” journey can save one of at least two distinct sourced due-date options, change it, or Undo. This is the student's personal planning choice. It does not verify a Canvas deadline or alter source claims. `Resource` and `ResourceView.deadline` remain unchanged; `ResourceView.personalDeadline` is a separate local projection.

## Contract and source evidence

Core builds options from current permitted canonical deadline evidence. Only due claims with confirmed scope and non-title authority are selectable. Equivalent instants with equal precision form one option, retaining all their claims. A day-only date retains `precision: "day"`; its value encodes the start of that America/Chicago date and must not be presented as midnight or a known time. Minute options represent exact instants and can be displayed in the user's timezone. Fewer than two options cannot create a new choice.

`personalDeadline.sourceVersion` fingerprints the account, target resource, complete sorted contributor resource IDs/content hashes, canonical claims, and unresolved mentions. New, removed, changed or newly linked source evidence invalidates a saved selection even if the assignment's own hash stays fixed. The current projection then has `selected: null`, `needsReview: true`, and the previous revision, allowing a fresh review or Undo. The saved choice never suppresses raw conflicting source evidence.

Send `{ type: "personal-deadline", value: { operationId, resourceId, sourceVersion, optionId, expectedRevision } }`. IDs/version/revision come from the current resource projection; `optionId: null` is Undo. Generate one operation ID per user intent and reuse the identical request for uncertain transport retries. Adopt the returned current snapshot, and retain current saved state while pending. A stale/error response requires refresh and an explanation, never a successful visual state. Responses must be ignored if superseded by a newer resource/evidence generation.

## Persistence and concurrency

A separate `personalDeadlineChoices` preferences journal leaves boolean personal reports unchanged and requires no schema migration. Writes run inside the store's existing `BEGIN IMMEDIATE`. Core recomputes the source options inside that transaction through a trusted callback; the renderer supplies no claims or arbitrary date. Storage independently checks target identity, contributor accessibility, account scope and hashes. Per-account/resource compare-and-swap revisions prevent lost updates. Exact operation replay returns its original receipt without appending or reapplying it; core subsequently returns a freshly computed snapshot, so delayed Save cannot reverse Undo/change. The journal preserves selected value/precision, source fingerprint, contributor hashes, account and server timestamp. Its 10,000-event/1,000-target bounds refuse new writes rather than discard provenance. Corruption fails closed.

An old removed contributor does not erase the target's revision: current access to the same target/account allows a `needsReview` projection with no old claims. Excluding/removing the target or rebinding it to a different account hides its old choice. Local purge removes the journal. AI context and the MCP source projection do not include the personal choice.

## Consumer adoption

`personalPlanningAt(resource)` chooses current personal value or falls back to the canonical conservative planning date. Canonical resource-view ordering uses this helper. Desktop Home, Upcoming, Calendar, detail and course surfaces must deliberately use it for planning group, ordering and display, label an active selection as the student's choice, and preserve raw Canvas/prose claims in evidence. Keep day-only precision through labels and month/agenda grouping. Conflict-review counts should count resources with distinct eligible options and no current personal selection; boolean “handled” reports are not date choices. No external calendar or Canvas write occurs.

The adapter's SQLite restart, independent-connection CAS, change/Undo/retry, contributor addition/removal, same-instant/precision grouping, access/account, context/MCP and purge tests use synthetic data. Full desktop consumer integration and rendered save → return → restart → change/Undo are the frontend integration owner's remaining verification. Storage checks alone do not establish that journey.

For Nate/backend review: additions are confined to the contracts/core/storage adapter files and their index/query registration; migration code and acquisition routes are untouched. The callback is an internal trusted-code seam, not a wire contract. Source deadline resolution and raw storage remain the evidence authority; this projection is explicitly personal.
