# 17 — Backend merge plan: read only, do not act

From: backend lane (Nathaniel's session) · To: Ben · 2026-09-27, ~07:00 CT

**Please don't act on anything in this packet.** Don't merge, rebase, cherry-pick or edit any branch listed here. It's for awareness only, so you know what is coming to `main` and how to be ready. Nathaniel will say when a step needs you.

## What we're doing now
| Work | Branch or PR | State |
|---|---|---|
| Wave 2: sync speed, file downloads, AI efficiency, GPA calculator, notes to a cloud folder, tab speed | PR #53 (`integrate/wave2-0927`) | re-merging `main` (your shell wins on renderer files, ours on backend), then merging |
| Course Analytics tab (grade trend, completion, prep, mastery, next steps) | PR #55 | mounted in your course page through two optional props (`tabs`, `tabBody`); merging on verify |
| Study prepper: catered item spaces, Study & Learn (every work item ranked by due date), Home study card, KaTeX | `land/study-prepper` | only its own 9 commits, cherry-picked onto current `main`; `pnpm check` passes; PR next |
| Stall fix: the 2 s snapshot poll is replaced by a change signal (`magic:changed`; `onChanged` optional on `AppBridge`) | `perf/stall-audit` | an idle window now does 0 snapshot reads (was 4 per 10 s, 6.8 MB each); your `SnapshotGate` does the reading; your poll stays as the fallback; PR next |
| Data & AI page redesign (Your AI, What you share, Before sharing, Jev, accounts, voice, your data, "Start fresh" reset at the bottom) | `feat/data-ai-page` | building on your page (f6e5b29) with your components |
| Break card: checked quotes, unchecked sentences (B1–B4 fixed) | `feat/break-card-v2` | building |
| Docs: one README entry point, one architecture doc, one status table, old docs to `docs/archive/` | `docs/repo-state` | drafting; links your design docs, doesn't rewrite them |
| Marketing site: every current feature, silent loops, $5 a month | PR #56 | waiting for Nathaniel's review of the Vercel preview |

## What we plan next (after the above)
- Flashcards and quizzes by subject: formula, "why", worked-step, bidirectional vocabulary and date cards, with sets following the assessment's blueprint. These are new pack versions, so the cache refreshes cleanly.
- The `reply: "result"` slim replies extended to `command`, `pack` and `workspace`, so no action returns the full snapshot.
- Per-page snapshot slices, so each page reads only what it renders.
- The item space reusing your LearningPanel: one study surface, not two.
- Wiring the prep-first prompt to your "Open in Canvas" buttons.

## How to be ready for the merges
- **Nothing to do yet.** When these land, pull `main`, run `pnpm install` if the lockfile changed, then quit and restart `pnpm dev`.
- **Files our merges touch in your area** (additive, with thin mounts): `App.tsx` (the snapshot effect, the course tab state, the Study & Learn route), `DesktopShell.tsx` and `navigation.ts` (one nav entry), `Home.tsx` (one study card), `courses/CoursePage.tsx` (two optional props), the preload, and `contracts` (optional fields only). If you're mid-change in any of these, tell Nathaniel instead of resolving it yourself.
- **Your renderer wins every conflict;** we re-apply our mounts onto your version.
- **Sean's branches:** `sean/sync-timeout-fix` and `sean/page-scope-clock` were reviewed as sound. Sync-timeout should merge after wave 2, dropping its `App.tsx` in-flight guard (the change signal replaces it). That is Sean's merge.

## Open decisions (Nathaniel's or the team's, not yours to act on)
- **Pricing:** $5 a month. The site copy is updated on #56. The Lemon Squeezy webhook (`api/lemon-webhook.ts`) handles only one-time `order_created` and `order_refunded` events; a subscription needs a monthly product in Lemon Squeezy and subscription events handled.
- **Embedded Jev key:** any keyed build can have its key extracted. It's temporary until a hosted gateway exists; rotate the key when that moves.
