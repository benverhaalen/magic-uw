# Prepared work integration

September 26, 2026. Owner: desktop frontend integration lane. Selective port of `e5ef090` from `feat/start-work`, against `ddf93e9`. No application layout or shared renderer file replaced. This is an implementation handoff, not a claim that the shared app already mounts it.

## Entry and contract

Home Upcoming precomputes the current WorkSet and shows its exact destination labels before activation. Its compact whole-row **Start work** button launches that displayed set directly with its previewHash; no mandatory detail/chooser step. Receipts and retry controls are separate siblings. Named briefing object links still open detail for inspection, where the full StartWork component is an alternate entry below instructions. Both variants share the same preparation/launch engine.

- `execute({type: "work-set", id})` returns `workSet` with `previewHash`.
- `startWork(id, previewHash, onlyFailedIds?)` returns a per-target receipt. The hash is mandatory; the earlier two-argument retry API is superseded.
- Native code rebuilds the saved target set and refuses changed versions/destinations. The student must refresh and review it again.
- Only accepted supporting evidence in the same account/course is included. Direct links and indirect/accepted support have different descriptions. Saved-source refresh time and partial/error state remain visible; a matching hash does not mean a live Canvas read.
- At most six destinations open, assignment last and in front. Suggestions and overflow stay held. No terminal, VS Code, GitLab app automation, completion or mastery inference is fabricated.
- Retry can only narrow to failures from the session receipt; successfully opened targets are not reopened by retry. Failures not selected for retry remain eligible. Receipt cache is bounded and is not restart-persistent.

## Current boundaries

Existing sender guards remain. Current UW consent and course inclusion are rechecked before launch and each native operation. HTTP(S) links reject embedded credentials; local documents require extraction eligibility, allowlisted extension, canonical cache containment and non-symlink opening copies. One app-wide launch runs at a time to avoid interleaved tab storms; another attempt gets a recoverable in-progress error. Purge and source changes cause fresh revalidation to fail.

The browser preview endpoint is a verification-only dry run and cannot open native apps; it does not model setup consent. Actual permission behavior is exercised through Electron's IPC smoke. Local document/browser fallbacks produce distinct receipts. Shared confirmation state belongs to the separate personal-report implementation.

## Verification and audit

Use Node 24 (`/opt/homebrew/opt/node@24/bin`): `pnpm build`, `pnpm exec tsx --test tests/start-work.test.ts`, then `pnpm exec tsx scripts/desktop-smoke.ts`.

Thirteen core tests cover accepted/held evidence, scope restrictions, destination binding, retry narrowing, partial sources, file eligibility/escape/symlinks, fallback and withdrawn permission. Hidden Electron verifies renderer → preload → worker → SQLite, rejects missing consent, malformed or stale previews and unfailed retries, and dry-runs the fixture's two destinations. It deliberately suppresses external application launches; real OS app opening remains to be demonstrated in the integrated user journey.

A separate Jev read-only review identified stale receipts after a failed refetch; the component now clears them. Its IPC-coverage gap was closed by the native smoke additions. Its objection to a global launch lock was considered; serialization is retained intentionally as described above. A private browser harness exercised pending action suppression, partial receipts, retry of only the failed destination, combined receipts, and stale receipt removal on course-access failure. The harness used a simulated adapter and proves renderer behavior, not native launch success.

Fetched incoming `origin/main` through `80b5aa3` and the backend audit packet: learning contracts are additive; preserve both the learning and Start Work smoke blocks when integrating. Do not merge the original Start Work branch separately.
