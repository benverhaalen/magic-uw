# Sources: every number, asset and licence in the film

Nothing unmeasured is shown as measured. Each on-screen number keeps its label in the frame.

## Numbers on screen (scene s09-proof, 1:19–1:30, and Ben's line s9)

| On screen | Label in frame | Source (file, line) | Arithmetic |
|---|---|---|---|
| **24×** faster to reopen · "70 s → 2.9 s on the second launch" | Measured on a synthetic account | `docs/status-2026-09-27.md` line 36 on `origin/main` (`ccd21f8`): "relaunch 283 → 8 requests (70 → 2.9 s)". Harness detail: `evals/perf/sync-account.results.md` on `origin/fix/sync-events` (`663dcaf`), line 34 (second launch 70,068 ms before) and line 66 (2,869 ms after, 8 requests). Lines 3–8 of that file describe the synthetic account. | 70,068 / 2,869 = 24.4 → "24×" |
| **35×** fewer requests to reopen · "283 → 8 requests" | Measured on a synthetic account | Same status line 36; `sync-account.results.md` line 16 ("Second launch within the window: 283 (full) → 8"). | 283 / 8 = 35.4 → "35×" |
| **55%** of everyday actions need no AI call · "vs 1% for a typical AI study tool" | Modelled over a synthetic semester | `docs/status-2026-09-27.md` line 42 ("55% of our actions use no model vs 1%"); `docs/semester-model.md` on `origin/bench/semester-model` (`c9cfea8`), lines 11–15 (the "Uses answered with 0 tokens" column) and line 3 ("modelled on synthetic data … not live"). | none |
| **~3×** lower AI cost on a large course · "about $2 a semester vs $6.98 or more for a typical tool" | Modelled at 100k tokens of course material | `docs/semester-model.md` line 25: at an assumed 100k-token corpus "our cost stays where it was" and the typical tool costs "$6.98 with retrieval and caching" (up to $114 without caching). Ours: lines 11–12, $1.91–$2.24. Status line 42 gives the same range as "$7-114 … ours stays ~$2". | Conservative: the typical tool's lowest figure over our highest: 6.98 / 2.24 = 3.1 → "~3×". |

Deliberately **not** shown:
- "Up to N×" for cost. The brief suggested "up to 3.5×", but 3.5× is a *minimum* (low end of the typical tool's range), and "up to" would suggest a maximum. The frame says "~3×" (6.98 / 2.24) instead. The model's own line 22 also says that on a *small* course a caching-aware typical tool costs slightly less than we do, so the claim is scoped to large courses.
- Course summary 2.7 s → 68 ms and first sync 126 s → 30 s: real (status lines 20 and 36), but not in the final script.
- Any NotebookLM speed comparison: no timed recording exists. The optional insert at 1:19 stays empty until the operator records `assets/notebooklm-race.mp4`.

Where these numbers come from: branches `fix/sync-events` and `bench/semester-model` are pushed but **not merged** to `main` (status table "Wave 2 branches"). The status doc on `main` records them.

## Claims in the voiceover and labels, and what backs them

| Claim | Backing | Caveat for the team |
|---|---|---|
| "It finds the AI you already use, Claude Code or Codex" | Status line 19 (client detection, live on Windows) and the real "Choose your AI" screen | The preview's cards are sample data (labelled so in the app) |
| "The AI gets no tools" | Status line 19: tool-use tripwire, Codex tools off | |
| "Read-only: never submits or posts" | AGENTS.md boundary; the app's own agreement screen (captured) | |
| "Every quote checked by code" | Spec §2 (quotes, IDs and dates checked by code); quiz items carry a checked quote | Status line 50: answer *sentences* aren't yet bound to their cited quotes (`core/intent/ask.ts`). The p2 line "every answer is checked" goes further than today's code. |
| "your data stays on your laptop" (Ben, s8) | The database is local | The student's AI receives consented excerpts, and Jev receives typed judgments. The frame says "Your course database stays on your laptop · Your AI sees only the excerpts you allow" to stay exact. Suggest changing the VO wording (see SCRIPT.md). |
| Outlook as a read-only source (p11) | Built connector (`connectors/graph.ts`) | Status line 47: Outlook has never run live |
| "any MCP-compatible harness" (p1) | `packages/core/src/mcp.ts`, `mcp-server.cjs`: optional, read-only course bank, per-course and per-category grants | The frame says exactly that under the ring |
| "Exam 2 moved to Friday" notice (s04) | Synthetic announcement imported by `capture/capture.ts`; announcement capture is on `fix/sync-events` (status line 36) | The notice card and the change note are **stand-ins** (labelled in frame) |

## Real UI and stand-ins

Real UI comes from `capture/capture.ts`, headless, from the app's own preview server with synthetic data only. Capture source for this preview: `origin/feat/study-prepper` at `987f76a`, which includes the Windows preview fix from `feat/floating-chat` (`4f0f995`). `assets/ui/manifest.json` records the commit and every shot.

| Shot | Real or stand-in |
|---|---|
| Agreement, Choose your AI, Home, Upcoming, item space, course page, study space, calendar | Real screens, synthetic courses |
| Practice quiz Q6, correct feedback, results, flashcard | Real components (with KaTeX). The questions and cards are synthetic items fed to the component at capture, because the preview has no model |
| UW sign-in (s02) | Stand-in, labelled: the preview has no live sign-in |
| Exam 2 notice and change note (s04) | Stand-in, labelled |
| Course Analytics (s07) | Stand-in with synthetic figures, labelled; `feat/course-analytics` isn't pushed yet |
| "Making 10 questions" progress (s06) | Motion graphic, labelled "Sped up for the film" |
| Canvas stream (s03), guard (s08), proof (s09), agent ring and tiers (p10, p11), end card (p12) | Motion graphics |

## Assets and licences

| Asset | Source | Licence |
|---|---|---|
| Wizard mark (Whiz) | `marketing/logo-design-elements/svg/` v0.2 (team pack) | Team asset (repo MIT) |
| Canvas glyph `assets/canvas-mark.svg` | Drawn for this film: a neutral source glyph, **not** Instructure's logo. The word "Canvas" is set in our type. End card: "Canvas is a trademark of Instructure". Swap the file for an approved mark if one is supplied. | Ours |
| Geist Variable font | Copied from the app's own build (`apps/desktop/dist/renderer/assets/Geist-Variable-*.woff2`) | SIL Open Font License 1.1 (Vercel) |
| GSAP 3.15.0 | npm `gsap` | GSAP Standard "no charge" license |
| SFX: sparkle, whoosh, whoosh-cinematic, whoosh-short, pop, notification, click-soft, key-press, chime, riser, impact-bass-1, glitch-1, ping | HyperFrames `media-use` bundled library, copied by `tools/audio.mjs` from `~/.claude/skills/media-use/audio/assets/sfx/` (its CREDITS.md) | Pixabay Content License (free commercial use, no attribution required). Not committed; the script copies them locally |
| Music bed (TEMP) | Synthesized by `tools/audio.mjs` (ffmpeg `aevalsrc`, 120 BPM, Am–F–C–G) | Ours; no third-party audio |
| Guide voice (TEMP) | Kokoro-82M through `hyperframes tts`, run locally (voices am_michael, am_adam, bm_george) | Apache-2.0 model weights; local, no cost. To be replaced by Ben's recording |
| Skit and presenter footage | Filmed by the team (slots) | Team |
