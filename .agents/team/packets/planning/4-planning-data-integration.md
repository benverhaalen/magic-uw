# My UW data integration handoff

Updated: September 26, 2026. Human owner: Ben. Agent: Codex planning/integration root with bounded connector/domain helpers. Branch: main; coordination baseline d44dcf7. Scope: authorized planning brief, academic-source comparison, private access investigation, docs and push. No other teammate's work ownership is assigned here.

## Shared interfaces and status

Implemented locally and checked: separate planning contracts/storage (SQLite schema 4), native UW HTTP/sync/adapters, public catalog/package commands, saved DARS normalization, historical Canvas metadata, exact academic reconciliation, My UW renderer, and Home holds/appointments. Canonical capability/evidence map: [planning integration](../../../../docs/planning-upgrade.md). Current test/build/delivery state: [implementation status](../../../../docs/implementation-status.md#verification).

- `Snapshot.planning`: records, source health, and reconciliation. Use these source-preserving projections; do not infer official grades or duplicate earned credits from DARS appearances.
- Core `planning-import`, `planning-search`, `planning-sections`, and `planning-compare`; desktop bridge `syncPlanning` and service-specific `signInUW`. Native refresh feeds normalized captures into the worker. A generic normalized import is not a raw service adapter.
- Primary navigation follows Ben's direct decisions: Home / Courses / My UW with Wisconsin crest; Email deferred. My UW owns planning, with relevant holds and enrollment windows on Home. Existing visual exploration remains separate.
- Historical Canvas adds explicit completed-course discovery and own current/final grade metadata; older materials are not automatically deep-crawled. Existing learning and context paths remain separate.
- Planning never enters hosted AI, Jev, local tutoring context, or MCP. Private validation data/session/report files are outside this public repo.

## Decisions and limits for other workstreams

Progress precedes schedule fit; grades/ratings remain supporting evidence. Comparisons are individual course/package options, not a combined schedule or guaranteed requirement approval. Account binding, course identity, term, freshness, and evidence remain attached to claims. Existing transcript access was researched; production transcript ingestion, combined scheduling, language planning, and app-owned SSO/expiry validation remain open.

Read the Home clickable-reference packet before changing shared routing. This integration retains source links and does not implement the Home briefing redesign. The September 26 Home update keeps its action/link styling proposals explicitly open; its appended guidance and this integration's navigation change are compatible.

Direction conflict surfaced during final synchronization: Nathaniel's research branch says "a paid provider is required" and "a one-time $5 licence covers Jev and the service" ([original branch document, row 11](https://github.com/benverhaalen/magic-uw/blob/5bf86f7be3eac8e85fa5ccb2a0e925a721ca24f3/docs/notes/where-we-differ.md), dated September 26). Ben's accepted four-route/account direction is recorded in [decisions](../../../../docs/decisions.md). The research proposal is unmerged. Ben has been asked to resolve this with Nathaniel before provider/pricing changes land; no reported agreement yet. It does not block this local planning integration. Sean's newly shared video notes also identify this disagreement; this workstream does not lock their script or broaden the validated live-demo claims.

Next useful handoff: UI/routing work can consume `Snapshot.planning` and commands above while preserving stale/partial states and source identity. Use synthetic fixtures for shared work. Final integration and commit are the root's responsibility; remote publication is verified in the delivery message, not inferred from a local file.

The temporary coordination release cleanup remains required before September 27 at 11 a.m.; it has not been performed by this workstream. Follow [the agreed gate](../team/3-release-cleanup.md) with a claimed owner and coordinated push freeze.
