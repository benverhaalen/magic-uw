# Practice and insights: addendum to the notebook and study-tracking spec

**Status: proposed.** Written 2026-09-26 against `main` at `73ff7a6`. It extends [spec.md](spec.md) and doesn't replace any of it. Where this addendum and the spec could disagree, the spec's rules win (the knowledge model, KM-*; integrity and privacy, IP-*; no probabilities of passing), and §9 lists every point that needs the spec updated.

**Labels:** **built** (in the code at `73ff7a6`) · **Decision** (settled, with its evidence) · **proposed** (this addendum) · **researched** (a cited public source, not our measurement) · **vendor-reported** (a company's own A/B test or survey, not independent).

**Tasks:** Part C of [tasks.md](tasks.md), IDs P01–P21.

## 1. What this adds, and why

**The operator's ask:** "more feature-rich, quality-of-life, Quizlet- and Duolingo-like practice testing, with intelligent student analytics and insights to help them study further, exactly according to the course materials."

This addendum adds three things on top of the spec's study modes (ST-*) and knowledge model (KM-*):
- **A habit loop in the style of Duolingo:** a course path, a daily goal, a streak you can freeze or switch off, and quick sessions. There are no lockouts.
- **The full set of Quizlet-style modes:** Flashcards, Learn, Write, Test and Match, plus stars, "study only starred or missed", card editing and the student's own cards.
- **Insights tied to the course material.** Every insight names the lecture, page or passage behind it, and one click opens it.

**The rule that runs through all of it:** engagement features are labelled as engagement. Only the knowledge model's states (KM-6) describe what the student knows, and no feature adds a probability of passing, a readiness score, or a learning claim of our own.

### Evidence and context
| Source | What it says | How we use it | Label |
|---|---|---|---|
| Duolingo blog, 2022-01-31, "how-duolingo-streak-builds-habit" | Learners who reach a 7-day streak are "3.6 times more likely to complete their course" (correlational). A new streak animation gave +1.7% day-7 retention. Allowing 2 streak freezes gave +0.38% daily active learners | Streaks and freezes are worth building **as engagement mechanics.** The 3.6× figure is a correlation; it doesn't show that streaks cause completion, let alone learning | vendor-reported |
| Settles & Meeder, ACL 2016, half-life regression | "Reduc[ed] error by 45%+ compared to several baselines at predicting student recall" and "improve[d] Duolingo daily student engagement by 12%" | A decay baseline for the offline evaluation (§7). A model of forgetting can be evaluated on public data before we have students | researched (authors are Duolingo staff) |
| Quizlet (quizlet.com, checked 2026-09-26) | Learn rounds and practice tests are capped per month on the paid Plus tier; "custom study paths… Progress, and… smart grading" sit on a higher tier. Its grade claims are self-reported surveys | Magic Canvas doesn't cap rounds or tests (§3). We make no grade claims | researched (vendor pages) |
| Gemini Notebook (NotebookLM renamed) | Its free tier caps generated flashcard sets and quizzes per day, and it has no Canvas integration | Practice from existing pools is unlimited and works offline (ST-11); sources come from Canvas | researched (vendor pages) |
| "Lives" lockouts in the middle of hard drilling | A recurring complaint about study apps (2 independent sources, [practice evidence §1](../../notes/practice-evidence.md)) | No hearts or lives that block study (PI-5) | researched |
| Pelánek and colleagues, adaptive-practice difficulty studies ([performance plan §3.5](../../notes/performance-plan.md)) | Easy questions help short-term engagement, harder ones long-term learning; a success rate around 65% suited learners | The quick sessions and the path use the spec's difficulty preference (spec §5.7) | researched |
| Van der Kleij 2015; Butterfield & Metcalfe 2001; Rawson & Dunlosky 2011; a preregistered pretesting meta-analysis ([performance plan §3](../../notes/performance-plan.md)) | Elaborated feedback beats right/wrong only; confident errors are corrected best; successive relearning; pretesting helps asked content (g = 0.54) | Every mode explains with a source quote; confident misses come back first; checkpoints use spaced relearning; an optional pretest before a new unit | researched |

## 2. The Duolingo-like loop

Every requirement here is **proposed**. Criteria marked **¬** are negative cases that must hold. The phases follow spec §12.

| ID | Requirement | Acceptance criteria | Builds on | Phase |
|---|---|---|---|---|
| PI-1 | **A course path** built from modules and lectures: units in module order (or by schedule week, or concept unit, until modules are captured), one lesson per concept, and a **checkpoint** before each assessment | The path lists units in `module.position` order, or in schedule order when modules aren't captured. A checkpoint appears for each upcoming assessment, 3 days before it by default, covering its concepts (NB-11 coverage). **¬** No unit or lesson is ever locked; the student can open any of them. **¬** When modules aren't captured, the path says "Ordered by the syllabus schedule" instead of implying module order | ST-5, KM-1, NB-11 | 1 |
| PI-2 | **Checkpoints:** a mixed, interleaved set of 10 items or fewer over the assessment's covered concepts, drawn from coverage pools. Missed concepts come back 1–2 days later (successive relearning) | Results show counts by concept ("Recurrences: 3 of 4 without hints"), and the KM states update as usual. **¬** A checkpoint never gates anything, and never shows a pass/fail mark, a score out of 100 or "ready". **¬** Its items are selected locally from coverage pools; the selection isn't sent to a provider (spec §9.2) | ST-7, KM-7 | 1 |
| PI-3 | **A daily goal** in minutes (5, 10, 15 or 20) or items (10, 20 or 30). The default is 10 minutes | The goal is met when active minutes (idle over 2 minutes excluded) or completed items reach it. The student can change the goal or switch it off. **¬** Missing the goal produces no message at all. **¬** Minutes of Match (PI-13) count toward the goal, but its answers don't count as evidence | ST-5 | 1 |
| PI-4 | **A streak with freezes and rest days,** and an off switch | A streak day is a local calendar day with at least one completed activity (as ST-5 says); counting only days the goal was met is an option, off by default. **Freezes:** the student holds up to 2 and earns 1 for every 7 streak days; a missed day uses one automatically. **Rest days:** the student can pre-mark days of the week (e.g. Saturdays) that never break the streak. **¬** Freezes are never sold and never cost anything. **¬** Losing a streak shows neutral copy only ("New streak: day 1"). **¬** With the streak switched off, it's hidden everywhere and no streak notification is sent | ST-5, IP-10 | 1 |
| PI-5 | **No punishing lockouts** | There are no hearts, lives or energy. A wrong answer never limits further study, in any mode. **¬** A test drives 50 wrong answers in a row through every mode, and the next item is still served | ST-5 | 1 |
| PI-6 | **XP as a progress signal only** | XP comes from a fixed table (card review 1, item 2, typed answer 3, completed checkpoint 10). It appears only on the path and in session summaries, labelled "activity points". **¬** There is no speed bonus, which would reward rushing. **¬** XP never appears in concept states, insights or the coverage map. **¬** No copy links XP to learning, mastery or readiness | ST-5, IP-9 | 1 |
| PI-7 | **Quick sessions** ("5 minutes", or 3 or 10) sized from the day | The session is sized with the minutes-per-item values (spec §5.9). It holds up to 1 confident miss, the most urgent due cards, and one Learn family on the top-priority concept (spec §5.7). The size is suggested from the gaps the app knows: student-set study windows today; class times once calendar capture exists (not built). **¬** A session never exceeds its size by more than one item. **¬** With no provider, it uses existing pools only (ST-11) | ST-7, KM-7 | 1 |
| PI-8 | **Local notifications,** opt-in | Off by default. When on, there's **at most one notification a day** (IP-10), at a time the student picks, with quiet hours. Each is one of: "Your daily goal: ⟨n⟩ minutes" or "Checkpoint for ⟨assessment⟩ is open". Notifications are delivered by the OS from the app, with no server and no network. **¬** No notification is sent after the goal is met that day. **¬** No notification uses urgency or guilt copy (PI-26, PI-27). **¬** Switching notifications off stops them at once, including any already scheduled | IP-10 | 2 |

## 3. Quizlet-like modes

Every mode draws from the same checked items (ST-1) and writes evidence under the same rules (spec §5.2).

**No caps:** practice from existing pools has no daily or monthly round or test limits. New items are generated on the student's own provider.

| ID | Requirement | Acceptance criteria | Builds on | Phase |
|---|---|---|---|---|
| PI-9 | **Flashcards** with FSRS, plus quality-of-life features | The spec's ST-2 behaviour, plus:<br>• keyboard control (space flips; 1–4 rates)<br>• shuffle within the due set<br>• swap front and back<br>• optional "type the answer" (code compares and suggests a rating; the student can override it)<br>**¬** Swapping sides never creates a second FSRS card for the same fact. **¬** A suggested rating is never saved without the student's own rating | ST-2 | 1 |
| PI-10 | **Learn** with item families (MC → typed) and round options | ST-3 behaviour, with round sizes of 5, 7 or 10 families. A "multiple choice only" setting exists, labelled "Recognition only: these answers won't make a topic Solid". **¬** In that setting the typed stage is skipped, and the KM rule that recognition-only records can't reach Solid still applies (spec §5.5) | ST-3, KM-6 | 0.5 |
| PI-11 | **Write:** typed recall for every family, graded by key ideas, with a **contest** button ("I was right") | Grading follows ST-3 and N08; the feedback lists the key ideas found and missing. **Contest** stores a grade dispute (spec §6.5), removes the attempt from the knowledge model and marks it "contested" in history. **¬** A contest never turns the attempt into a correct answer for the knowledge model; it only removes it. **¬** A contested grade stays visible and can be withdrawn | ST-3, ST-9, KM-4 | 1 |
| PI-12 | **Test:** a practice exam with an optional timer and opt-in exam conditions | ST-4 tiers and blueprint. The timer is set by the student, or taken from a stated exam length (T1/T2) when there is one. **Exam conditions** (opt-in) hide hints, defer all feedback, and show the timer. Without exam conditions, the test can be paused. **¬** When the timer ends, answers are saved; it auto-submits only under exam conditions. **¬** No predicted score is ever shown; only observed counts by concept | ST-4, IP-9 | 1 |
| PI-13 | **Match:** a fast tile game pairing terms and definitions from the student's cards | It shows the time and the student's personal best. The mode carries a label: "Match is a speed game. It's fun review, but the evidence that it helps learning is weak: it trains quick recognition, not recall." **¬** Match answers never count as scored evidence (they don't move θ or `n_c`) and never appear in concept states. **¬** There's no leaderboard, and times aren't compared with other students | spec §5.2 | 1 |
| PI-14 | **Star** items, cards or concepts, and study "only starred", "only missed" or "only Iffy" | A star is a private study mark. It's separate from **Flag,** which reports an error and quarantines the item (ST-9). Every mode accepts a filter:<br>• all<br>• starred<br>• missed (in the mistakes queue, or missed in the last 14 days)<br>• Iffy concepts<br>**¬** Starring never changes the knowledge model. **¬** A filter with no matching items says so and offers to widen it; it never silently serves the unfiltered set | ST-6, ST-9 | 0.5 |
| PI-15 | **Card editing** | The student can edit a generated card's front, back or explanation. The edit becomes a new item version with origin `student`, labelled "Edited by you", and the checks re-run: the quote check still applies if the card still cites a source. Evidence stays attached to the version it was earned on. **¬** An edited card never keeps "Quote found in source" once its quote no longer validates. **¬** An edit is never sent to a provider unless `student_work` has been approved (spec §9.2) | ST-1, KM-3 | 1 |
| PI-16 | **The student's own cards,** linked to course sources | "Make a card" from a selected passage in the notebook stores the link (resource, version, offsets) automatically; a blank card has no link. The labels are "Your card · from ⟨lecture or page⟩" or "Your card · no source". Own cards can be tagged to 1–3 concepts (KM-2), and their answers count as evidence (spec §7.3, `learning_attempts`). **¬** When a linked source changes, the card is marked "source changed" and kept, never deleted. **¬** An own card with no source is never shown with a source label | NB-1, KM-2 | 1 |

## 4. Insights, tied exactly to the course materials

**How it works:**
- Every insight is computed in local code from local events and captures, in the worker.
- None calls a model, and none leaves the device unless the student sends it, which falls under the `learning_state` rule: a blocking preview on the first send (spec §9.2, IP-8).
- Insights describe **activity and evidence**, never readiness. Readiness stays deferred (spec §5.10; [performance plan §3.6](../../notes/performance-plan.md)).

**Anchors:** every insight carries at least one **source anchor**: `{resourceId, version, start, end, label}`.
- The label is the lecture, slide or page once extraction supplies `parts` (B05).
- Until then, it's the resource title plus the nearest section heading. With today's capture, anchors point into syllabus and assignment text only.

| ID | Requirement | Acceptance criteria | Builds on | Phase |
|---|---|---|---|---|
| PI-17 | **Source-anchored insights and "Study this next"** | Every rendered insight has at least one anchor whose span validates in its stated version (the N01 check). **Study this next** opens the notebook at that span, highlighted, and offers a quick session (PI-7) for the concept. **¬** An insight without a valid anchor isn't rendered. **¬** When the anchored version has been superseded, it opens the current version with "This passage changed since you studied it". It never shows a fuzzy "best match" as if it were the same passage | NB-3, NB-4 | 1 |
| PI-18 | **A coverage map** for each upcoming assessment | For each covered material (and passage group, once `parts` exist), it shows one of: **practiced** (at least one scored attempt on an item citing it), **studied** (opened in the notebook or a guide for 30 seconds or more of active time, but not practiced), or **untouched**. It shows counts ("12 of 20 materials practiced") and the tier of the coverage basis (NB-11). **¬** It never shows a readiness figure, a percentage or a predicted score. **¬** "Untouched" is never shown for material the app didn't capture; that's listed separately as "not captured" | NB-11, KM-6 | 1 |
| PI-19 | **Concept states in insights** | The KM-6 view grouped by assessment, with the reasons and evidence counts, and each reason's anchors. **¬** No field beyond KM-6's is added (no ability value, no probability) | KM-6, KM-8 | 0.5 |
| PI-20 | **Error patterns** | **Frequent distractors:** for multiple-choice items, the wrong options chosen 2 or more times, each shown with its "why it's tempting" line and the anchor of the passage that settles it. **Confusable pairs:** when a chosen distractor is tagged to another concept (option tags, §6), the pair "A answered as B" is counted, and pairs with 2 or more confusions show both concepts' anchors and offer a **compare** session that interleaves A and B (interleaving helps confusable categories: Brunmair & Richter 2019, researched). **¬** A pattern needs at least 2 occurrences. **¬** Disputed or contested attempts are excluded | ST-10, KM-2 | 1 |
| PI-21 | **Calibration:** confidence against accuracy | For each confidence level (Guess, Unsure, Fairly sure, Sure), it shows counts: "Sure: 18 of 22 right". **Overconfident topics** are concepts where "Fairly sure" or "Sure" answers were wrong at least 4 times, and more often than the student's own rate at those levels; each links to its R4 reasons and anchors. Delayed self-ratings (KM-11) appear beside them. **¬** Nothing is shown until at least 10 answers carry a confidence rating. **¬** Everything is shown as counts; no calibration score or percentage appears | ST-8, KM-5 R4, KM-11 | 1 |
| PI-22 | **Time on task and session history** | Active minutes per day and week (idle over 2 minutes excluded), plus a list of sessions: mode, items, outcomes as counts, concepts touched, and their anchors. **¬** Time never enters the knowledge model (spec §5.2) and is never called an effort or productivity score | spec §5.2 | 1 |
| PI-23 | **A weekly digest, generated locally** | On a day the student picks, code builds the digest from templates and local data:<br>• what changed (PI-24)<br>• the top 3 "study this next" items, with anchors<br>• each upcoming assessment's coverage map in counts<br>• a calibration note, if PI-21 has enough data<br>• active time<br>It can be exported to a local `.docx` in the notes tree. **¬** No model or network call is made to build it (a test with a runtime spy). **¬** "Send to my AI" is the only way it leaves the device, and the first send shows the `learning_state` blocking preview | IP-8, NB-15 | 2 |
| PI-24 | **What changed since last week** | A list of state transitions, each with the rule that caused it and its evidence ("Recurrences: Getting there → Iffy on 24 Sep. Missed Q4 after getting it right on 20 Sep (R3)"), plus Canvas materials new or changed since last week. **¬** Every line comes from a stored event or capture; nothing is inferred or generated | KM-8, NB-13 | 1 |
| PI-25 | **Local by default** | Every insight is computed in the worker from local tables, and purge removes all of them (KM-13). **¬** No insight request writes an egress receipt unless the student chose to send it. **¬** The MCP tool `knowledge_summary` is the only tool that exposes states, and it stays under `learning_state` (spec §8.3) | IP-8, KM-13 | 0.5 |

## 5. Anti-dark-pattern rules

These extend IP-9 and IP-10. They're checked by a copy lint (P16) over the product's own strings; quoted course text is out of scope.

| ID | Requirement | Acceptance criteria | Phase |
|---|---|---|---|
| PI-26 | **No fake urgency** | Every date and countdown comes from a resolved Canvas deadline (`resolveDeadline`, **built**) or a date the student entered. **¬** There are no invented countdowns, no "only ⟨n⟩ left" and no "hurry"; the lint fails the build on these patterns. **¬** A conflicting or unknown deadline is shown as conflicting or unknown, never as the earliest date with urgency copy | 0.5 |
| PI-27 | **No guilt copy** | Product copy follows the spec's calm visual direction ([product](../../product.md)): neutral, specific, and about the next step. **¬** The lint rejects guilt and shame patterns in product strings (for example "don't lose", "you're falling behind", "we miss you", "disappointed", sad-face streak imagery) and loss-framed streak copy | 0.5 |
| PI-28 | **The student controls the engagement features** | Settings has separate switches for the streak (PI-4), XP (PI-6), the daily goal (PI-3) and notifications (PI-8). Each can be turned off without losing any study data. **¬** With all four off, every study mode and insight still works, and no engagement copy appears anywhere | 1 |
| PI-29 | **No ranking against other students by default** | There are no leaderboards and no leagues, and nothing about the student leaves the device for comparison. **¬** No build contains a league or leaderboard surface. Leagues are named here only as a **possible future opt-in** that would need its own spec and a privacy review first. The minimum conditions: opt-in per student; pseudonymous; XP only, never concept states or scores; leave at any time without loss; no demotion or loss copy. It also conflicts with a spec non-goal (§9) | — |

## 6. Data and interfaces

**Where the data lives:** a second storage component, `learning-practice`, registered through the same extension hook as the spec's learning tables (spec §7.1 option A; B02). It has its own migrations and version, and none of the spec's tables change.

| Table | Key and cascade | Fields |
|---|---|---|
| `learning_stars` | (target_kind, target_id); → learning_courses ⊗ | target_kind (`item`\|`card`\|`concept`), created_at |
| `learning_option_tags` | (item_id, item_version, option_id); → items ⊗; → concepts ⊗ | the concept a distractor belongs to (≤1 per option, same course). **Assigned in code after generation,** by matching the option text against concept labels and glossary terms (P12), so the spec's item pipeline (N06) is unchanged. An option that doesn't match is left untagged and never forms a confusable pair. A model proposal is a possible later step, validated the same way |
| `learning_views` | `id`; → resources ⊗ | version, start, end, active_seconds, local_day (notebook reading, for PI-18) |
| `learning_digests` | `id`; deleted by the component's purge step | week_start, body_json, created_at |
| `learning_notifications` | `id`; deleted by the component's purge step | kind, scheduled_for, sent_at (enforces at most one a day) |

**Derived, not stored:**
- The streak, freezes earned and used, XP and the daily-goal status are pure functions of activity days and the settings.
- Rest days, the goal and the switches live in `learning_prefs` (spec §7.2).
- Freezes are **computed,** not granted by a server, so they can't be sold or revoked.

**Purge:** course-keyed rows cascade. The component's purge step deletes `learning_digests` and `learning_notifications`. The spec's purge-completeness test (KM-13) covers these tables automatically, because it enumerates `sqlite_master`.

**Interfaces:** new `LearningRequest` ops, additive to B01's schema and shipped as a follow-up to that PR:
```ts
| { op: "practice.path"; courseId: string }
| { op: "practice.checkpoint"; courseId: string; assessmentId: string }
| { op: "practice.quick"; courseId?: string; minutes: 3 | 5 | 10 }
| { op: "practice.match"; courseId: string; filter?: StudyFilter }
| { op: "practice.star"; targetKind: "item" | "card" | "concept"; targetId: string; starred: boolean }
| { op: "practice.card.edit"; itemId: string; itemVersion: number; front?: string; back?: string; explanation?: string }
| { op: "practice.card.create"; courseId: string; front: string; back: string; anchor?: { resourceId: string; version: number; start: number; end: number }; conceptIds?: string[] }
| { op: "insights.overview"; courseId: string }
| { op: "insights.coverage"; assessmentId: string }
| { op: "insights.errors"; courseId: string }
| { op: "insights.calibration"; courseId?: string }
| { op: "insights.history"; courseId?: string; weeks: number }
| { op: "insights.changes"; courseId?: string }
| { op: "insights.digest"; weekStart: string }
| { op: "insights.view"; resourceId: string; version: number; start: number; end: number; activeSeconds: number }
type StudyFilter = "all" | "starred" | "missed" | "iffy";   // `study.plan` gains `filter?: StudyFilter`
interface Anchor { resourceId: string; version: number; start: number; end: number; label: string; valid: boolean }
interface Insight { kind: "coverage" | "state" | "distractor" | "confusable" | "calibration" | "change" | "next";
  text: string; anchors: Anchor[]; evidenceIds: string[]; counts?: Record<string, number> }
```

## 7. Offline evaluation of the knowledge model before we have students

**Why:** the spec's validation plan (spec §5.10) needs our own students' data, which we don't have yet. Public datasets can test parts of the model now:
- whether the Elo-style estimator predicts the next answer
- whether the bands separate
- whether the decay model predicts recall

**What they can't do:** they can't validate the bands for UW students, and they can't support any learning claim. These datasets come from other populations (K-12 maths, English-test preparation, language learning), and their items have none of our formats or confidence ratings.

### Datasets and licences
**Code licences** were checked via the GitHub API (2026-09-26). **Data licences are separate** and are checked before download. No dataset is committed; they're downloaded into the git-ignored `.data/` folder.

| Source | Code licence | Data | What we use it for |
|---|---|---|---|
| [pyKT](https://github.com/pykt-team/pykt-toolkit), knowledge-tracing toolkit | MIT | ASSISTments 2009 and EdNet, through pyKT's preprocessing. **Each dataset's own terms apply** and are recorded before use (P18) | Next-answer prediction: our estimator against pyKT's baselines, on pyKT's standard splits |
| [Duolingo half-life regression](https://github.com/duolingo/halflife-regression) (Settles & Meeder 2016) | MIT (the repository) | The released learning-traces data; its hosting terms are recorded before use | Decay: predicted recall against actual recall after a delay |
| [FSRS srs-benchmark](https://github.com/open-spaced-repetition/srs-benchmark) | per its repository | Hosted on Hugging Face, **licence unknown**. P21 reads the dataset card first | If the licence permits: FSRS calibration on real review logs. If not: we cite the benchmark's published results and don't use the data |

### What we run
| Run | Models compared | Protocol | What it can show | What it can't |
|---|---|---|---|---|
| **E1: next answer** (ASSISTments 2009, EdNet) | **Ours as specified** (spec §5.3: per-student θ for each skill, the configured `U(n)`, item difficulty fixed at a prior of 0 because the data has no format or Bloom level). **Ours, diagnostic** (the same, with item difficulty learned on the training fold, to measure what fixed priors cost). **Simple baselines:** running accuracy and a constant. **pyKT baselines:** at least DKT and two others from pyKT's standard set | pyKT's standard splits. Multi-skill items use our `ω_c` weights. The configuration (`km-0.1`) is frozen before the test fold is touched; nothing is tuned on it | Whether our estimator ranks and calibrates next answers comparably, and how much the single-student, fixed-prior design costs against population-trained models | Anything about UW courses, the bands' meaning for students, or learning |
| **E1b: band separation** (same data) | Our bands and rules at every step | For each band, next-answer accuracy on items not seen before. Rules tested: R1 and R3. R2 (needs assessments), R4 (needs confidence), R6 (needs formats) and R5 (needs spaced reviews) can't be tested on this data and are reported as untested | Whether Iffy, Getting there and Solid order next-answer accuracy the way their names claim | The thresholds' meaning for our students (spec §5.10 still applies) |
| **E2: decay** (Duolingo HLR data) | FSRS-6 with ts-fsrs 5.4.2 default parameters; half-life regression as published; our concept-track proxy (spec §5.4) | Map each session's outcome to a rating (all correct → Good; otherwise → Again; a stated approximation) and predict recall at each lag. Report how R5's threshold behaves: the observed recall rate for items with predicted `R < 0.80` | Whether FSRS retrievability and our threshold track real forgetting on a large public log | Recall of university course concepts; the rating mapping loses information |
| **E3: FSRS calibration** (srs-benchmark, only if licensed) | ts-fsrs defaults | A sample of review logs; reliability bins of `R` | FSRS calibration on flashcard logs | The same limits as E2 |

### Metrics
- **AUC** (next-answer or recall ranking).
- **Log loss.**
- **Calibration:** 10 equal-width reliability bins, each reporting its count, mean predicted value and observed rate, with the expected calibration error as a one-line summary.
- **Every result reports** the number of students or learners, the interactions and the split.
- **Rules:**
  - no claim beyond what the run can show (the columns above)
  - pyKT baseline results come from our own runs of pyKT, not copied from papers
  - a result where ours loses is reported like any other ([benchmarking](../../notes/benchmarking.md), rule 9)

## 8. Phasing

**Nothing in this addendum is in the Sunday demo.** The demo minimum in [tasks.md](tasks.md) is unchanged.

| Phase | Scope |
|---|---|
| **0.5** (in-app, right after the demo) | PI-10 Learn options; PI-14 star and filters; PI-19 states in insights; PI-25 local by default; PI-26 and PI-27, the copy lint from the first UI string; offline evaluation E1 and E1b (P18, P19), which need no UI and can run as soon as N07 exists |
| **1** | The path, checkpoints, goal, streak with freezes, XP and quick sessions (PI-1–7); Flashcards, Write, Test, Match, editing and own cards (PI-9, PI-11–13, PI-15, PI-16); anchored insights, the coverage map, error patterns, calibration, history and what changed (PI-17, PI-18, PI-20–22, PI-24); PI-28; E2 (P20) |
| **2** | Notifications (PI-8), the weekly digest (PI-23), E3 (P21, only if the licence permits) |

## 9. Where this addendum needs spec.md updated
These are listed rather than changed, because this addendum doesn't edit spec.md.
1. **Leagues vs the spec's non-goals.** Spec §1 lists "leaderboards" as a non-goal. PI-29 keeps them off and names leagues only as a possible future opt-in; pursuing them would mean changing that non-goal first.
2. **The ST-5 streak.** ST-5 defines a streak day as one with an activity. PI-4 adds freezes, rest days and an off switch, which count as streak days without an activity. ST-5 should point to PI-4.
3. **IP-10 notifications.** IP-10 says "at most one opt-in daily reminder". PI-8 keeps that as at most one notification a day **of any kind** (the goal reminder or a checkpoint notice). IP-10's wording should say so.
4. **The attempt `mode` enum** in spec §7.2 (`learn|test|exam|review|diagnostic`) needs `write`, `checkpoint` and `quick`. Match writes **no** attempts, only session time, so it needs no mode.
5. **Star vs Flag.** ST-9's Flag reports an error and quarantines the item; PI-14's Star is a private study mark. Quizlet uses "star" for the study mark as well, so this naming avoids a clash. The spec's wording is unchanged, but UI copy must keep the two apart.
6. **Active time.** PI-3 and PI-22 need active time with idle excluded. The spec's `learning_sessions` has only start and end times, so an activity heartbeat, or the sum of attempt and review times, is needed. P14 uses the sum of recorded response and review times plus reading time from `learning_views`, which needs no spec change.
7. **The renderer scope** (B08) grows with the Practice and Insights surfaces (P17).
8. **Anchor labels.** Lecture, slide or page labels need extraction with `parts` (B05). Until then, anchors point into syllabus and assignment text. The operator's "exactly according to the course materials" is met at passage level now, and at page or slide level after B05.

## 10. Sources (public)
- **Duolingo blog,** "How Duolingo's streak builds habit", 2022-01-31 (vendor-reported A/B results)
- **Settles & Meeder 2016,** "A Trainable Spaced Repetition Model for Language Learning", ACL (half-life regression); code at github.com/duolingo/halflife-regression (MIT)
- **Quizlet** plan pages (quizlet.com, 2026-09-26); **Gemini Notebook / NotebookLM** help pages (support.google.com/notebooklm)
- **pyKT** toolkit, github.com/pykt-team/pykt-toolkit (MIT); **FSRS srs-benchmark,** github.com/open-spaced-repetition/srs-benchmark; **ts-fsrs** 5.4.2 (MIT)
- **Learning research:** Brunmair & Richter 2019 (interleaving), Butterfield & Metcalfe 2001 (hypercorrection), Rawson & Dunlosky 2011 (successive relearning), Van der Kleij 2015 (feedback), Pelánek and colleagues (difficulty targets). All are via the [performance plan](../../notes/performance-plan.md) and [practice evidence](../../notes/practice-evidence.md)
