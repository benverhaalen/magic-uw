# My Magic UW desktop handoff

Use **`codex/desktop-design-integration`** as the single published frontend branch. It contains the shared desktop shell and integrated feature work. Leaf branches are working history, not alternative versions to assemble. The latest verified integration checkpoint is **`905dd73`** (September 27); `git rev-parse --short HEAD` identifies the version you are running. New work lands here after its interfaces and reachable journeys are checked.

```sh
git fetch origin
git switch codex/desktop-design-integration
git pull --ff-only
pnpm install
pnpm build
pnpm exec electron apps/desktop
```

Use Node 24 and the repository's pnpm version. [Development](development.md) covers gateway and desktop configuration. Preserve your existing workspace and credentials; do not copy another student's database. Lora Medium and Geist are bundled with their SIL Open Font Licenses. The build verifies both emitted font files against the supplied originals.

## Where to work

| Student journey | Real entry and implementation | Current boundary |
| --- | --- | --- |
| Home briefing → assignment → Back | `App.tsx`, `Home.tsx`, `home/projection.ts`, `PersonalReport.tsx`, `StartWork.tsx` | Canonical saved coursework, date evidence, source-versioned handled/Undo, bounded Upcoming and Due today; failed launch retains a usable detail action. Richer display labels and compact handled presentation are still being refined. |
| Courses → course → coursework → Back | `courses/CoursePage.tsx`, `courses/course-view.ts`, domain `course-page.ts` | Right overview shows captured grading weights; shared type hues use the full snapshot and source account scope. Next class requires a verified enrollment link. The centered Courses index composition is approved; spacing and implementation refinement remain under review. |
| My UW → requirements / planning → Back | `MyUw.tsx`, `myuw/MyUwPage.tsx`, `myuw/model.ts` | Saved planning evidence, honest partial/stale states and existing comparison command. A live UW planning capture is not established by the fixture checks. |
| Connected sources → inspect coverage / recover | `sources/SourcesPage.tsx`, `sources/model.ts`, `IngestionControls.tsx`, `CourseSpaceDetails.tsx` | Canvas, available Outlook connections, local reading controls and retained captures. Sign-in/refresh must be judged by actual bridge results and source health. |
| Calendar → item → Back | `CalendarPage.tsx`, `calendar/` | Week/month, request-only study suggestions, preserved navigation. [Integration evidence](calendar-page-integration.md). |
| First run → agreements / provider setup | `onboarding/`, `consent/`, existing desktop client bridge | Reuse Nate's implementation. The new onboarding work is a plan, not a second setup implementation. |
| Shared frame and components | `DesktopShell.tsx`, `navigation.ts`, `packages/ui/src/` | Lora/Geist, Lucide, evidence info, inline context and motion are shared. App binds provider, navigation and persistence behavior. |

Renderer paths above are under `apps/desktop/src/renderer`. Contracts and commands live in `packages/contracts` and `packages/core`; preserve those boundaries when adapting a leaf.

## What is verified and what remains

At `905dd73`, Node 24 typecheck/build and 54 focused tests pass for motion, inline context, course projection, My UW and Sources. Native Electron at this checkpoint demonstrated course-detail Back focus/scroll, My UW Back scroll, Sources sign-out Cancel focus, reduced-motion navigation, narrow layout, loaded Lora/Geist, and startup → idle → reload. The original workspace reopened on the same data with durable private error capture. Earlier startup IPC timeouts under concurrent/eager-reload testing were observed; the user-reported JavaScript errors have no captured matching exception and remain unexplained. Passing a component fixture does not establish the whole app journey. Private captures and student records stay outside Git. [Design adoption](design/adoption.md) records historical and current consumer evidence; [implementation status](implementation-status.md) covers backend capability boundaries.

Chat/composer, stronger Home study outputs, prepared-work recovery, final connection notice, broader motion feedback and content cleanup are pending integration or review. Their presence on a leaf is not a claim that the normal app can use them. The centered Courses index option is approved in composition, with refinement and runtime review still required.

Nate's backend follow-ups are centralized in [frontend data bugs](frontend-data-bugs.md): source account identity, freshness/completeness and evidence limits. [Course brief plan](plans/2026-09-27-course-brief.md) describes the missing Canvas-to-enrollment link for a truthful next-class block. Keep backend work there rather than masking absent facts in the renderer.

The governing design and correction rules live in [DESIGN.md](../DESIGN.md), with the [Magic design skill](../.agents/skills/magic-design/SKILL.md) as the working entry. The temporary coordination cleanup before September 27 at 11 a.m. remains a separate team release obligation; branch consolidation does not authorize rewriting active shared history.

### Palette and disclosure checkpoint

The shared 13-hue assignment-type mapper now reaches Home and Course through the full resource/source account context. Home and Course show the same verified type hue; unverified types remain neutral. Deadline proximity controls fill intensity. Small reveal actions use pill feedback with stable label geometry, and Home Upcoming and Today both support Show less with focus restoration.

Validation: full build/typecheck, 19 focused motion/deadline tests, and isolated native copied-data Home 3→6→3, Today 3→5→3, hover geometry, cross-page type identity, Sources cancel focus, My UW Back scroll, reduced motion, narrow layout, and both bundled fonts. Actual Home was compared with the original reference for color area and gradient saturation. Course conflict cues are present; the stronger shared disputed-date projection is still pending. Concise briefing copy and real Study outputs are separate pending integrations.
