# 16 — Backend handoff: what's on main, what's pushed, what's still moving

From: backend lane (Nathaniel's session) · To: Ben (frontend owner) and the team · 2026-09-27

Pull `main`, then quit and restart `pnpm dev` (a running app never picks up pulled code). Measurements and known-broken items are in `docs/status-2026-09-27.md`; this packet is the branch map.

## On main
- **Wave 1 (PR #51, `aa1ff450`):** current courses only, enrollment-first onboarding, client detection, course mastery, repeat-work sweep, Remember my sign-in, privacy, agenda, course facts, page views, exam prep, site sorting, non-blocking jobs.

## Merging now
- **Wave 2 (PR #53, `integrate/wave2-0927`):** sync speed (relaunch 283 → 8 requests, 70 s → 2.9 s), file downloads (Electron's `session.fetch` rejected every redirect, so 386 of 386 Canvas files failed; now fixed at every session read), AI efficiency (cacheable chat prefix, count respected, command-bar gaps), GPA calculator, notes to OneDrive/Drive folder, tab speed (learning views ~4.7 s → ~0.28 s).

## Pushed, not merged (pull these branches to review or build on)
| Branch | What | State |
|---|---|---|
| `feat/study-prepper` | One catered study space per agenda item (exam, quiz, problem set, essay, lab, project, discussion, reading, participation): "What you need" plus type-specific actions (Study guide / Cards / Test, and so on), LaTeX, practice exams from past exams | in progress; thin mount points listed in its commits |
| `feat/course-analytics` | Analytics tab per course: grade trend, homework completion, readiness per assessment, topic mastery, "what to do next"; hand-rolled SVG charts on tokens; full synthetic term in the sample course | in progress |
| `perf/stall-audit` | Harness measuring event-loop blocks, per-action round trips and statements, idle timers; fixes ranked by impact | in progress |
| `feat/floating-chat` | Our UI shell (dark mode, accents, wizard chat, avatar card, AI choices, reconfigure, plain source status, local voice module) | **not for main**: the ten items wait for item-by-item approval before any go onto your layout |

## The stall you'll feel most (being fixed on `perf/stall-audit`)
The renderer polls the **full workspace snapshot every 2 s**: 12.7 MB on real-shaped data, ~125 ms to build, copied twice across processes. The worker handles one message at a time, so any view request can wait ~200 ms behind it, even at idle; Home, Courses, My UW, Sources and Privacy all render from it. The fix replaces the poll with change-driven updates and per-page slices. Contract changes stay additive, and the renderer diff stays minimal so it lands cleanly on your pages.

## Contract additions you may meet
- `reply: "result"` (optional) on learning, notes and open-item commands: returns only the result, without the snapshot.
- `Store.inclusionInputs()`, `Store.resourceHistory`, `Store.generation`/`bumpGeneration` (all optional).
- Pack hand-off gains an optional `count` (clamped 1–30).

## Decisions still with you
From packet 13: Remember-my-sign-in versus the Duo rule (H2), and the top-bar chat button. From packet 14: the course page structure and item spaces on your layout.
