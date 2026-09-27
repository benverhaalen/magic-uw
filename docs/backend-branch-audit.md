# Backend branch integration audit

Audited September 26, 2026. Baselines: main `18a8486`, backend branch `1f8b1f7`, original Start work `2817609`. Historical research and recommendations; see the resolution below for the subsequent authorized product integration.

## Work boundaries

Ben reports three active windows: course page, sync resilience, and frontend UI. Git branch separation does not imply independent work.

- **Start work is already being adapted by the frontend lane** in `codex/desktop-start-work`. Do not separately merge the old branch or resolve that lane's working conflicts.
- **Backend features are a distinct older branch**, but ingestion, scheduling, contracts and storage overlap Nate's architecture and the sync lane. Port selectively.
- Sync resilience already uses schema **v9 locally**, preserving learning v8. Earlier collision warnings are superseded by that working-tree observation; local work is not a published integration.

## Objective and decision rule

Use the feature-planning skill: trace available course data through the normal consumer and recovery path. The student should reach the right work with less setup and receive source-grounded help without unintended disclosure. Prefer current main's consent, scoped queries, registered jobs, storage and learning seams. Reuse the old branch's useful mechanisms without replacing those seams. Backend helpers alone do not establish completed student features.

## Findings that block a blanket merge

### Derived evidence crosses a privacy boundary — reproduced

In backend `packages/core/src/mcp.ts`, `allowed()` gates the requested resource, but `evidenceFor(store)` sees all resources. Assignment deadline projection includes announcement-derived quotations and unresolved mentions. An allowed assignment can therefore expose communications even when communications sharing is disabled.

A synthetic SQLite/MCP test denied direct access to an announcement, then read the related assignment with course text allowed. The announcement marker appeared in deadline evidence. The intended privacy assertion failed. No private coursework was used.

**Required fix:** filter contributing resources by account, course and category permission before deriving deadlines. Removing quote fields afterward is insufficient: chosen dates, reasons, notes and unresolved mentions can disclose derived information too. Receipts must describe actual contributing categories.

### Identity and citations need the actual outgoing projection

- `identity.ts` validates outgoing quotes by scrubbing the source again with the current roster. Newly observed names can change placeholder numbering without changing the source hash. Bind citations to the exact sent projection and redaction map/version; test roster changes between sending and validating.
- MCP part offsets retain original coordinates while part text is scrubbed. Declare the coordinate basis or transform offsets consistently with main's excerpt contract.
- MCP `course_overview` returns `source.label` directly. Canvas constructs labels from source names. This is a code-inspected scrubber bypass; personal exposure depends on label contents, not demonstrated real data.
- Literal quote validation establishes occurrence in a particular source version, not semantic support for a claim. No generated-answer display consumer was found on this branch.

### Gateway refusal must not pause every job

The old branch's global `budgetUntil` gate precedes queue draining. Main now dispatches several registered job types. Apply Jev refusal deferral only to the affected provider/jobs; verify unrelated jobs continue after a Jev 429, including restart and cancellation behavior.

## Capability disposition

| Capability | Observed state | Integration decision |
| --- | --- | --- |
| Identity scrubbing | Roster discovery and core/MCP scrubbing exist | Port through current consent/egress and exact payload hashing; close derived-evidence and label gaps |
| Citation validation | Version/hash and literal-span command | Reuse primitive with immutable sent projection; do not advertise finished cited answers |
| Deadline prose | Deterministic extraction, span validation, scoped evidence and resolver | Adapt canonical resource views after contributor permissions; compare snapshot/query/MCP results |
| Fuzzy material links | Lexical candidates create proposed `supports` links | Keep reversible proposals; accepted `supports` are not consumed by existing supporting-material queries, so define that consumer explicitly |
| Calendar recurrence | Both branches implement recurrence; main has Outlook course identity support | Preserve main; transfer only missing behavior and edge tests after comparison |
| Madgrades | Protected token, transport, planning records and summary command | Useful partial backend; no normal setup entry found and API compatibility only fixture-tested |
| Jev budget refusal | Typed 429 deferral exists | Adapt per-provider/job, preserving current dispatcher |

Fuzzy linking's nominal time budget starts after course indexing/tokenization, so it does not bound all preprocessing. Move expensive work into the current job mechanism or accurately describe and measure that soft limit. No tuned automatic-link threshold is established by these lexical scores.

## Start work: retain the frontend adaptation

Original journey: assignment detail → review bounded destinations from accepted supporting links → main-process revalidation → open local copies or URLs → independent failures/retry. Current frontend adaptation adds course-inclusion checks, preview identity, bounded retry tracking and local-path checks absent from the old branch.

The active bridge is `startWork(id, previewHash, only?)`, superseding old handoffs using `startWork(id, only?)`. Frontend integration is still in progress; do not treat its dirty worktree as merged code.

