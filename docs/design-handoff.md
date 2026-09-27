# My Magic UW desktop handoff

Use **`codex/desktop-design-integration`** as the single published frontend branch. It contains the shared desktop shell and integrated feature work. Leaf branches are working history, not alternative versions to assemble. The latest published checkpoint is the tip of this branch; `git rev-parse --short HEAD` identifies the version you are running. The September 27 clarity checkpoint follows `867d75c`. New work lands here after its interfaces and reachable journeys are checked.

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
| Home briefing → assignment → Back | `App.tsx`, `Home.tsx`, `home/projection.ts`, `PersonalReport.tsx`, `prepared-work/` | Canonical saved coursework, date evidence, source-versioned handled/Undo, bounded Upcoming and Due today; failed launch retains a usable detail action. Briefing and Upcoming share concise, collision-checked labels while raw titles remain in evidence. Confirmed handled state compacts in place with a persisted Undo. |
| Courses → course → coursework → Back | `courses/CoursePage.tsx`, `courses/course-view.ts`, domain `course-page.ts` | Right overview shows captured grading weights; shared type hues use the full snapshot and source account scope. Next class requires a verified enrollment link. The approved centered index is bound through `courses/CoursesIndex.tsx`, preserving current scope and disputed-date cues. |
| My UW → requirements / planning → Back | `MyUw.tsx`, `myuw/MyUwPage.tsx`, `myuw/model.ts` | Saved planning evidence, honest partial/stale states and existing comparison command. A live UW planning capture is not established by the fixture checks. |
| Connected sources → inspect coverage / recover | `sources/SourcesPage.tsx`, `sources/model.ts`, `IngestionControls.tsx`, `CourseSpaceDetails.tsx` | Canvas, available Outlook connections, local reading controls and retained captures. Sign-in/refresh must be judged by actual bridge results and source health. |
| Calendar → item → Back | `CalendarPage.tsx`, `calendar/` | Week/month, compact coverage evidence, full-day popovers, fitted month rows, request-only study suggestions, preserved navigation. [Integration evidence](calendar-page-integration.md). |
| Bell → notification → item, course, Outlook or Sources → Back | `notifications/NotificationsMenu.tsx`, `notifications/destination.ts`, bell in `DesktopShell` `trailing` | Code rules decide levels; Jev may only raise announcements and email and is unavailable until the gateway is hosted. Preview with `MAGIC_PREVIEW_NOTIFICATION_FIXTURE=1`. Email destinations are proven only on synthetic mail. |
| Message pill → full chat → return | `conversation-launcher/`, `chat/`, `App.tsx`, `navigation.ts` | Drafts retain captured origin and destination across navigation; current included-course access is rechecked. Local answers and saved due/search paths are available; voice and external control are unfinished. |
| First run → agreements / provider setup | `onboarding/`, `consent/`, existing desktop client bridge | Main `4cadd8d` is reconciled: typed UW sign-in outcomes, client health, default terminal and personalized onboarding. Requires current main/preload, not just a renderer reload. |
| Shared frame and components | `DesktopShell.tsx`, `navigation.ts`, `packages/ui/src/` | Lora/Geist, Lucide, evidence info, inline context and motion are shared. App binds provider, navigation and persistence behavior. |

Renderer paths above are under `apps/desktop/src/renderer`. Contracts and commands live in `packages/contracts` and `packages/core`; preserve those boundaries when adapting a leaf.

## What is verified and what remains

At `905dd73`, Node 24 typecheck/build and 54 focused tests pass for motion, inline context, course projection, My UW and Sources. Native Electron at this checkpoint demonstrated course-detail Back focus/scroll, My UW Back scroll, Sources sign-out Cancel focus, reduced-motion navigation, narrow layout, loaded Lora/Geist, and startup → idle → reload. The original workspace reopened on the same data with durable private error capture. Earlier startup IPC timeouts under concurrent/eager-reload testing were observed; the user-reported JavaScript errors have no captured matching exception and remain unexplained. Passing a component fixture does not establish the whole app journey. Private captures and student records stay outside Git. [Design adoption](design/adoption.md) records historical and current consumer evidence; [implementation status](implementation-status.md) covers backend capability boundaries.

