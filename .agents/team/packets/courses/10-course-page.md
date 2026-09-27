# Courses handoff: course page (frame for the notebook)

Updated: September 26, 2026, about 23:30 CT. Human owner: Ben. Agent: Claude Code (Opus 5.5). Branch: `feat/course-page`, based on Nathaniel's `origin/course-backend-integration` at `f850ea7` (not on main). Status: **in progress** — implemented and typechecked; tests, rendered-journey check and private live-data measurement still running. Recipients: Nathaniel (notebook/T43 owner), Sean (Today rail shares `App.tsx`), everyone recording the video.

## What and why

Replaces the one-line Courses stub with **one card per course → a course page**, built from saved evidence only (no model call, no new network or hosted data path, instant first paint). Chosen with Ben as the next feature because the course-intelligence backend was integrated with no screen, and the video's CS-vs-Econ beat needs something beyond a coursework list. Ben's decision (September 26): **"frame his fills later"** — this page is the frame that Nathaniel's notebook (plan D14, "the notebook is the course page") fills later, not a competing design.

## The page

- **Header:** course name, code, term, honest freshness from the course-intelligence view ("Checked …", "Partly checked", "May be out of date").
- **How this course works:** AI use, Grading, Exams & assessments (Topics only when found). Each fact shows its exact source passage on demand. Missing stays missing: "No AI policy found in captured sources. That isn't permission — check with your instructor." Canvas group weights are shown "as listed in Canvas", never as a grade formula or prediction. Syllabus line says whether it came from the Canvas syllabus, a syllabus *file* (linked, not yet read for facts), or nothing.
- **Coursework:** grouped by assignment group with listed weight, upcoming first; past/finished collapsed. Items open the **same** `ResourceDetail` used on Home.
- **Materials:** by Canvas module in order, else a flat list. **This section is the notebook's slot** — T43's Sources/Notes/Studio replace it for the same course key.
- Back returns to the Courses overview with focus on the originating card.

## Interfaces others will touch (all additive)

- `@magic/domain` (new file `packages/domain/src/course-page.ts`): `courseKey(accountScope, courseId)`, `buildCoursePage(input, key)`, `buildCourseCards(input)`, `whenDue`, `isDone`. Pure; renderer imports it by relative path. Course identity is `accountScope:courseId` so same-named courses stay apart.
- `@magic/contracts`: `moduleItemSchema.moduleId` (optional). `packages/connectors/src/canvas-models.ts` `itemResource(..., moduleId?)` now keeps the module id Canvas already returns (it was dropped), so items can be grouped by module. Data saved before this change falls back to a flat list.
- Renderer: new `apps/desktop/src/renderer/courses/**` (`CoursePage.tsx`, `courses.css`). `App.tsx`: the `courses` view branch plus two state hooks (`courseKey`, `courseItemId`) and one focus effect. Does **not** touch `renderer/notebook/**` (T43) or the Today rail.

## Findings the team should know

- On the in-app sample course the compiler yields no course-level facts (1 assignment-scoped grading and 1 assignment-scoped policy claim, 7 unknowns); the synthetic university's syllabus is a placeholder. Literal extraction only reads the **Canvas syllabus body** under headings like "Grading:"; syllabus **PDFs are not treated as syllabi**. Nathaniel's D34 ("syllabus is found by code") should own that fix; the page already detects and links a syllabus file.
- Real-course coverage is being measured now with Ben's explicitly authorized, headless, private Canvas session through Nathaniel's ingestion (`createIngestion` → schema v7). Only aggregate counts will be shared; private data stays out of Git.

## Next action

Finish tests + headless rendered journey (Courses → course → item → Back; empty, stale, excluded, no-syllabus states), record live not-found rates here, push `feat/course-page`. **Nathaniel:** confirm the Materials slot + `courseKey` identity work for T43, and whether syllabus-file detection belongs in your D34 pass.
