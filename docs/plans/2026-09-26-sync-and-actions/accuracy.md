# Accuracy and efficacy: varied course layouts, lecture recordings

> **Superseded in part by the [course backend spec](../2026-09-26-course-backend/spec.md) (2026-09-26 late).**
> - **Still current:** the layout evidence (§2), the Kaltura findings (§5) and the metrics (§4.2), which feed the ledger and the acceptance run.
> - **Changed:** the signal ladder is now input to the model pass and Jev, not the decider.

**Status: Assessment. Partly superseded by [course-compile.md](course-compile.md) (2026-09-26):**
- **Exam coverage:** the student's AI now drives it, checked by code and confirmed by the student. The signal ladder below becomes the model's input and a cross-check.
- **Transcripts:** used as provided, with watch links.
- **Measurement:** §4 becomes optional follow-up after tonight's smoke run.

Written 2026-09-26. It extends the [sync and actions design](design.md).
**The question:** how accurately can code, with no model, sort a student's materials into units and exams when every professor structures Canvas differently? What do Kaltura recordings and their transcripts add, and what do they cost?

## 1. The short answer

- **Sync and structural fields: accurate in every layout.** Course, item type, due date, module, file type and links come from Canvas as data, so there's nothing to guess. The accuracy risk here is **completeness**: material that lives outside Canvas.
- **Exam coverage ("what's on Midterm 2"): no accuracy number exists yet, and none can be borrowed.**
  - No public labelled dataset of real Canvas course layouts was found.
  - No published figures were found on how instructors lay out their courses.
  - No published accuracy was found for extracting schedules from syllabi (2026-09-26).

  The number has to come from our own courses (§4).
- **What the evidence does show:** code alone is reliable only where the course publishes a **dated schedule** or **dated recordings**. Elsewhere, code makes a proposal, Jev fills the gaps, and the student confirms. That changes the rule in the [design](design.md) §3.3 from one date rule to a ladder of signals chosen per course (§3).
- **Kaltura transcripts help most with dating lectures and finding topics. They're weaker for exact answers.**
  - UW: machine captions "are approximately 75% accurate depending on content complexity" (sourced, kb.wisc.edu/luwmad/page.php?id=92764).
  - Captions exist only where the media owner ordered them: "You must be the owner of a media item or a co-editor to order machine captions for it" (same page).

## 2. What varies between courses

**Observed in a sample of five real UW–Madison courses from one team member** (details kept private):

| Layout | What Canvas holds | What code can date | Risk for exam coverage |
|---|---|---|---|
| Modules by week | weekly modules with slides and readings | module order, often unlock dates | low |
| Modules by topic, with recordings | topic modules with Kaltura items and repository links | **recording dates**; module order | low–medium |
| Modules by resource type ("Readings", "Class notes") | files grouped by kind, some modules empty | file dates only; a "course calendar" page that overrides the syllabus | **high** unless the calendar page is parsed |
| Near-empty Canvas shell | a survey and a gradebook; the schedule is on an external course site | nothing in Canvas | **high** unless the external site is ingested (the external connector exists) |
| Quiz-centred | quizzes with attempts, files, recordings | quiz dates, recording dates | medium |

**Also observed in that sample:**
- The syllabus was in a different place in every course: a Canvas body, a PDF, a Box link, or an external site.
- 35 of 158 assignments had no due date.
- 58% of assignments weren't submitted in Canvas (paper, GitLab, external tools).
- Kaltura appeared in 3 of 5 courses, each in a different role: recordings as an LTI tool, embedded video, or student uploads.

**inferred:** any rule tied to one layout fails on at least two of the five.

## 3. The signal ladder (replaces the single date rule)

For each exam, the app uses the strongest signal the course has. It records which rung placed each item, so accuracy can be reported per rung.

