# Academic calendar and campus life: one calendar, plus a place for everything else

Checked 2026-09-26. Labels: **sourced** · **inferred** · **not-found**.

## Why it matters (evidence)
- **Time management is moderately related to academic achievement and wellbeing,** and negatively related to distress. The relation to performance has strengthened since the 1990s (Aeon, Faber & Panaccio 2021, *PLOS ONE*, doi:10.1371/journal.pone.0245066; sourced).
- **The planning fallacy:** students estimated a senior thesis at 33.9 days; it took 55.5, and only about 30% finished within their own estimate. Predictions ignore past-task history (Buehler & Griffin 1994; sourced). **So buffers should come from the student's own actual-vs-estimated times,** which the study clock records.
- **Time-blocking percentages** (e.g. "40% faster") trace to marketing blogs only. **Don't cite them** (not-found in primary research).

## One calendar, in layers
| Layer | Source | Notes |
|---|---|---|
| **Classes** | Course Schedule (meetings, dates, rooms); map.wisc.edu building coordinates | walking time between consecutive classes; free campus buses 80/84 (mobile.wisc.edu; no routing API found) |
| **Deadlines** | Canvas + deadline truth + tool gaps (`integrations.md`) | each shows its source; conflicts are badged |
| **Exams** | the compiler's assessments + dossiers | a prep ramp before each exam |
| **Study** | spaced sessions and study clocks (`practice-engine.md`) | fitted into gaps; the buffer grows from the student's own history |
| **Admin deadlines** | registrar.wisc.edu/dates: Fall 2026 classes start **Sep 2**; drop/withdraw with no transcript notation **Sep 9**; add/swap and the 100% tuition drop deadline **Sep 11**; tuition due the second Friday of the semester (bursar); FAFSA: **Apr 15, 2026 is the 2025–26 last-chance deadline; the 2026–27 priority date was Dec 1, 2025** (corrected 2026-09-26) | **the registrar publishes an Outlook shared calendar, "RO Enrollment Dates & Deadlines", in the Global Address List** (sourced), so it can be added from the student's own Outlook |
| **Advising** | **Starfish** is UW's appointment system for advising, career coaching, financial aid and learning support (oacs.wisc.edu/starfish; sourced) | appointment confirmations arrive by email and invite |
| **Clubs** | **WIN (win.wisc.edu), on CampusGroups** (wisc.campusgroups.com; 1,000+ orgs; sourced); public ICS not-found | detected from Outlook (below); the student confirms |
| **Campus events** | **today.wisc.edu JSON API**: append `.json` to a view, e.g. `/events/tag/:tag.json`, `/events/search/:term.json`, with `start`/`end` (sourced; a live feed was fetched) | suggested events by the student's interests and majors |
| **Career** | Handshake + SuccessWorks (fairs, 30-minute appointments) | fairs and appointments on the calendar |
| **Health and wellbeing** | MyUHS (appointments), Rec Well portal | only if the student turns it on |
| **Library rooms** | 50+ rooms bookable up to 2 weeks ahead, max 4 h/day (library.wisc.edu) | "book a room" for group sessions |

## Outlook as the life source (the student's own session, with consent)
**Metadata first, content only when needed:**
- **Meeting invites** (iCalendar `METHOD:REQUEST`) add events: advisor meetings, club meetings, TA office hours.
- **Mailing-list headers** (`List-Id`, `List-Unsubscribe`, RFC 2919/2369; sourced) identify **club and department listservs** without reading the body. Each list becomes a "Life" entry the student can name ("Badger Robotics"), mute or follow.
- **Sender domains and known systems** (Starfish, Handshake, UHS, WIN/CampusGroups) tag advising, career and health messages.
- **Jev** is only for the leftovers, e.g. "is this a meeting or event announcement?" Email is untrusted, so Jev may only surface a message, never hide one.

**Privacy:**
- Outlook reading is a separate consent switch.
- It all stays in the local Vault.
- Metadata-first by default.
- FERPA and university guidance on scanning email weren't found, so this is **an open question to check** before launch.

## The "Life" space
**A sidebar space next to the courses,** holding:
- **Clubs:** each club's upcoming meetings and events, its list messages, and roles (member / officer).
- **Advising:** the advisor, the next appointment, prep notes ("questions for my advisor"), degree-planning links.
- **Career:** fairs, applications, SuccessWorks appointments.
- **Health and wellbeing:** only if the student enables it.
- **Commitments:** work shifts and recurring personal blocks, entered once.

## Intelligent calendar features (ideas, grounded where noted)
- **Auto-scheduling study blocks** around classes, clubs and work, like Motion or Reclaim but academically aware:
  - it knows exam dates, coverage and preparedness
  - Motion reshuffles in real time; Reclaim defends "Focus Time" (sourced)
- **A workload heat strip:** effort × due date across courses. It warns about collision weeks ("3 midterms + a club event on Oct 14").
- **Buffers against the planning fallacy:** each estimate is corrected by the student's own ratio of actual to estimated time, taken from study-clock logs.
- **Walking-time awareness:** back-to-back classes in distant buildings get a travel buffer and a "you can't make office hours between these" warning.
- **Admin deadline guardrails:** "the drop/withdraw deadline is in 3 days" when a course's preparedness is poor. It's information, not advice.
- **Prep for meetings:**
  - advisor meeting tomorrow → a pre-filled prep note (current courses, grades, questions)
  - club meeting → the latest list messages
- **Natural-language quick add** ("GUTS tutoring Thursday 4pm, Memorial Library"), as in Fantastical (sourced).
- **Exports:** one ICS feed out, and an optional Outlook sync of study blocks.
