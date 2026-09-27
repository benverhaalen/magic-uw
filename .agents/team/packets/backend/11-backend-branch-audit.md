# Backend branch audit and integration boundaries

Human owner: Ben. Agent: Codex driver with scoped read-only reviewers. September 26, 2026. Audit base: main `18a8486`; backend `1f8b1f7`; original Start work `2817609`. Status: historical audit complete; authorized selective integration is verified for delivery (see below).

See [full audit](../../../../docs/backend-branch-audit.md) for evidence, limits and acceptance checks.

- Start work is already being adapted in the frontend lane. Do not merge the original branch separately. Active bridge includes `previewHash`; old bridge handoffs are superseded.
- Backend branch needs selective adaptation to Nate's current seams, not blanket merging. Ten dry-merge conflict files.
- Synthetic MCP test reproduces denied announcement text leaking through an allowed assignment's derived deadline. Filter contributing evidence before resolving, not just output quotes.
- Identity/citation port must pin the actual outgoing scrubbed projection and offset map. Source overview labels also bypass scrubbing.
- Scope Jev refusal backoff to affected jobs; preserve registered non-Jev work.
- Sync resilience has already moved to v9 locally, preserving learning v8. This observation does not claim a pushed implementation.
- Backend check and 51 focused tests pass; the new privacy assertion fails. Integration with current main remains unverified.

Next action: frontend retains Start work; backend integration starts with privacy/egress adaptation and focused regression checks. No active worktree was reset, stashed or merged by this audit.

## Authorized integration in progress

Ben authorized selective backend integration after this audit. Base refreshed to main `274f738`, including Nate's T17 sync scheduling. Isolated integration branch: `integration/backend-current`; scoped backoff worker: `fix/scoped-jev-backoff`. No frontend ownership change.

Current scope: identity/citation projection and contributing-evidence privacy; deadline extraction through canonical queries; provider-scoped Jev refusal handling. Preserve current sync scheduler, consent/egress, learning v8 and registered jobs. Avoid App/preload/Start Work changes. Fuzzy and Madgrades remain partial unless separately integrated and verified; do not infer their adoption from this handoff. Driver will fetch/reconcile before publishing tested product changes.


## Selective integration verified for delivery

Driver branch `integration/backend-current`, based on main through `23fd8b6`; includes Nate’s wave-D runner/learning work. Canonical [resolution and limits](../../../../docs/backend-branch-audit.md#selective-integration-resolution).

Ports: identity/citation projections, permission-filtered deadline evidence, scoped durable Jev backoff with IPC error metadata, public Madgrades comparison. New study-generation protection hooks the existing runner before every actual send and after provider awaits; no replacement learning framework or frontend changes. `RunRequest.beforeCall` / `afterCall` are optional hooks, adopted by the quiz/card handler. Other model-call paths need their own explicit adoption.

Frontend retains Start work; no App/preload/renderer files were changed in this integration. Sync retains T17 and its v9 work. Relevant overlap for sync is `apps/desktop/src/ingestion.ts` (automatic local identity capture), `worker.ts`/`main.ts` (Madgrades and typed budget errors), core dispatch and storage preferences. Pull the completed integration before resolving those overlaps; preserve both capabilities. Do not replace the current branches with the older backend branch.

Known limits: roster scrubbing is not anonymization; literal citations are not semantic proof; Madgrades lacks normal setup UI/live validation; old cache artifacts are invalidated rather than individually erased; already-sent model requests cannot be recalled. Verification: product revision `218cad1`, 734 tests passed and one Windows-only test skipped; TypeScript/build and hidden Electron bridge passed. Delivery commit includes this packet and will be on main; pull main to integrate. No live provider or private coursework was used.
