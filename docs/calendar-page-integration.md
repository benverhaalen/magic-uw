# Calendar page integration

Status: integrated on `codex/desktop-design-integration` after the isolated leaf. The normal sidebar route now uses CalendarPage and stores view/date/scroll/expanded-day/selected-study return state per history entry. No school-system write is involved.

## Bind the page

`apps/desktop/src/renderer/CalendarPage.tsx` exports `CalendarPage` and `CalendarState`.

- Pass current snapshot `resources`, `sources`, `dayPlan` as `plan`, `planning`, and `personalCalendarEvents` as `personalEvents`.
- Keep `state` / `onStateChange` in the Calendar navigation entry, not in the resource-detail entry. Default state is the device-local current week, Sunday first.
- `onSelect(resourceId, returnState, focusId)` opens the existing resource detail using the exact resource ID. Save both return values; on Back supply `state` and `restoreFocusId`. State includes date, week/month view, scroll, and the expanded day or accepted-study inspection when applicable.
- `onPlan(command)` must await the real typed command and refresh the snapshot before resolving. Reject failures. The page issues study-block and local personal-calendar commands. It prevents duplicate pending writes, shows recoverable failure, and does not announce success before resolution.
- `formatCourseLabel(resourceId, courseName)` is the seam for shared display normalization. The fallback preserves the raw source label. The integrator can look up structured course identity using resourceId. The callback covers event cards, suggestions and selected study details; full source labels remain in the event tooltip and underlying data. IDs never derive from labels. Do not infer missing course identity.
- `timeZone` defaults to device timezone and is visibly named. `now` is an optional test clock; omit in production.

The parent shell supplies the single sidebar and centered page label. Use the approved My Magic UW name. There is no separate Calendar shell.

## Data and interactions

Week/month place Sunday at the left and Saturday at the right, including their actual visible date boundaries across months and years. They show captured commitments within those dates, independent of the suggestion window. No event is fabricated to fill an empty calendar. Accepted study blocks come from persisted `dayPlan`; absent/deleted resources cannot become actionable blocks.

The week view caps the all-day/due strip at one titled preview and a full-day disclosure per date. The disclosure includes every item for that day, while the timed grid starts high enough to show actual class hours without an initial scroll at the normal desktop viewport. The week grid still scrolls for later hours.

The Calendar also projects scheduled, dated meetings from saved Course Search & Enroll `enrollment_package` records with `enrollmentState: enrolled`. Catalog offerings, proposed sections, and unknown or asynchronous meetings never become grid commitments. If more than one private school account appears in enrollment records, the schedule stays hidden pending account confirmation. The class/exam detail names the source and shows when its evidence needs verification. Type checkboxes filter the view and persist through Calendar navigation; they do not modify source data. Requested study suggestions account for these verified class meetings as occupied time.

The native planning sync reads the signed-in student's current term from `enroll.wisc.edu/api/enroll/v1/current/{term}` after account verification. `normalizeUwCurrentEnrollment` retains confirmed class and exam meeting weekdays, Chicago wall times, date ranges, and asynchronous status in saved enrollment packages. The worker's planning snapshot supplies those records to Calendar; the public course catalog and search results cannot supply an enrolled schedule. Captured meeting rows do not reliably link each occurrence to its lecture/lab/discussion section or carry a per-meeting cancellation signal. Calendar therefore labels scheduled occurrences as classes, lists the enrolled package's section labels as context, and does not assert a specific meeting subtype or cancellation state. A future Brief next-class feature should consume this same saved meeting projection and identify linked readings only with separate grounded course evidence.

The page converts enrolled meeting occurrences from their captured America/Chicago wall time into the named display timezone, including date rollover. An asynchronous section is identified as having no fixed meeting; incomplete captured schedules are identified separately. An exam or quiz deadline uses captured assignment kind, never a title guess. All types hidden has a reset instruction instead of implying missing source data.

Students can add, inspect, edit, and delete their own events. These events are separate from source commitments and study blocks, stored under `personalCalendarEvents` in the local SQLite preferences table, included in snapshots, and passed through typed worker commands. All-day dates retain the student's chosen calendar date; timed entries persist UTC instants and their creation timezone. Invalid or skipped clock times are rejected. Personal events also occupy time when a student requests study suggestions. Deleting an event never changes a school source.

The adapter groups duplicate assignment captures by account + course + external ID, prefers the direct assignment for navigation, and merges deadline claims so disagreement remains visible. It suppresses a linked Canvas calendar duplicate only when the actual due date/instant agrees. Different dates remain visible. It never deduplicates by title or across accounts.

ICS date-only ends are exclusive. Timed events use their captured instant converted to the display timezone; overnight spans split across dates and midnight endings do not create a phantom next-day event. Missing event end is explicitly labeled. A repeated clock-hour event retains positive duration and a clock-change note. Calendar grid lines are structural; there are no decorative left-edge accent stripes.