| Rung | Signal | Where it comes from | Method | Expected reliability |
|---|---|---|---|---|
| **L1** | The professor states the scope ("Midterm 2 covers lectures 10–18") | announcements, the exam's assignment description, a review page | pattern match on range phrases; Jev turns unmatched text into `{exam, from, to, units}` | highest when present |
| **L2** | A dated schedule table (dates, topics, exam rows) | syllabus body, a calendar page, an external course site, a syllabus PDF | HTML tables parsed in code; PDF tables with a table extractor, then a Jev check of each row | HTML high. PDF lower: Camelot scores 73.0 TEDS on PubTabNet (66.0 on complex tables), a general table benchmark, not syllabi |
| **L3** | Dated artifacts | Kaltura recording dates, module unlock dates, file creation dates, "slides posted" announcements | code: dates between the previous exam and this one | medium. Creation dates can reflect re-uploads |
| **L4** | Order and names | module position, "Lecture 12" numbering, "Midterm 2 review" modules | code | medium–low |
| **L5** | Leftovers | anything unplaced | one typed Jev call per item: "which exam, or none" | measure-first |
| **L6** | **The student confirms** | a one-click review of the proposed set, showing unplaced items first | the confirmed set becomes the truth; later changes flag it | always |

**Wrong inclusions cost more than misses:** cards on untested material waste study time, while a missing item shows up in the review list. So rungs L3–L5 add items only above a confidence bar, and the adopt rule is set on precision (§4.3).

## 4. How we determine the numbers

### 4.1 Gold data

**Real courses:**
- Each teammate syncs their own courses with the app and labels one upcoming exam per course: which items are in scope, taken from what the professor said.
- 4 students × 4–5 courses gives about 16–20 courses covering every layout in §2.
- These stay **on each student's machine and are never committed.** Only aggregate counts are reported.

**Public, for a reproducible version:** MIT OCW courses (CC-licensed; a syllabus and calendar with exam dates). We rebuild these as synthetic Canvas layouts, one per row of §2. This tests the code on known layouts but says nothing about how common each layout is.

**Sample size:** about 50 labelled items per layout gives a 95% Wilson interval of roughly ±9 points at 90% accuracy (inferred from the Wilson formula; Wilson behaves well from about n = 10). With 16–20 courses, the per-layout results are indicative, not a census.

### 4.2 Metrics

