# Courses handoff: course page (frame for the notebook)

Updated: September 26, 2026, about 23:55 CT. Human owner: Ben. Agent: Claude Code (Opus 5.5). Branch: **`feat/course-page` (pushed, one commit on top of main `abe8b3a`, not merged)**. Status: **built, tested, and demonstrated on Ben's real Canvas data in the headless desktop app**; not merged into main. Recipients: Nathaniel (notebook/T43 owner), Sean (Today rail shares `App.tsx`), everyone recording the video.

## What and why

Replaces the one-line Courses stub with **one card per course → a course page**, built from saved evidence only (no model call, no new network or hosted data path, instant first paint). Chosen with Ben as the next feature because the course-intelligence backend was integrated with no screen, and the video's CS-vs-Econ beat needs something beyond a coursework list. Ben's decision (September 26): **"frame his fills later"** — this page is the frame that Nathaniel's notebook (plan D14, "the notebook is the course page") fills later, not a competing design.

## The page

- **Header:** course name, code, term, honest freshness from the course's own Canvas sources ("Checked …", "Partly checked", "May be out of date"). See the finding below on why this doesn't use the compiled view's freshness.
- **How this course works:** AI use, Grading, Exams & assessments (Topics only when found). Each fact shows its exact source passage on demand. Missing stays missing: "No AI policy found in captured sources. That isn't permission — check with your instructor." Canvas group weights are shown "as listed in Canvas", never as a grade formula or prediction. Syllabus line says whether it came from the Canvas syllabus, a syllabus *file* (linked, not yet read for facts), or nothing.
- **Coursework:** grouped by assignment group with listed weight, upcoming first; past/finished collapsed. Items open the **same** `ResourceDetail` used on Home.
- **Materials:** by Canvas module in order, else a flat list. **This section is the notebook's slot** — T43's Sources/Notes/Studio replace it for the same course key.
- Back returns to the Courses overview with focus on the originating card.

## Interfaces others will touch (all additive)

- `@magic/domain` (new file `packages/domain/src/course-page.ts`): `courseKey(accountScope, courseId)`, `buildCoursePage(input, key)`, `buildCourseCards(input)`, `whenDue`, `isDone`. Pure; renderer imports it by relative path. Course identity is `accountScope:courseId` so same-named courses stay apart.
- `@magic/contracts`: `moduleItemSchema.moduleId` (optional). `packages/connectors/src/canvas-models.ts` `itemResource(..., moduleId?)` now keeps the module id Canvas already returns (it was dropped), so items can be grouped by module. Data saved before this change falls back to a flat list. **Nathaniel:** rebased onto your T17 connector; the only change there is passing `module.id` at the single `itemResource` call in the inline/fallback module-items path.
- `@magic/core` `snapshot()`: resource views sent to the renderer **drop `rawHtml` and `parts`** (the detail pane doesn't use them). On Ben's real account the snapshot was 110 MB, of which `rawHtml` was 78 MB. Because every command returns a full snapshot, each click took 10–27 s and the app sat on "Opening your local workspace…". Now it's 31 MB, with first paint in about 2 s. **Nathaniel (T15/queries):** flag if anything in the renderer needs those fields; 31 MB per command is still the next performance target.
- Renderer: new `apps/desktop/src/renderer/courses/**` (`CoursePage.tsx`, `courses.css`). `App.tsx`: the `courses` view branch plus two state hooks (`courseKey`, `courseItemId`) and one focus effect. Does **not** touch `renderer/notebook/**` (T43) or the Today rail.

## Findings the team should know

- On the in-app sample course the compiler yields no course-level facts (1 assignment-scoped grading and 1 assignment-scoped policy claim, 7 unknowns); the synthetic university's syllabus is a placeholder. Literal extraction only reads the **Canvas syllabus body** under headings like "Grading:"; syllabus **PDFs are not treated as syllabi**. Nathaniel's D34 ("syllabus is found by code") should own that fix; the page already detects and links a syllabus file.
- **Live coverage on Ben's 6 current courses.** Measured with Ben's explicitly authorized, headless, read-only Canvas session through Nathaniel's `createIngestion`. Only aggregates are listed here; the data stays out of Git.
  - Pull: 2,123 resources; 260 Canvas sources (203 ok, 22 inaccessible, 35 partial).
  - Grading weights are listed in Canvas for **6/6** courses (sums ≈ 100).
  - Syllabus: 1 Canvas body, 3 files only, 2 none.
  - **AI policy found 0/6, assessments 0/6, topics 1/6.** Real syllabi mostly live in PDFs or aren't written under the headings the literal extractor looks for. The page therefore shows honest "not found" states most of the time. The biggest lever for this screen is **reading syllabus files** (D34).
- **Freshness flaw in `intelligenceView`.** It treats `inaccessible` sources, such as a disabled Pages or Quizzes area, as stale. With that rule, **every** real course showed "may be out of date" even right after a sync. The course page derives freshness from the course's own sources instead:
  - Inaccessible and unpublished areas count as checked.
  - Sign-in and error failures, or a last check more than 24 h old, count as stale.
  - I didn't change the shared function. Nathaniel, please decide whether it should match.
- Tests: 5 new (`tests/course-page.test.ts`). The full suite on the rebased branch passes 673 of 675. The one failure is the real-PTY "sessions are killed on close" test, which is in code this branch doesn't touch and also failed on the previous base.
- **Rendered journey** (hidden Electron, Ben's private data, re-run on the rebased branch with main's learning router; ready in about 6 s): Courses shows 7 cards → course page ("How this course works | Coursework | Materials", grading table, muted not-found facts) → item opens shared detail → Back refocuses the originating card; 0 console errors. Live module grouping is still pending: the first pull predates the module-id change, so Materials shows the flat fallback there. A second pull is running, and the grouping is unit-tested.

## Next action

Review and merge `feat/course-page` (Ben decides). **Nathaniel:**
- Confirm the Materials slot and `courseKey` identity work for T43.
- Take syllabus-file reading in D34.
- Rule on the snapshot trim and the inaccessible-freshness rule.

**Sean:** the course page doesn't touch the Today rail. The only `App.tsx` overlap is the `courses` view branch.
