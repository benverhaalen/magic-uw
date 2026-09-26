# Release check — remove temporary coordination before sharing

Recorded: September 26, 2026. Requested by Ben; executing teammate/agent must claim ownership before starting. Status: **required, not completed**. Deadline: **September 27, 2026, before 11:00 a.m. America/Chicago (CDT, UTC−05:00)**. Begin early enough to finish and verify before the deadline.

Source: [Ben’s exact requests](../../sources.md#release-cleanup-and-no-hooks--latest-correction). This is a written release gate, not an automatic hook, timer, or scheduled job. Removing files at HEAD alone does not satisfy the history-removal request.

## Before judging or sharing

- [ ] Claim the cleanup with the team and agree on a brief push freeze. Preserve everyone's local/uncommitted work; do not reset, stash, or rewrite an active shared checkout.
- [ ] Inventory published branches, tags, and PR refs. Make a private local recovery backup outside the repo. Never publish backup refs containing the removed material.
- [ ] Remove `.agents/team/`, `.agents/coordination.md`, `.agents/team-sync.mjs`, and `.agents/team-sync.test.mjs`. Remove only the temporary `Active team handoffs` section from AGENTS.md and the coordination-only CLAUDE.md bridge; retain any unrelated instructions added later.
- [ ] Purge this temporary content from relevant published Git history using an isolated mirror and reviewed path/content filtering. Include historical team-sync hooks in `.claude/settings.json` and `.codex/hooks.json`, preserving unrelated settings. Do not delete whole mixed-purpose commits: settled product/design docs and application changes must survive. Inspect historical coordination pointers outside the removed paths too.
- [ ] Review the rewritten diff/refs and verify absence of the temporary paths and text. Update each agreed remote ref with its explicit expected-old-ref lease. Stop and reconcile any concurrent push; never use an unrestricted force push or delete unrelated refs.
- [ ] Verify remote results; tell teammates which refs changed and how to fresh-clone/reapply their saved work without merging the old history back in. Check PR refs/cached views separately. Report any inaccessible refs or retained copies honestly.
- [ ] Confirm completion to Ben **before 11 a.m.**; if blocked, report what remains promptly. Remove this checklist itself as part of the cleanup.

Scope is temporary coordination scaffolding and its history, not legitimate product/design documentation. Git history rewriting cannot guarantee erasure from existing clones, forks, or hosting caches; any residual copies need separate handling. This checklist is visible because the product repository is public; a dot directory is not privacy.
