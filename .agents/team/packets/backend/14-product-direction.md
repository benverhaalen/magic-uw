# Product direction from Nathaniel's hands-on run (September 27)

Human owner: Nathaniel. Agent: Claude Code lead. September 27, 2026. Base: main after the September 27 backend integration (see packet 13). Status: direction recorded; the backend lane is building the pieces marked "ours"; the frontend pieces are proposed for Ben to shape or accept.

Why you're receiving this: Nathaniel ran the app from a fresh profile and set the direction below. Much of it touches the shell, Home and Courses, which you own and are actively building (Daily Brief, Hugeicons, Courses refinements on `codex/desktop-design-integration`). We'll pull your branch and build on your structure. This packet says where he's going, so we don't build two versions.

## Nathaniel's words (verbatim excerpts, September 27)
- "the briefing needs a consistent way where text won't get truncated or wrap, fix responsiveness of the app ui/ux."
- "Workspace tools … shouldn't be like this, fix it to actually make sense for the system now … Daily agenda powers the home's today page, have every course have a specific analytics tab, upcoming assessments, assignments, notes, outlook, coursefacts should be in notes."
- "Every separate assessment has buttons to generate study cards, for all or select filtered assignments."
- "Fix the ui/ux to not stall out … the issue is all of the saved courses that are irrelevant from canvas over scraping. The whole point … is really just getting that course schedule of the student and understanding what their courses are this semester."
- "The magic feature I need is study prepper, where every assessment will have study materials … generate study guides and quizzes and flashcards … Ensure it can do latex equations."
- "This needs a more codex like intuitive ui/ux. Like flashcards as an icon button, section, but not so much text. Very polished paid-for academic AI tool."

- "for actual canvas content, like a post's writing, it should have the actual detailed message."
  - Canvas content (announcements, discussion posts, pages, assignment descriptions) shows in full and formatted: sanitized HTML with headings, lists, links, images and maths, not a one-line gist.
  - The stored resource already keeps the full `message` body and `rawHtml`, so this is a rendering change.
  - Gists stay only for Outlook mail and campus news, where the privacy rule is "gist and link".

- "course announcements gets a special section, we don't want anything from canvas missing, just better delivered and agentically connected."
  - **Announcements get their own section:** Course › Announcements, plus the newest ones on Home. Each shows in full.
  - **Agentically connected:** an announcement that names an assignment, exam, date, room or file is linked to it by code (the reference graph and change events). "Exam 2 moves to Friday" updates the agenda, the assessment and Study prep, and shows "changed by announcement" with the quote. Jev or the student's AI only judges importance and what kind of message it is (the existing notification triage), never the dates.
  - **Nothing from Canvas missing:** discussion replies (the thread, via one `view` request per topic), the Canvas Inbox (conversations, read without marking anything as read), and a coverage check per Canvas content type, so gaps show instead of silently missing.

- "Ensure the floating chat pill is just like Ben originally designed."
  - **Your `ConversationLauncher` is the app's chat launcher.** Our wizard floating chat is now off by default and isn't mounted unless a student turns it on in Data & AI.
  - **Voice arrives as a module for your launcher's `mic` glyph:** `renderer/voice/useLocalDictation` (local Whisper, one-time consented download).
  - **Shortcuts:** Ctrl/Cmd+K opens the chat; Ctrl/Cmd+Shift+Space opens it and dictates.
  - **The account avatar uses your wizard-head image,** the same `head-color.svg` code as your commit 6958419, with a hover or focus account card.

## The information architecture this implies
| Place | Contents | Powered by |
|---|---|---|
| Home › Today | the daily agenda (critical-action order) and the brief | `agenda` / critical-agenda (#27); the Daily Brief is yours |
| Course › Overview | the next assessment, the next due item, mastery at a glance | agenda, mastery |
| Course › Assessments | each upcoming exam/quiz with **Study prep** | exam blueprint, guide/quiz/cards packs |
| Course › Assignments | the course's work, filterable; select several to prep from | page views, agenda |
| Course › Announcements | every announcement in full, newest first; each linked to what it changes or mentions | Canvas announcements, reference graph, change events, notification triage |
| Course › Notes | the student's notes **plus course facts** (syllabus facts, brief) | notes, course facts (#45) |
| Course › Mail | this course's Outlook messages, opening the full message | Outlook/Graph (not live yet) |
| Course › Analytics | practice → assignment → course rollup, mastery, grade trajectory | analytics, mastery, grades |
| Settings › Data & AI | who answers (Claude Code / Codex / local / off), when to ask before sharing | client health, privacy |

**Workspace tools** (the developer preview tabs from #30) dissolves into these places and stays only behind a developer flag.

## What the backend lane builds now (ours)
- **Study prepper**, a self-contained component `renderer/study-prep/`: `<StudyPrep courseId assessmentId />`. Icon buttons for Guide, Quiz and Cards; scope = all, or the selected assignments/modules/topics; generation through the existing packs (grounded, quotes checked, cached by content hash); LaTeX rendered with KaTeX; minimal text. It mounts wherever your Assessments view puts it.
- **Current courses from the student's enrollment first** (Course Search & Enroll), so irrelevant Canvas sites are never read. This is the fix for the stalls.
- **Course-scoped data queries** each tab needs (analytics, assessments, assignments, notes + facts, mail), so the views only render.

## How we build the frontend part: on your structure
Nathaniel asked us to fix it now, so the backend lane builds the course tabs, dissolves Workspace tools and applies the briefing and responsiveness rules **on top of your latest `codex/desktop-design-integration`**. Your branch is merged into ours, and your shell, Home, Daily Brief, Courses view, Hugeicons and motion win wherever the two meet. Where we'd change something of yours, the PR lists it with the reason. Please review that PR. If you're mid-change in the same files, tell Nathaniel and we'll hold those files for you.

- Briefing typography: one consistent rule for line length, wrapping and truncation (no clipped key text; titles clamp at 2 lines with the full text on hover or focus); responsive breakpoints for narrow windows.
- The "Codex-like" density: icon buttons with tooltips (your Hugeicons), sections over prose.