The combined integration binds Chat/composer, prepared-work recovery, compact handled/Undo, approved Courses, My UW refresh outcomes and Sources stale-response guards. Full typecheck/build, 69 focused integration tests and 22 prepared-work tests pass. Native combined verification is recorded separately below; a source binding is not a successful backend operation. Safe Study outputs, final connection notice, personal date choice and further layout refinements remain pending.

Nate's backend follow-ups are centralized in [frontend data bugs](frontend-data-bugs.md): source account identity, freshness/completeness and evidence limits. [Course brief plan](plans/2026-09-27-course-brief.md) describes the missing Canvas-to-enrollment link for a truthful next-class block. Keep backend work there rather than masking absent facts in the renderer.

The governing design and correction rules live in [DESIGN.md](../DESIGN.md), with the [Magic design skill](../.agents/skills/magic-design/SKILL.md) as the working entry. The temporary coordination cleanup before September 27 at 11 a.m. remains a separate team release obligation; branch consolidation does not authorize rewriting active shared history.

### Palette and disclosure checkpoint

The shared 13-hue assignment-type mapper now reaches Home and Course through the full resource/source account context. Home and Course show the same verified type hue; unverified types remain neutral. Deadline proximity controls fill intensity. Small reveal actions use pill feedback with stable label geometry, and Home Upcoming and Today both support Show less with focus restoration.

Validation: full build/typecheck, 19 focused motion/deadline tests, and isolated native copied-data Home 3→6→3, Today 3→5→3, hover geometry, cross-page type identity, Sources cancel focus, My UW Back scroll, reduced motion, narrow layout, and both bundled fonts. Actual Home was compared with the original reference for color area and gradient saturation. The later clarity checkpoint removes confirmed dates from disputed Home/Course summaries and applies concise labels to Briefing and Upcoming. Real Study outputs remain pending.


### Clarity and Calendar checkpoint

The actual desktop entry point was tested against a private copy of the existing workspace: concise TSP title → original assignment → Back → Forward → Back retained exact focus; disputed Home and Course summaries showed a review cue without a confirmed date. The neutral account control opened Data & AI in both sidebar widths. Month displayed all date rows without vertical scrolling at 1440×900, and a real overflowing day opened in a top-layer list without moving the grid; Escape restored its trigger. Fonts loaded and no renderer exceptions occurred. Full build/typecheck and 48 focused title, policy, coverage, deadline and month-fit tests passed. Isolated producer checks additionally cover smaller month sizes and enlarged text, which intentionally retains reachable scrolling.

Shared action controls now consume the vivid action tokens; Data & AI explanatory text uses readable semantic roles. Browser-safe `domain/course-policy.ts` shares the existing backend restriction/freshness projection for upcoming evidence consumers; it does not add a new policy permission. The open user runtime is versioned separately from source publication, with frozen assets and durable private error logs.

The combined checkpoint adds toolbar order collapse, compose, Back, Forward; useful history controls with reduced motion; repaired collapsed course spacing; and a single launcher outside scrolling with clearance measured from its rendered height. Calendar enlarged-text disclosure and active submitted-text contrast repairs are included. Assignment composition, personal date choice, canonical feed deadlines, safe Study outputs, and final native recovery checks remain in progress.

The combined native run used the real desktop entry point with a consistent private workspace copy. A draft captured on Home survived navigation to Courses, opened the actual Chat page immediately on send, and history Back returned to Courses. Home, the five-course index and Chat had no computed Geist weight/spacing or Lora weight mismatches; both bundled fonts loaded. No renderer exceptions were recorded. The prepared six-destination request completed after preview coalescing, but latency remains a backend issue ([FDB-005](frontend-data-bugs.md#fdb-005-work-preparation-repeats-expensive-full-snapshots-on-the-worker-queue)). Full prepared actions appear before their destination list; repeated per-row explanations are associated information disclosures.

The original user-reported JavaScript errors still have no matching captured exception. The visible app retains its frozen older runtime while a real Canvas/background operation is active; source, published branch and visible runtime versions are tracked separately. The combined native check does not establish Notes safety, personal date persistence, voice control or every external launch. Those boundaries remain explicit above.
