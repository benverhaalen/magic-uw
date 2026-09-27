# Course brief on the course page: planning note

**Status: Proposal.** Written September 27, 2026 using `magic-feature-planning`, checked against `origin/main` 355602c (this includes dc3813a IPC cleanup and ab77c61 meeting details). This note does not authorize backend work, and it records no implemented brief.

## Outcome and provenance
- **Ben, September 27 (controlling correction):** the course description is "super useful", tailored like a brief. The page should open with a course-specific, source-backed orientation (what the class is about) plus the relevant facts that are changing. It must not be a rigid template, fake personal knowledge, hardcoded course prose or a repeat of Next up.
- **Same correction:** the right overview column inside the course workpane is accepted (grading weights and the verified next class). Grading appears only there.
- **Earlier decisions (proposals, not implementation evidence):** D34 in [course backend plan](2026-09-26-course-backend/plan.md) ("the syllabus is found by code and becomes the course's checked brief"; storage is open decision H6 in [course backend architecture](../course-backend-architecture.md)), D35 (structured records per material), D52 (packs specialize using the brief; code checks every quote, number, date and ID).

## Baseline (what the code actually does)
| Capability | State | Evidence |
|---|---|---|
| `CourseBrief` contract | Partial, unconnected | `packages/contracts/src/course-core.ts:273` body = schedule, assessments, grading, policies, texts, staff, with quotes/offsets. It has no "what the course is about" field. |
| `putCourseBrief` / `courseBrief` | Unconnected | `course-core.ts:539-540`, storage `packages/storage/src/course-core.ts:564,602`. The only non-test reader is the guide pack (`packages/packs/guide/src/inputs.ts:163`). No production writer was found. It is not in preload IPC or the renderer snapshot. |
| Catalog description | Unconnected to Canvas | `PlanningCatalogCourse.description` (`packages/contracts/src/planning.ts`) is keyed by UW `courseKey`. No Canvas-course linkage was found in `packages/domain/src`. |
| Verified class meetings | Unconnected to Canvas | `PlanningEnrollmentPackage.meetings` + `meetingsComplete`, same missing linkage. MyUw lists them; the course page cannot. |
| Course page facts | Built | `packages/domain/src/course-page.ts`: cited course-intelligence claims (AI policy, grading, assessments, topics) and Canvas group weights. |

Search limit: branch `codex/desktop-courses-completion` and `origin/main` 355602c, `packages/` and `apps/desktop/src`. The private test workspace had no planning records and no briefs.

## Proposed journey
Sidebar course opens the course page. A brief of two or three sentences under the concise label says what the course is about, citing the catalog description or syllabus passage, followed by only the facts that changed since the last visit (a moved due date, a new policy or reading). Next up follows. The right overview holds grading weights and the next verified class. Each claim opens its quoted source, and Back restores position. When no source exists, nothing is invented: the brief is absent and a quiet info disclosure explains why.

## Bounded architecture (for the backend owner)
1. An exact Canvas course to UW course/term/section link, from evidence (for example the Canvas SIS section id or the enrollment record) and never from matching names. This unlocks both the catalog description and verified meetings.
2. A read model field on the course page, `about: { text, sourceUrl, quote, method } | null`. Its source is the catalog description or a cited syllabus passage. If a model phrases it, code keeps the quote check (D52).
3. A course-scoped change list (already partly available from `resource_changes`), filtered to facts a student acts on.
The renderer already accepts an optional verified schedule for the next class (`CoursePageView` `schedule`). It shows nothing it cannot cite.

## Non-goals and acceptance
No hardcoded course prose, no name-matched linkage, no generic template sections, and no second Next-up list. Accepted when a real course shows a cited orientation and a verified next class from its exact linked records, and a course without them shows neither.