| Area | Metric | Reported |
|---|---|---|
| Exam coverage | per-item precision and recall of the proposed set against the student's labels | micro and macro by layout, by rung and by course; with Wilson intervals |
| Exam coverage | share placed by code alone (L1–L4) | by layout |
| Efficacy | the student's edits per exam, and seconds to confirm | median, by layout |
| Sync completeness | items the student can see (Canvas plus linked course sites and recordings) that the app captured, checked by the student against a checklist of one module per course | per course |
| Transcripts | caption availability: recordings with captions / all recordings | per course |
| Transcripts | word error rate on three 2-minute samples per course, corrected by hand, plus the error rate on course terms (terms taken from that course's slides) | per course |
| Downstream | card validity for cards grounded in transcripts vs cards grounded in slides and pages (the same check as the flashcard slice) | paired, by source type |

### 4.3 Adopt rules, fixed now

- **Code-only coverage (L1–L4) ships as the default proposal** if its precision is **≥95%** across all labelled items, and **≥85% in every layout**. Recall is reported, not gated, because the student fills gaps in the review.
- **Jev (L5)** is adopted if it places **≥80%** of leftovers correctly with precision ≥90%.
- **Transcripts may ground cards on their own** only if their card validity is within 5 points of slide-grounded cards. Otherwise transcripts are **supporting context only**: they date lectures, locate topics and supply "watch at 12:34" links, and a card's answer must quote slides, pages or readings.
- **The efficacy target:** confirming an exam's scope takes a median of ≤60 seconds.

## 5. Kaltura: access, accuracy, policy

| Question | Finding | Label |
|---|---|---|
| Where it appears | "Kaltura My Media" (account navigation), "Kaltura Gallery" course galleries, and video embedded in Canvas pages | sourced (kb.wisc.edu/97690) |
| UW's Kaltura partner | partner ID 1660902 in mediaspace.wisc.edu page source | sourced |
| Captions present? | only when the owner or a co-editor ordered machine captions. Since 2023-05-15 they show automatically once returned | sourced (KB 92764) |
| Caption accuracy | UW: "approximately 75% accurate depending on content complexity". A third-party guide to Kaltura's API says machine captions are about 85% and human captions 99%+ | sourced; the figures differ |
| General lecture ASR | across ~9.8k technical MOOC lectures, 84.0% of Whisper transcripts and 75.6% of YouTube's had a word error rate under 20% | sourced, arXiv 2307.10587 |
| API | caption assets can be listed and served as SRT, WebVTT or DFXP, or as JSON with timestamps; this needs a Kaltura session token (KS) | sourced from a third-party API guide; the official docs didn't render as static pages |
| Can the student's session read captions? | unknown. A probe in a signed-in session must check whether the Canvas-embedded Kaltura page exposes a KS that can list captions | **not-found → probe K1** |
| Policy | UW's Kaltura policy page, on FERPA: "Disclosure in this context includes use outside of the class." No UW statement found on students keeping transcripts for personal study | sourced (KB 96875); open |

**Decisions:**
1. **Captions only when present. decided** Ingest existing captions with their timestamps, through the student's own session, only if probe K1 works without extra credentials.
2. **Local transcription is later and opt-in. decided** For a recording without captions, local speech recognition on the student's machine (e.g. whisper.cpp) costs compute, not tokens. It needs the recording downloaded, which is a stronger act than reading captions, so it waits for a UW policy check.
3. **Transcript text stays local and is never sent anywhere. decided** It goes to the student's AI only under the same consent as other course text.
4. **Transcripts are marked as machine transcripts in citations. decided** Example: "Lecture 14 recording, 12:34, machine transcript". Grounding labels still check quotes against the transcript text, but a transcript quote doesn't prove the lecturer said it.
5. **Recording dates feed rung L3 even when there's no transcript. decided** This alone helps exam coverage in recording-heavy courses.

## 6. Tonight: getting the first real numbers

1. **Sync:** the operator runs the app (`pnpm dev`), signs in to Canvas (NetID, Duo) and lets it sync. The data stays in the app's local workspace.
2. **Inventory, no labels needed:** a read-only local script over the workspace database reports, per course:
   - the layout type
   - which rungs (L1–L4) are available
   - the share of items with a usable date
   - the number of Kaltura items
   - external sites linked vs captured

   This gives the first **signal-coverage** numbers.
3. **Labels:** the operator marks one upcoming exam's scope per course in a generated local sheet. Precision and recall per §4.2 follow.
4. **Probe K1:** in the signed-in session, open one Kaltura item and check whether its captions can be listed and served. Record yes or no, and the formats.

Only aggregate numbers from steps 2–4 go into this document.

## 7. Sources

All checked 2026-09-26.
- UW Kaltura machine captions: https://kb.wisc.edu/luwmad/page.php?id=92764
- UW Kaltura My Media in Canvas: https://kb.wisc.edu/97690
- UW Kaltura legal and policy information: https://kb.wisc.edu/luwmad/96875
- Kaltura caption API guide (third-party): https://kaltura.md/KALTURA_CAPTIONS_AND_TRANSCRIPTS_API/
- Word error rates across NPTEL lectures: https://arxiv.org/abs/2307.10587
- Canvas course object (`is_public`, `public_syllabus`): https://canvas.instructure.com/doc/api/courses.html
- MIT OpenCourseWare: https://ocw.mit.edu/
- Open Syllabus documentation: https://docs.opensyllabus.org/
- Table extraction on PubTabNet (Camelot TEDS): arXiv 2409.05125
- Micro and macro averaging: https://scikit-learn.org/stable/modules/model_evaluation.html
