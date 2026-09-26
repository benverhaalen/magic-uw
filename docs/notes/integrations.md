# Integrations: everything reachable through the Canvas portal

Checked 2026-09-26. Labels: **sourced** · **inferred** · **not-found**.

## Canvas is the hub
- **Each course's tools:** `GET /api/v1/courses/:id/external_tools` lists every LTI tool installed in a course, with name, domain and LTI version. **That's the student's toolset, enumerated with no launch** (sourced: canvas.instructure.com/doc/api/external_tools.html).
- **Opening a tool as the student (sanctioned):** `GET /api/v1/courses/:id/external_tools/sessionless_launch?id=…` (or `assignment_id=` / `module_item_id=`) returns a **one-time launch URL**. Loaded in the student's session, it opens the tool as them. The method is **GET**, per both developerdocs.instructure.com (external_tools) and canvas.instructure.com/doc/api/external_tools.html, checked 2026-09-26. The GET returns the URL; loading that URL performs the LTI launch (sourced). **Every tool becomes a tab in the app.**
- **LTI 1.3 launches are form POSTs** (OIDC plus a signed token), so a plain GET can't launch a tool. Use `sessionless_launch`, or let Canvas's own launch run in the tab (sourced).
- **Grades flow back** to Canvas through AGS (Assignment and Grading Services), so the Canvas gradebook shows them once the tool posts them (sourced).

## ⚠️ The gap: deadlines that live only inside a tool
- **A due date appears in Canvas's calendar, API and ICS feed only if it's set on the Canvas assignment itself** (sourced: developerdocs calendar_events).
- **zyBooks documents its own due dates as separate from Canvas's and not synced;** the instructor has to set both (sourced: support.zybooks.com 17867082630939, 360042745653). The same is likely true of other tools (inferred).
- **Closing the gap without breaking anyone's terms, in order of preference:**
  1. **The syllabus and course pages.** Instructors often list tool due dates there, so the course compiler extracts them with citations.
  2. **The tool's own notification emails** in the student's Outlook: "graded", "due soon", "new assignment". Code parses sender, subject and dates; Jev classifies only what's left.
  3. **Natural-language quick-add** ("zyBooks ch 5 participation due Fri 11:59").
  4. **Reading the page the student has open, on their explicit click,** and only for tools whose terms permit it (the table below).

## FERPA vs platform terms (two different questions)
- **FERPA governs the institution** (a school receiving federal funds disclosing a student's education records). **It doesn't stop a student from accessing their own records, or from choosing to use them in a tool running on their own laptop** (inferred from the law's scope; confirm with UW's registrar or FERPA office before launch). With the student's consent and local storage, **FERPA isn't the blocker for the student's own data.**
- **What FERPA-style privacy still covers: other students.**
  - Piazza posts, discussion threads, group rosters and shared files show *classmates'* names and work.
  - The student can't consent for them. So: store the minimum, never send classmates' data to cloud models (the policy engine's `communications` class), and never export it.
- **The real constraint is contract:** each platform's terms of use, which the student accepted.
  - Gradescope, Top Hat and Piazza **prohibit automated access or scraping**, even by a consenting user. The risk is **account suspension and a UW acceptable-use complaint**, not FERPA.
  - **zyBooks' terms page is behind Cloudflare** and couldn't be fetched (not-found). **Read it in a browser before building automated zyBooks reading.**

## Platforms (UW = on the central list at kb.wisc.edu/luwmad/65466, sourced)
| Platform | At UW | Deadlines visible in | Automated access in its terms | Our approach |
|---|---|---|---|---|
| **Gradescope** | yes (all instructors since Aug 2025, kb.wisc.edu/153859) | Gradescope; grades reach Canvas when the instructor posts them | **Prohibited:** "any automated or non-automated 'scraping'"; "robots, spiders, offline readers" (gradescope.com/tos) | tab + Canvas grades + Gradescope emails; **no page reading** |
| **Top Hat** | yes | in the tool | **Prohibited:** "You will not access the Services through automated or non-human means" (builtbytophat.com/terms-of-use) | tab + Canvas + emails only |
| **Piazza** | yes | — | **Scraping prohibited** without written consent (piazza.com/legal/terms) | tab + pinned links |
| **zyBooks / zyLabs** | per course (not on the central list) | **separate, not synced to Canvas** | not checked (not-found) | tab + syllabus/emails/quick-add; check its terms before any page reading |
| Cengage (MindTap, WebAssign) | yes | likely in the tool (inferred) | not checked | tab + Canvas + syllabus; check its terms |
| Pearson (MyLab / Mastering) | yes | not checked | not checked | as above |
| Macmillan Achieve | yes | not checked | not checked | as above |
| McGraw Hill Connect / ALEKS | per course | not checked | not checked | as above |
| Kaltura, Panopto (lecture video) | yes (Kaltura listed) | — | not checked | tab; link recordings to that day's lecture note |
| Ed, Perusall, Hypothesis, PrairieLearn, iClicker | per course | — | Ed has an official token API (see `project-coordinator.md`) | tab; Ed through its API |

**Still to check:** the automated-access terms for zyBooks, Cengage, Pearson, McGraw Hill, Macmillan, Panopto and Kaltura (not-found). **Until then, the default is the most conservative: tab, Canvas and emails only.**

## Ready to submit (Gradescope and every other tool)
- **The app never submits and never reads the tool's pages.** It prepares and checks the student's *own completed* work, then hands off to the tool's real submission page.
- **Pre-flight checks** (code first; Jev only for fuzzy rubric items):
  - required files present, with the names and formats the spec asks for
  - the rubric and requirements checklist ticked by the student
  - repo state for code assignments (committed, pushed, tests run locally)
  - the page limit
  - the **AI Usage Statement** drafted from the AI-use log and attached if the course requires one
- **A "Ready to submit" button** opens the assignment's submission page, via Canvas's own launch (`sessionless_launch` with `assignment_id`, or the assignment's LTI link). **The student uploads and presses Submit.**
- This follows Gradescope's terms (no automated access or scraping), and the "never submit" rule.

## Quality-of-life features on top (ideas)
- **One "due" list across every tool,** with the source shown on each line (Canvas / syllabus / email / quick-add). A badge flags items that exist only inside a tool: "zyBooks dates aren't in Canvas; from the syllabus".
- **Grade-release radar:** grades posted to Canvas, plus "graded" emails from tools, reach the course and the assessment's result view.
- **One-click into the right place:** "Open zyBooks ch 5" launches straight into it through `sessionless_launch` with `module_item_id`.
- **Lecture recordings (Kaltura or Panopto) attached to that day's lecture note** by date. With consent, captions or transcripts become course sources.