Remaining acceptance work:

- Describe actual link provenance; a traversal or manually accepted link must not be labeled a direct Canvas link.
- Show relevant stale/partial destination state. A preview hash is not a freshness guarantee.
- Verify normal Home/assignment entry through review, partial launch, retry and return on current main.
- Exercise excluded courses, changed destinations, local-file fallback and real application opening. Mock openers alone do not demonstrate the desktop journey.

## Evidence and limits

- Fresh fetch at audit end still reported main `18a8486`.
- Dry merge of backend branch against main produced **10 conflicting files**, including desktop ingestion/main/worker, contracts/core/domain/storage, calendar, status docs and calendar tests. No actual merge was performed.
- Detached backend branch: `pnpm check` passed; six focused suites passed **51 tests**. These establish branch behavior only, not integration with current main.
- Additional adversarial MCP test failed as described above. Its synthetic reproduction and logs remain in the isolated local audit checkout, outside committed product files.
- Separate read-only Start work and backend audits were reviewed by the driver. An independent Jev-hosted review identified the label bypass. Its claim that consent previews were absent relied on older branch documentation and is not accepted as a current-main finding.
- No live private course data, credentials, real-app launch or live Madgrades response was used in this audit.

## Recommended next integration

1. Let frontend finish its existing Start work adaptation and publish the bridge contract.
2. Port scrubber/citation primitives onto current egress, with contributor-level permissions and immutable projection tests before sharing any derived response.
3. Port provider-specific budget deferral without obstructing the sync lane's jobs.
4. Integrate deadline extraction through canonical queries with privacy and authority regression tests.
5. Keep fuzzy proposals and Madgrades explicitly partial until their normal consumer/setup journeys are connected.

This preserves Nate's current architecture and the three active windows. It is an integration plan, not authorization inferred from branch existence.


## Selective integration resolution

Ben authorized integration after the audit. The isolated `integration/backend-current` branch now includes current main through `23fd8b6`, preserving Nate’s T17 scheduler, wave-D learning operations and My Magic UW rename. The current architecture remains the integration base. No active frontend/course/sync worktree was reset or rewritten.

- **Evidence privacy:** MCP filters contributing sources before deadline derivation and reports their categories. Source labels, section names, grade/comment strings and nested evidence use the scrubber. Search and output use the resource’s account-scoped roster.
- **Identity and citations:** automatic local roster capture and immutable outgoing projections are integrated. Tests cover roster changes, denied communications, unseen quote ranges, compressed record history and purge. Necessary profile identifiers live in the private local roster; this is deliberately distinct from exporting them in coursework/snapshots.
- **Study generation:** Nate’s actual quiz/card runner now checks and scrubs every initial/retry/escalated send, binds previews to outgoing prompt/input/schema, restores citations from frozen passage maps and discards results after evidence or permission changes. See [the exact boundary and limits](pipeline-details.md#study-generation-at-the-actual-send-boundary).
- **Deadlines:** deterministic source-anchored prose extraction enters canonical queries. An explicit prose extension conflicting with structured Canvas remains a visible conflict with a conservative planning date; it is not promoted to unquestioned truth.
- **Jev recovery:** kind-scoped durable cooldowns preserve other registered jobs. Typed budget refusals survive the desktop IPC path; tests cover restart and retry bounds.
- **Madgrades:** protected token transport and public planning comparison are integrated. Student token setup and live response validation remain open. Historical grades do not rank recommendations or establish mastery; private planning data remains excluded from AI/MCP.
- **Deferred:** fuzzy material linking and old Start work were not merged. Main’s existing calendar behavior is preserved. Frontend keeps ownership of its current Start work bridge and UI adaptation.

The driver inspected scoped worker diffs and an independent account-scope review; the latter exposed a search-redaction bug fixed before delivery. A worker’s Jev review highlighted contributor-category and authorization placement issues during development; the final boundary was checked directly and exercised with synthetic runner calls. No live provider, personal coursework, Madgrades response or external application launch was used for this integration.

### Combined verification

Integrated product revision `218cad1`: TypeScript and desktop/web build passed. The complete suite passed **734 tests, with one Windows-only skip** (735 total) using Node 24 and test concurrency four. The hidden Electron check passed renderer → preload → worker → SQLite, including synthetic planning import, MCP export and local purge. The first hidden run timed out after initial Electron download; the unchanged built app passed on rerun, so the initial cause remains unproven. An installation-only PTY executable-bit issue was repaired with the repository's existing native preparation script; its eight tests then passed.

These checks establish the combined synthetic integration and hidden desktop bridge, not live provider quality, live UW access or frontend usability. Private logs and generated build outputs remain outside committed files.
