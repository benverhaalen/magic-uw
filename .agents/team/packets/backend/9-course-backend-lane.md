# Course backend lane: what exists, what's building, what's next

Updated: September 26, 2026, about 22:45 CT. Human owner: Nathaniel. Agent: Claude Code (Opus 5.5) leading delegated implementers and reviewers. Code branch: `feat/course-backend`, local and **not pushed** (it carries the coordination history, so it waits for the release cleanup). The plan and research notes are now on main: `docs/plans/2026-09-26-course-backend/` (spec, plan D1–D45, tasks, execution) and `docs/notes/`. An architecture document (`docs/course-backend-architecture.md`) and a product direction document (`docs/magic-canvas-direction.md`) follow in the next docs push. This packet is updated at each piece boundary.

## What the lane is building

A local-first course backend: connect → store → map → generate → study. The principle is "AI writes, code decides": code for exact facts, Jev for typed judgments on code-built candidates, one checked call on the student's own AI client where language must be read; studying costs 0 tokens. Two launches on top: an open-source academic database platform (a versioned read contract, a read-only MCP course bank, scoped tokens) and the paid product. Pricing is an open decision between Nathaniel and Ben (plan §9 H1).

## Built on the branch (checks at `b496d0a`: `pnpm check` clean, `pnpm test` 359/359)

| Task | What | Status |
|---|---|---|
| T05a | test harness; Windows-safe suite | integrated |
| MT1 | perf harness and synthetic baseline (`pnpm magic:perf --suite baseline`) | integrated |
| T05d | consent contracts, `codex`/`openrouter` providers, main-process consent gate, presence-aware scheduler | integrated |
| T05c | expiry confirmed by a profile read (a permission error no longer means "signed out"), relaunch check from the cookie store, one-click "Sign in again", Keep me signed in (tray, start at login), My UW / Enroll sign-in confirms itself | integrated |
| T06 | one-checkbox consent before any network request; consent enforced in `maySend`; worker network clients gated; first-send preview for sensitive categories kept | integrated |
| T12, D38, T40, T13 | model runner (Claude Code, Codex, API keys, Ollama), warm session pool, client detection and engine choice, prompt-pack core with grounded-quote checks and a content-hash cache | tested in isolation, merged; not wired into the worker yet |

Nothing is demonstrated live yet; the first NetID live trial is open now with Nathaniel.

## Building now (lane branches)

- Data layer: schema v6/v7 after the team's v5, passages with offsets, contentless passage FTS with OR + BM25, backups before migrating, atomic migrations.
- Seams, course-space inventory (D32), per-course content probe (D37: Canvas's activity stream never carries files, pages or module items — `lib/api/v1/stream_item.rb`), per-course access state (D41).
- Learning engines (pure code): FSRS, levels, assessment sections, flaw checks.
- Onboarding (D45): detect Claude Code / Codex / Gemini CLI, create an **isolated app-owned client profile** (`CLAUDE_CONFIG_DIR`; verified on this laptop that it doesn't touch the student's `~/.claude`), sign in inside a built-in terminal, then the UW step. Screens follow `DESIGN.md`.

## Shared interfaces this lane changes (additive)

- `@magic/contracts`: providers `codex`, `openrouter`; consent records and the `consent` / `preview.ack` commands; `EgressReceipt.status` adds `preview_required`; `privacy.alwaysPreview`; `AppBridge.keepSignedIn`; coming: `AppBridge.clients` (detect, prepare, authStatus, choose, terminal).
- `main.ts`: a consent gate on every network channel; a redirect's origin and path forwarded from `source-fetch` so a login bounce is recognised.
- `worker.ts`: network clients built through `createWorkerClients` (gated on consent).
- Storage: ours becomes v6/v7 because the team's course intelligence took v5.

## Measured tonight (synthetic data, this laptop)

- Every command returns the full snapshot: 28.8 MB at 5,000 resources.
- Ingest slows from 1,212 to about 63–78 resources/s as the store grows; the cause is the FTS delete by an unindexed `resource_id` (about 88% of ingest time).
- A zero-change Canvas re-sync still makes 87% of a full sync's requests.
- Passage search: OR + BM25 found 10/10 planted answers where prefix-AND found 0/10.
- The second copy of course text in the search index is 31% of the database file.
- Canvas and UW session cookies are session cookies, so every relaunch signs the student out (why T05c exists).

## Findings for the team

- `integration/backend-features` overlaps our plan (deadline prose extraction, fuzzy supporting material, identity scrubber, citation spans). Our plan now reuses it once merged.
- `pipeline-details.md` says the app never keeps a session alive; the 10-minute background probe does so in practice. T05d now reads Canvas only while the student is present.
- The MCP credential permission check in the desktop smoke test can't pass on Windows (POSIX mode bits); the export itself works.

## Open human calls (plan §9)

H1 pricing and setup prerequisites · H2 "Remember my sign-in" against "never automate Duo or bypass expiry" (our reading: re-authentication, Duo stays the student's) · H3 the sign-in window opening by itself · H4 Jev links and scopes applied without a confirmation chip · H5 the subscription CLI route (Anthropic's terms permit the unmodified binary with the student's own sign-in; OpenAI's are silent) · H6 the syllabus brief against the course-intelligence profile · H7 the command-bar workspace against the near-approved Home · H8 the mastery display. Nathaniel will raise each directly.

## Release cleanup

The September 27 release cleanup is still unclaimed. This lane offers to prepare and verify the history rewrite in a local mirror; a human runs the push.
