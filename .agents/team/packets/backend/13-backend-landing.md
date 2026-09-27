# Backend landing wave and the UI handoff (September 27)

Human owner: Nathaniel. Agent: Claude Code lead with scoped builders and independent reviewers. September 27, 2026. Base: main `2f4cc27`. Status: all of these land together through one integration PR, `integrate/2026-09-27`, merged with a merge commit so each branch's own PR closes. See that PR for the per-branch review verdicts and checks. Sync speed, GPA, notes-to-folder, Study prepper and the course tabs follow in the next wave (packet 14).

Why you're receiving this: the backend lane is landing its finished work on main. Several PRs touch shared seams you'll meet while finishing the frontend. Our new UI (dark mode, accent tokens, floating chat) lands on main once it builds and passes. Your design integration is merged in when you say it's implemented and working, and your structure wins where the two meet.

## What lands, in order
Each branch is merged with current main, reviewed by a reader who didn't write it, has its findings fixed, and merges on green CI.

| Branch | For the student | Seams you'll touch |
|---|---|---|
| feat/privacy-hardening (#25) | protection on every egress path; teaching content kept | core egress, worker |
| feat/doc-window (#31) | a synced note opens in Word/Docs inside the app's signed-in window | main, notes preview |
| feat/remember-signin | opt-in "Remember my sign-in" on the UW login page; fills once per expiry, never touches Duo | main, App.tsx (Sources › UW Canvas row), preload, scripts/build.ts |
| feat/critical-agenda (#27) | critical-action agenda, least slack first | worker, agenda queries |
| feat/site-recipes | course websites triaged (sync / read once / link only / ignore) before any fetch | ingestion.ts, worker.ts |
| feat/page-views | the four page views as a Workspace tools tab | WorkspaceTools.tsx |
| feat/exam-prep | exam blueprint, practice exam builder, step-checked solving | packs, learning router |
| feat/item-eval | an item-quality evaluation harness for cards and quizzes | evals |
| feat/course-facts | course facts | core, preview tab |
| docs/professional | benchmarks and research docs | docs |
| fix/current-courses-only | only this term's courses; a "Your courses" onboarding step before the first read; nameless and past courses never stored or read | onboarding step list adds `"courses"` after `"uw"`; syncCanvas type in contracts; main, preload, worker |
| fix/client-detection | finds the student's Claude Code/Codex on any install layout, by capability not version; an env allowlist; a tool-use tripwire; Codex tools off | onboarding health copy; the Data & AI select offers Codex |
| perf/repeat-sweep | repeated reads removed (e.g. the course summary goes from 83,499 statements to 18) | new CI step `pnpm test:budgets`: statement caps gate, timing report-only |
| feat/course-mastery | evidence-based topic mastery, "Build my strategy" | a Mastery tab in Workspace tools |

## The UI, and how your branch joins it
- Branch `feat/floating-chat` carries `local/ui-preview`: dark mode and the accent set as design tokens (`docs/design/tokens.css`, a `--magic-wizard-*` block), the renderer's colours routed through tokens, and the floating wizard chat (`renderer/floating-chat/`, mounted once on `<body>`, hosting the existing ChatPane). It lands on main once it builds and passes. Sean's accent frame (`2f4cc27`) is kept, with dark values added.
- We are not building on `codex/desktop-design-integration` while you're still working on it. When you say it's implemented and working, our lane will do the reconciliation with main for you if you want, and **your structure wins on the shell and shared screens**: layout, navigation, Home, courses, prepared work, motion and docs/design. Ours layers onto it: tokens mapped onto your components, with dark values for anything new, plus the chat and the feature tabs.
- Tell Nathaniel, or reply in this packet, when your branch is ready, and anything we should know about your token or component names.

## Decisions that need you
- **H2:** does "Remember my sign-in" (D39) fit "never automate Duo or bypass expiry"? As built, it fills the NetID form once per expired session, only with the student present and the app focused within the last minute. After an unfinished Duo it stops until the student signs in themselves. It never touches Duo.
- **Codex Quick chat:** it currently gives the model a shell (`-a untrusted`, tools on). The client-detection PR turns tools off or removes Codex from Quick chat. Say if you want it kept another way.
- **The top-bar chat button** opens the floating chat once our UI lands.

## Known open items (not in this wave)
- **Outlook:** the whole Graph path is built but never run live. It needs a registered Microsoft app, or a decision to use the UW web session. The inbox page is proposed, not built.
- **Ctrl+K and Ctrl+Shift+Space** are bound on no branch. The intent router backend exists; dictation isn't built.
- **Site-triage decisions** aren't shown in the UI yet, and the `open` event isn't sent, so read-once pages aren't read.
- **Item kinds** are too coarse for per-type components; a derived `itemType` is proposed.

Evidence: each PR body lists its checks, review verdict and what is live-verified vs tested in isolation.
