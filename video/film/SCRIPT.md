# Script: My Magic UW, 2:00

Structure set by the operator (September 27). Cast: **Sean** and **Nathaniel** in the skit; **Ben** narrates the showcase; **Nathaniel and Sean** present on camera for the last 30 s.
Captions are always on, burned in from `script.json` (the machine copy of this file). Edit a line there, then run `node tools/audio.mjs` to regenerate the captions (add `--temp-vo` to regenerate the TEMP guide voice).

Totals: 243 words. Ben's showcase narration: 139 words over 70 s (119 wpm, inside the 120–140 wpm target).

## 0:00–0:20 Skit (DRAFT, for the team to rewrite). Live footage: `assets/skit.mp4`

All synthetic: no real courses, grades or inboxes on screen. Use the synthetic courses (Writing 101 · Sample, Algorithms 301 · Sample) or blank placeholder tabs.

| Time | Shot | Line |
|---|---|---|
| 0:00 | Dorm desk, 11:48 pm, Sean at his laptop | **Ben (VO):** "This is Sean. Typical UW–Madison student. Five classes, five Canvas courses, one inbox he's afraid of." |
| 0:05 | Screen: 14 tabs; clicking Modules → Files → Announcements | **Sean (0:07):** "Syllabus says the lab's due Thursday… calendar says Friday?" |
| 0:11 | Phone buzz: "Exam 2 moved to tomorrow." Sean freezes. One silent beat | *(caption: [Phone buzzes: "Exam 2 moved to tomorrow."])* |
| 0:15 | Nathaniel leans into frame | **Nathaniel:** "Dude. Just ask Whiz." Sean clicks: **match cut** into the laptop screen, which punches in to the app (s01) |

Timing note from the TEMP read: Ben's opening line is 16 words and needs about 6.5 s at a natural pace, not 5 s. Sean's line is therefore timed at 0:07 (still inside shot 2). Either trim the VO (for example, drop "one inbox he's afraid of") or hold shot 1 to 0:07.

## 0:20–1:30 Showcase: Ben's voiceover (`assets/narration.wav`, timed from 0:00 of the film)

| Time | Scene (composition) | Ben |
|---|---|---|
| 0:20–0:23 | Whiz sparkles in (`s01-whiz`) | "Meet My Magic UW." |
| 0:23–0:29 | Onboarding auto-config (`s02-onboard`) | "One UW sign-in. It finds the AI you already use, Claude Code or Codex, and sets itself up." |
| 0:29–0:38 | The spell: Canvas stream, snap-back, sparkle wipe (`s03-spell`) | "Then Whiz pulls in every assignment, file and announcement from the courses you're actually taking." |
| 0:38–0:46 | Home agenda, then the "Exam 2 moved" notice (`s04-home`) | "Your day, ranked. And when an exam moves, you see it, in your professor's own words." |
| 0:46–0:53 | Item space, evidence lines (`s05-item`) | "Open anything, and it's already connected: the lecture, the syllabus rule, the real due date." |
| 0:53–1:02 | Practice quiz, cut to Q6 with LaTeX, correct chime (`s06-quiz`) | "One click builds a practice quiz from your own materials, and every answer points back to its source." |
| 1:02–1:11 | Analytics charts, then a flashcard flip (`s07-analytics`) | "See where you stand, and exactly what to study next." |
| 1:11–1:19 | Whiz the guard, malicious text bouncing off, lock (`s08-guard`) | "Whiz guards the gate. The AI gets no tools, never submits or posts, and your data stays on your laptop." |
| 1:19–1:30 | Proof flip, measured numbers (`s09-proof`) | "Reopening is 24 times faster with 35 times fewer requests, and more than half of what you do needs no AI at all." |

Timing notes: 0:23–0:29 is tight (18 words in 6 s; the TEMP read needed 6.0 s at 1.3× speed). At 1:11 the phrase "your data stays on your laptop" is broader than the product: the database is local, but the student's AI receives the excerpts they allow. The frame reads "Your course database stays on your laptop · Your AI sees only the excerpts you allow". **Suggested VO:** "…never submits or posts, and your course data lives on your laptop." (Operator's call.)

## 1:30–2:00 Presenters on camera (`assets/presenters.mp4`, keep the right 45% of frame clear)

| Time | Line | Overlay (right 45%) |
|---|---|---|
| 1:30 | **Nathaniel:** "We didn't just build an app. My Magic UW is an open-source layer that wraps around the agent you already run: Claude Code, Codex, or any MCP-compatible harness." | Chips (Claude Code, Codex, Any MCP client) snap onto a glowing ring, "My Magic UW layer"; note: "MCP: an optional, read-only course bank with per-course grants" (`p10-layer`) |
| 1:42 | **Sean:** "Your agent drives our infrastructure. Code does the exact work, AI reads only what needs reading, and every answer is checked. What it sees is what you allow." | Tiers: Code first → Jev → Your AI, one checked call; read-only lines to Canvas, Enrollment, Outlook, Notes; lock over a laptop: "Stays local" (`p11-tiers`) |
| 1:52 | **Nathaniel:** "Open source, for every Badger. Plug your agent into your academic life." | End card, held to 2:00: Whiz, My Magic UW, Open source · MIT, github.com/benverhaalen/magic-uw, Not affiliated with UW–Madison, Canvas is a trademark of Instructure (`p12-end`) |

Accuracy notes for the presenters: "every answer is checked" goes beyond today's code (answer sentences aren't yet bound to their cited quotes; status doc line 50). Consider "every quote is checked". Outlook has not run live yet (status line 47).

## Open

- The DoIT ask: Ben's wording is still pending and has no slot in the final structure. If it returns, the end card (`p12-end`) takes one more line.
- The optional NotebookLM insert at 1:19, if the operator records `assets/notebooklm-race.mp4`.
