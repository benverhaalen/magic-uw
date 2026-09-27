# Course Analytics: how the tab mounts

The Analytics tab lives in `apps/desktop/src/renderer/analytics/` (view model, loader, synthetic sample, dashboard) and `apps/desktop/src/renderer/charts/` (hand-rolled SVG charts). The course page only hosts it.

## The mount (13 lines across two files)

- `courses/CoursePage.tsx`: `CoursePageView` takes two optional props. `tabs` renders under the page heading. `tabBody`, when set, replaces the course layout (Next up, overview and Materials). Without either prop the page is unchanged.
- `App.tsx`: one `courseTab` state (`"overview" | "analytics"`), and the existing `<CoursePageView …>` gets:
  - `tabs={<CourseTabs tab={courseTab} onTab={setCourseTab}/>}`
  - `tabBody={courseTab === "analytics" ? <CourseAnalyticsPanel snapshot={snapshot} course={{ accountScope, courseId, courseName }} onOpenItem={setSelectedId} onOverview={() => setCourseTab("overview")}/> : null}`

`CourseTabs` and `CourseAnalyticsPanel` come from `analytics/CourseTabs.tsx`, which also imports the tab's CSS once. To port the tab to another course layout, render those two components where that layout shows its tabs and body. `onOpenItem(resourceId)` opens an item's own page. Prep and "Open assignment" use it, linked by resource ID, so Prep opens the study-prepper item space once `feat/study-prepper` routes it by ID.

## What the tab reads

- **Real course:** the app's snapshot (submissions, due dates, syllabus text), merged with the grade bank's own `gradeInputs`, plus three learning-router calls made in parallel: `course.grades`, `course.mastery` and one batched `mastery.forItems`. The count stays the same whatever the course size; `tests/course-analytics.test.ts` counts the calls.
- **Synthetic sample:** when every source for the course is the sample fixture, `analytics/sample.ts` supplies synthetic inputs ("Writing 101 · Sample", a fictional instructor and student). The grade figures still go through the real `courseGrades`, and an in-memory deck opens the existing flashcard review. The loader makes no router calls in this mode, and a real course never reads the sample.

## Design adoption record

```text
System revision: origin/main ccd21f8, merged into feat/course-analytics
Consumers: Action and MagicGlyph (Hugeicons Stroke Rounded, packages/ui) for buttons and icons; tokens.css colours via chart tokens in charts/charts.css; uniform Geist 400 for emphasis; SessionRunner from backend/mastery for flashcards
Exception/new pattern: charts (line, stacked columns, ring, segmented and level bars) are new, local to the renderer. tokens.css has no dark set yet, so dark chart values are scoped in charts.css under :root[data-theme="dark"] until the design integrator adds them.
Observed: headless render tests only (renderToStaticMarkup); no Electron window or screenshot was taken for this change.
Remaining: visual review in the running app, light and dark; the what-if band and letter wording with Ben.
```
