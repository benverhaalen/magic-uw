# Activate coordination and share current work

Updated: September 26, 2026. Owner: Ben's design/coordination agent. Status: active trial; other teammates' adoption and work ownership unconfirmed. Scope: keep the existing task productive while exchanging bounded, source-linked context. Storage decision: [Ben's exact correction](../../sources.md#same-repository--current-storage-correction).

## One-time activation for an existing Claude/Codex session

After safely pulling, read AGENTS.md and .agents/coordination.md once. There are no automatic hooks. Read the relevant packet files directly or use the optional manual checker. Pulling alone does not prove the current agent loaded instructions. Keep the current task; read only relevant packets. Create a small work packet with your human owner, agent, branch/base commit, scope/shared interfaces, and next useful handoff. Ask your human directly about conflicting human direction so teammates can discuss together in person.

Agents should check at natural work boundaries roughly every few minutes; this is written guidance, not an enforced timer. The optional checker throttles repeated calls to five minutes. They read remote packet metadata; relevant content is retrieved on demand. They do not monitor idle agents, upload logs, merge files, or publish on your behalf. Continue building and share meaningful changes when they affect someone else. No extra repository, invitation, or clone is needed.

## Evidence and limits

Earlier experiments tested automatic delivery; Ben subsequently requested no hooks. Those configurations have been removed. The manual checker has local fixture tests; remote transport is checked after publishing. Teammate adoption remains unverified. Exact sources and interpretations stay separate. See the [release cleanup check](3-release-cleanup.md) before judging/sharing.