Find study time is the only proposal entry. Date navigation does not create proposals or writes. Students choose a date, review grounded suggestions, and explicitly add one. Close cancels without a write. Accepted blocks can inspect their source, be removed, and be restored with Undo. The existing backend stores minute-based local blocks, not external calendar events; no Google/Apple/Canvas calendar mutation occurs.

## Verification evidence

- Typecheck/build passed in the isolated desktop checkout with the separately reviewed course-extraction startup prerequisite.
- Eleven scoped tests cover month/year boundaries, leap days, 23/25-hour local dates, exclusive all-day ends, overnight spans, missing end, source-timezone conversion, repeated clock hour, source duplication/conflicting dates/account isolation, accepted-block identity, and proposal range.
- A hidden Electron host composed this actual page with the current desktop shell, exact privately supplied Cooper Light and Geist (before the September 27 Lora Medium change), and an isolated backup of the student's real captured Canvas database. Renderer → preload → worker → SQLite snapshot and acceptance worked with no renderer exceptions.
- That host demonstrated source-detail callback → return focus/scroll, expanded-day return focus, accepted-study inspection return focus, accepted block after restart, removal → Undo after a second restart, and injected save rejection with no write followed by successful retry.
- The test host's resource detail was deliberately minimal. Full production ResourceDetail / normal sidebar entry, original-source opening, and whole-app Back integration still require the driver's integrated native check. Private screenshots/coursework/font files are not committed.

## Independent visual review

A fresh read-only Claude Opus 5.5 review (canonical model `claude-opus-5-5`, first-party provider) compared the approved Home anchor and actual native week/month screenshots. Its first broader run failed without a verdict; the bounded three-image retry completed. Adopted findings: explicit deadline wording, smaller week summary height, wider month titles, clearer outside-month dates. Course label removal and hidden default due times were rejected because they would obscure useful identity/timing. Stable cross-app course color remains a shared integration decision, not a new mapping invented here. The image review did not verify runtime behavior; native evidence above is separate.

## Limits and next integration check

Requested suggestions reuse the existing Today/domain planner and its persistence contract: today through fourteen days ahead. Month commitments are not range-limited. Clock-change days cannot safely receive minute-only suggestions, so requests explain that limitation; source events remain visible. Captured feeds may omit commitments or cover a finite source window; the page must not imply a complete live schedule. Source status remains visible.

Accepted blocks currently use the existing key/date removal and replacement API, without revision compare-and-swap. This leaf adds no new backend ownership or cross-device conflict protocol. Persisted block times have no timezone field; changing device timezone needs an upstream policy before claiming timezone-portable study scheduling.

After integrating, verify Calendar from the real sidebar, week/month/date navigation, an actual ResourceDetail/source-open/Back route, and the same acceptance/restart/Undo path. Preserve Home's compact Today rail and suggestions-on-request contract.


## Integrated checkpoint, September 27

Hidden native Electron on an independent backup of real captured data passed: sidebar Calendar entry, week/month, actual ResourceDetail and Back focus, expanded month-day return, explicit Add to calendar → app restart, accepted-study detail and return, Remove → Undo. The integrated `onPlan` adapter rejects a failed command instead of announcing success. Calendar event IDs are restored explicitly; navigation no longer treats a missing href as a valid focus match. Eleven calendar model checks and the mutation/poll gate checks pass.

The separate Home-only healthy-empty native check verifies no hour grid, no unnecessary recovery button and a retained due-today region. Full Calendar grids remain. Source access/freshness is displayed honestly; the private test copy has no login credentials. Screenshots and synthetic accepted plan records remain outside Git. Original-source external opening is still unverified in headless mode. Course labels now use the shared conservative course-resource projection, with raw name retained in tooltips/evidence and identity unchanged.

## Month viewport contract

Month uses the calendar pane's available height for its weekday heading and all four, five or six date rows. The desktop adapter removes the previous extra Calendar wrapper padding and viewport subtraction. The week time grid retains its separate scrolling behavior. Changing sidebar width or window height remeasures month rows; the number of visible event previews changes without shrinking text. A compact month cell shows one or two titled events where geometry allows, and `+N more` shares the date row instead of displacing every title. That control opens the full-day popup and its accessible name reports the entire day count. At enlarged root text, a minimum date-row height permits scrolling when the viewport cannot fit all dates legibly.

Normal desktop geometry is checked in an isolated actual CalendarPage/DesktopShell renderer at 1440×900, 1200×620 and the 880×620 minimum, with expanded and collapsed sidebar and four/five/six-row months. At 200% root text, the minimum readable rows intentionally allow scrolling; full-month visibility at enlarged text is not claimed. Grid containers do not hide overflowing focus controls. Study-review content and enlargement retain reachable scrolling when the available pane cannot contain minimum readable rows.
