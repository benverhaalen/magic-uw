# Filming script: the live-action sections

Everything here is shot by the team. The app, Whiz and every graphic are added afterwards, so film against real laptops but don't worry about what's on their screens unless a shot says so. Timings match `PRODUCTION-SCRIPT.md`.

**Cast:** Sean (the average student) · Nathaniel (the My Magic UW student, then presenter) · Ben (voiceover only, recorded separately).

## General setup
- **Camera:** landscape, 1080p or 4K, 30 fps (or 24 fps for all shots, never mixed). A phone on a tripod is fine. Lock exposure and focus.
- **Light:** one soft light from the side of the face that's toward the window, plus room light. Avoid overhead-only light.
- **Sound:** record every spoken line with a lav or the phone held just out of frame, in a quiet room. Clap once at the start of each take for sync.
- **Screens:** set each laptop to about 60% brightness so it doesn't blow out. We replace the screen content in the edit where noted.
- **Wardrobe:** Sean in something rumpled (hoodie); Nathaniel neat but casual. Avoid logos and tiny stripes.
- **Takes:** 3 good takes of every line. Leave 2 seconds of silence before and after each.

## Shot 1: the split screen (0:03–0:16, about 13 s used)
Two separate shots, combined side by side in the edit. Film both from the **same height and distance**, each person roughly centred, desk in the lower third.

**1A, Sean (left half):** late-night dorm desk, messy: energy drink, notebook, phone face-down.
- Laptop with lots of tabs open (real Canvas tabs are fine; we blur them).
- Action: he clicks between tabs, scrolls, squints, rubs his eyes.
- **Line, looking at the screen:** "Syllabus says the lab's due Thursday… calendar says Friday?"
- Then: the phone buzzes. He flips it over, reads it, and **freezes** for one full second, staring at the camera or into space.
  - Phone screen doesn't matter; we overlay "Exam 2 moved to tomorrow".

**1B, Nathaniel (right half):** the same desk or a tidy one, calm, a coffee.
- Laptop open, facing slightly toward camera.
- Action: he glances at the laptop, relaxed, maybe a small sip. No lines in this shot.

Ben's voiceover runs over this: *"This is Sean. Typical UW–Madison student. Five classes, five Canvas courses, one inbox he's afraid of."*

## Shot 2: the mic click (0:16–0:22, about 6 s)
**Nathaniel, over-the-shoulder or a 3/4 angle** showing his face and the laptop screen.
- Action: he clicks the app's mic button (or presses Ctrl+Shift+Space), then speaks naturally toward the laptop.
- **Line:** "Can you show me what I have to get through today?"
- Hold on his face for 1 second after the line; the edit then pushes into the screen, where Whiz pops in.
- Tip: if the screen is visible, have My Magic UW open on the Home page. We may replace it with the clean capture anyway.

## Shot 3: Sean's goof (0:50–0:56, about 6 s)
**Sean, same setup as 1A,** a little more chaotic.
- Action: frantically digging for his reference sheet: under the laptop, in a backpack, flipping notebook pages, finds a crumpled paper, unfolds it, and it's the wrong one (a takeout menu or a blank page). He looks up at the camera, defeated.
- No lines. A comedy sting sound is added in the edit.
- Optional variant: he holds up the wrong sheet to the camera with a flat stare.

## Shot 4: the presenter (1:30–2:00, 30 s)
**Nathaniel, medium close-up (chest up), framed on the LEFT third.** Leave the right 45% of the frame empty: a plain wall or soft background, no clutter, since the diagrams and Whiz go there.
- Look into the lens. Speak at a relaxed pace, about 130 words a minute.
- **Lines** (one take per line is fine; we cut between them):
  1. (1:30–1:38) "Under it is an agentic infrastructure we built. Your own AI drives our system: code does the exact work, and the AI only reads what needs reading."
  2. (1:38–1:44) "It coaches, but never does your graded work, and your course data lives on your laptop."
  3. (1:44–1:52) "And it's cheap to run."
     - Pause a beat after it; the spend numbers animate in beside you.
  4. (1:52–1:57) "It's open source: plug your agent in and build faster on our infrastructure."
     - Optional small gesture toward the right side as if presenting it.
- The last 3 seconds are the end card; no line needed.

## Ben's voiceover (recorded separately, about 130 words)
Record in a quiet room, close to the mic, warm and upbeat. Each line is a separate take so the edit can place it.

| Time | Line |
|---|---|
| 0:03 | "This is Sean. Typical UW–Madison student. Five classes, five Canvas courses, one inbox he's afraid of." |
| 0:30 | "His day, already ranked: the advisor email that matters, the lecture in an hour, the assignment due next." |
| 0:40 | "One click, and everything it needs is there, with sources he can check." |
| 0:56 | "Flashcards and practice tests from his own course materials, made in, well, a whiz." |
| 1:06 | "Every deadline from syllabus week to the final, in one place." |
| 1:14 | "Analytics from his real grades, and exactly what to study next." |
| 1:22 | "Plan the GPA he's aiming for; his notes land in OneDrive on their own." |
| 1:57 | "Built by Badgers, for Badgers." |

## Delivering the files
Drop the clips into `video/film/assets/` with these names (any common format; we convert):
- `skit-sean.mp4` (1A), `skit-nathaniel.mp4` (1B), `mic.mp4` (2), `goof.mp4` (3), `presenter.mp4` (4)
- `vo-ben.wav` (or one file per line: `vo-01.wav` … `vo-08.wav`)

The edit replaces each placeholder by file name, so a re-render picks everything up.
