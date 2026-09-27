---
title: My Magic UW, submission film
format: 1920x1080, 30 fps
duration: 120
music: TEMP synthesized bed, 120 BPM (every whole-second cut lands on a beat); ducked under the voice
status: preview (draft render). Final render waits for the operator's review.
---

# Storyboard

Structure set by the operator on September 27 (skit → showcase → presenters). Lines are in [SCRIPT.md](SCRIPT.md); every number and asset is traced in [SOURCES.md](SOURCES.md).

Rules applied (from the operator's research brief): the product is named in the first 5 s of the showcase, and real UI appears within 5 s of it; one idea per scene, changing every 3–9 s; UI is isolated in floating panels with fast expo-out punch-ins, and the background blurs when a dialog opens; the middle of each workflow is jump-cut or sped up (labelled); success toasts pay off; one typeface (Geist) in two weights, large, with expo.out entrances; the end card is plain and held.

Key-frame snapshots: `snapshots/frame-NN-at-<t>s.png` and `snapshots/contact-sheet-1..3.jpg` (local, git-ignored; regenerate with the snapshot command below).

| Beat | Time | Shot | Source asset | Animation | Line (who) | Key frame |
|---|---|---|---|---|---|---|
| Skit (slot) | 0:00–0:20 | Sean's dorm desk, tabs, phone buzz, Nathaniel's "Just ask Whiz" | `assets/skit.mp4` (placeholder card until filmed) | Live footage; ends on the laptop screen for the match cut | Ben VO, Sean, Nathaniel | 10 s |
| s01 Whiz | 0:20–0:23 | Laptop screen punches in to full frame; Whiz pops in, waves, sparkles; "My Magic UW / Your classes, in one place." | Wizard SVG inline (arms animated); app shell gradient | Screen scale 0.42→1 (expo.out, 0.6 s), Whiz back.out, 8-point sparkle burst, title rise | Ben | 21.8 s |
| s02 Onboarding | 0:23–0:29 | Agreement checkbox ticks; UW sign-in card; punch in on Choose your AI; chips tick in: "Claude Code found · connected", "Codex found"; hook "Works with the AI you already have." | **Real:** `onboard-agreement.png`, `onboard-choose-ai.png`. **Stand-in:** UW sign-in card (labelled) | Panels punch in (expo.out), slow push-in on the cards, chips back.out | Ben | 24.5 s, 27.9 s |
| s03 The spell | 0:29–0:38 | Canvas source mark on the left streams assignments, files, pages and an announcement along arcs into the app window; Whiz casts; snap-back; sparkle wipe to full Home | **Real:** `home.png`. Neutral `canvas-mark.svg`; item titles from the synthetic courses | Staggered arcs (x power2.in, y sine), suck-in scale 0.15; window back.out(4) snap; gold wipe with clip-path reveal | Ben | 32 s, 36.7 s |
| s04 Home | 0:38–0:46 | Full Home falls away; the ranked Upcoming rows cascade; hook "Your day, ranked."; the Exam 2 notice drops in with the professor's words; change note | **Real:** `home.png`, `panel-upcoming.png`. **Stand-in:** notice card and change note (labelled; synthetic announcement) | Row strips cascade (expo.out, 0.16 s stagger); notice back.out drop with ding | Ben | 40.2 s, 44.9 s |
| s05 Item space | 0:46–0:53 | Assignment panel; gold evidence lines draw to three cards: linked lecture, syllabus rule (quoted), real due date; background dims | **Real:** `item-space.png` (its Start work list shows the lecture and syllabus links code found) | Stroke-dashoffset draws with key ticks, cards expo.out, panel blur | Ben | 50.8 s |
| s06 Practice quiz | 0:53–1:02 | Course page with the Study prep row ringed; dialog opens over a blurred page; "Practice quiz" pulses; sped-up "Making 10 questions" bar; jump-cut to "Question 6 of 10" with LaTeX; cursor picks the answer; correct feedback, chime, toast; results | **Real:** `course-page.png`, `study-space.png`, `panel-quiz-q6.png`, `panel-quiz-right.png`, `panel-quiz-results.png` (real quiz component with synthetic questions; see SOURCES) | Blur-in dialog, progress sweep (labelled "Sped up for the film"), hard cut, toast back.out | Ben | 55.3 s, 57.8 s, 59.4 s, 61.6 s |
| s07 Analytics | 1:02–1:11 | Score trend line draws, homework bars fill, per-topic readiness bars fill, "What to do next" cards; "Review 3 flashcards" opens a real flashcard that flips | **Stand-in:** analytics panel (labelled, synthetic figures). **Real:** `cards-front.png`, `cards-back.png` | Line draw, bar scaleY/scaleX staggers, 3D rotateY flip with swoosh | Ben | 65.4 s, 69.2 s |
| s08 Guard | 1:11–1:19 | Whiz with a shield at the course page; three pieces of untrusted page text fly in and bounce off; labels: "The AI gets no tools", "Read-only: never submits or posts", "Every quote checked by code"; lock settles over a laptop | **Real:** `course-page.png` (the gate); wizard mark | Hits: flash, shield shake, bounce-off rotation; labels expo.out; shackle snap | Ben | 76.8 s |
| s09 Proof | 1:19–1:30 | Card flips through 24× faster to reopen, 35× fewer requests, 55% need no AI call, ~3× lower AI cost on a large course, each with its label | Numbers per SOURCES.md | rotateY flips on the beat (3.0, 5.6, 8.3 s) | Ben | 81.2 s, 89.2 s |
| Presenters (slot) | 1:30–2:00 | Nathaniel and Sean on camera, left 55% | `assets/presenters.mp4` (placeholder card until filmed) | Live footage | Nathaniel, Sean | |
| p10 Layer | 1:30–1:42 | Glowing ring "My Magic UW layer"; chips Claude Code, Codex, Any MCP client snap on as named | Motion graphic over the right 45% (scrim) | Ring stroke draw and glow; chips back.out(3) | Nathaniel | 96 s, 101 s |
| p11 Tiers | 1:42–1:52 | Code first → Jev → Your AI, one checked call; read-only lines to Canvas, Enrollment, Outlook, Notes; lock: "Stays local · What it sees is what you allow." | Motion graphic | Tier cascade, line draws, shackle snap | Sean | 106.5 s, 110.8 s |
| p12 End card | 1:52–2:00 | Whiz, My Magic UW, Open source · MIT, github.com/benverhaalen/magic-uw, Not affiliated with UW–Madison, Canvas is a trademark of Instructure | Wizard mark | Slides in, holds 7 s | Nathaniel | 116 s |

## Sound

Voice: `assets/narration.wav` (Ben; TEMP Kokoro guide in the preview) and `assets/dialogue-guide.wav` (TEMP read of the on-camera lines; set its `data-volume` to 0 or delete it once the skit and presenter footage carry the real voices). Music: `assets/music-bed.wav`, ducked with a sidechain compressor against both voice tracks by `tools/audio.mjs`. SFX (Pixabay-licensed bundle): sparkle (Whiz, end card), whoosh-cinematic and whoosh (stream and suction), pop (snap-back, chips), notification (notice), key-press ticks (evidence lines), riser (sped-up generate), chime (correct), whoosh-short (chart swooshes, card flips, proof flips), impact-bass and glitch (shield), click-soft (onboarding ticks, locks). All SFX sit at 0.25–0.5 volume under the voice.

## Slots and how to fill them

| Slot | File | Now | To fill |
|---|---|---|---|
| Skit | `assets/skit.mp4` (20 s) | Generated placeholder card | Drop in the take, delete `skit.mp4.PLACEHOLDER` |
| Presenters | `assets/presenters.mp4` (30 s) | Generated placeholder card | Same; keep the right 45% of frame clear |
| Narration | `assets/narration.wav` (120 s, Ben's lines at their script times) | TEMP Kokoro guide | Replace the file, delete `narration.wav.TEMP`, run `node tools/audio.mjs` to re-duck the music |
| Music | `assets/music-bed.src.wav` | TEMP synthesized bed | Replace with a chosen, licensed track; re-run `node tools/audio.mjs` |
| NotebookLM insert (optional) | `assets/notebooklm-race.mp4` | Not used | Only with a real timed recording |
| Race alternate (optional) | not built | | The race footage isn't in this cut (the skit replaced it) |

## Stand-ins to re-capture

Re-run `capture/capture.ts` against the merged app. The Course Analytics stand-in (s07) is replaced by hand when its screen lands. The UW sign-in and the Exam 2 notice stay stand-ins until the app has a headless-renderable equivalent.

## Commands

```bash
cd video/film
npm install                                   # playwright, gsap, tsx (own lockfile; not in the pnpm workspace)
npx playwright install chromium-headless-shell

# 1. Re-shoot every UI shot (headless; starts its own preview server with synthetic data)
MAGIC_APP_DIR=<path to the merged app checkout> npx tsx capture/capture.ts --build

# 2. Placeholders, SFX, music ducking, captions (add --temp-vo for the local Kokoro guide voice;
#    needs HYPERFRAMES_PYTHON pointing at a python with kokoro-onnx and soundfile)
node tools/audio.mjs

# 3. Check, snapshot, render (telemetry off; nothing leaves the machine)
export HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1
npx hyperframes@0.8.79 lint && npx hyperframes@0.8.79 check
npx hyperframes@0.8.79 snapshot --describe false --no-end --at 10,21.8,24.5,27.9,32,36.7,40.2,44.9,50.8,55.3,57.8,59.4,61.6,65.4,69.2,76.8,81.2,89.2,96,101,106.5,110.8,116
npx hyperframes@0.8.79 render --quality draft --workers 4 -o out/preview.mp4
npx hyperframes@0.8.79 render --quality high -o out/final.mp4      # after the operator's review
```

Never run `hyperframes publish` or a cloud render for this project.
