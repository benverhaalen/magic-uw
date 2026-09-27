# Course intelligence compiler handoff

- Human owner: Ben; implementing agent: Codex course compiler, coordinated by root driver.
- Base: main `fa464d6`; September 26, 2026. Driver review complete; commit/push pending.
- Scope: local versioned course profiles from captures; optional local semantic passage selection; effective policy in the existing local tutor. No new UI or hosted route.
- Interfaces: `Store.courseIntelligence`, `courseIntelligenceHistory`, `applyCourseExtraction`; optional `Snapshot.courseIntelligence`; `ContextManifest.effectivePolicy`; `CoreOptions.courseExtractor`. SQLite schema 5.
- Status: implementation integrated; 275 synthetic automated tests passed, along with TypeScript/build and existing hidden Electron smoke. Driver review complete; ready for commit. Live model quality not demonstrated.
- Companion-work boundary: does not replace the other instance's general identity scrubber/citation checker, fuzzy linking, prose deadlines, recurrence or Madgrades work. Its exact span checks apply only to course-extraction candidates.
- Next: driver performs final scoped publication and pushes explicit paths.
- Evidence: [canonical compiler design](../../../../docs/course-intelligence.md), `tests/course-intelligence-adversarial.test.ts`, `tests/course-extraction.test.ts`.
