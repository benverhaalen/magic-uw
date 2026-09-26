# Practice engine: quizzes, exams, preparedness and study sessions

**Status:** design notes, 2026-09-26. Evidence gaps are marked; the research to fill them is in progress (see "Open research").

## What it does
For each upcoming assessment, the engine builds **full practice quizzes and practice exams**. It picks the best source material available, and it says which source it relied on.

**After a quiz:**
- **Run through the results:** by topic, by skill, by error type, with calibration.
- **Generate a new one** in one click, using fresh variants and not repeating items already seen.
- **Tweak it:** topics, difficulty, format, length. The default leans toward the student's biggest struggles in that result.

**Everything is banked:** attempts, study sessions and time on task.

**On top of the bank:**
- a **preparedness model** per topic
- **flashcard sets** built from it: an adaptive, Quizlet-like trainer that's smarter and faster
- **study clocks** that start when a scheduled session is due

## Which sources to rely on (fidelity tiers)
| Tier | Source | Used for | What the student is told |
|---|---|---|---|
| **T1** | practice exams or review sheets from the instructor **this semester** | direct practice + close variants; sets format and difficulty | "Built from your instructor's practice exam" |
| **T2** | **this semester's** exam information (announcement or syllabus: date, format, "covers modules 4–7", allowed materials) + the mapped modules | the **blueprint**: topic weights, format, length | "Built from the Exam 2 announcement and modules 4–7" |
| **T3** | **past years'** exams for the same course (any term or instructor) | style, difficulty and format references; variants of in-scope questions | **"Built partly from Fall 2024 exams. The instructor or format may differ from this semester's."** |
| **T4** | assignments, lecture materials and notes only | content, when nothing above exists | "No exam information yet. Built from your course materials." |

**Rules:**
- **This semester's coverage always sets the scope.** The best available tier sets the format and style.
- **Every past-exam question is checked against this semester's coverage** (L2 Jev: a Noul per question, "covered by this semester's topic list?"). Questions out of scope are dropped, or shown as "may not apply".
- **Topic drift gets a warning.** If a past exam's topic mix differs a lot from this semester's coverage, the warning becomes more prominent.
- **Every item carries its provenance** (tier + source file + page).
- **Never claim prediction.** It's "practice built from…", never "this will be on your exam".

## The quiz lifecycle
1. **Blueprint:** from the highest tier available. Topic weights come from coverage, lecture time, assignment emphasis, and the student's preparedness gaps.
2. **Items:** drawn from the pre-generated pool first, so they're instant (see Speed), topped up by the LLM.
3. **Gates** (Jev, per item; the question design is in `jev-usage.md`):
   - answerable from its cited source: **first a code check that the cited quote exists in the source**, then a Jev Choice: supports / contradicts / doesn't address
   - one correct answer: **one Jev yes/no per option ("is this option correct?"), and code checks that exactly one passes**
   - on-blueprint
   - **distractors are diverse and plausible**, and **the correct option isn't the longest one** by more than a margin (a code check)
   - **not a near-copy of an item this student has already seen:** embedding similarity + Jev. Memorizing reused items inflates scores (the test-bank finding).

   Math and code answers are checked by code or a solver, never by Jev.
4. **Take the quiz:** timed or untimed. A **confidence rating before each answer is revealed** gives calibration data.
   - Its value is calibration and targeting: confident errors get the fullest feedback and come back first (hypercorrection). It isn't a learning boost in itself.
   - **Typed answers are graded by meaning, not wording:** a Jev yes/no per key idea in the answer key. This fixes the top complaint about written answers in existing tools.
5. **Results:**
   - score by topic and skill
   - error types (concept / procedure / careless / misread)
   - **calibration** (confident but wrong = over-confident topics)
   - a link back to the source slide for every miss
6. **Next:**
   - **New quiz** (fresh variants, no repeats of seen items)
   - **Tweak** (sliders; defaults to the weakest topics)
   - **Make flashcards from my misses**
7. **Bank:** each attempt, item, response, confidence, time and outcome goes into the Vault.

## Preparedness model (evidence in `practice-evidence.md` §3–4)
- **Method: an Elo-style skill rating per topic,** updated after every exam-style answer. Why Elo:
  - About 10 answers give a usable estimate.
  - It's close to IRT in accuracy and nearly free to compute.
  - BKT needs data from 50–100 students, and we have one.
- **Item difficulty starts from a prior:** a Jev Score over the item text (Bloom level and steps), since text-based difficulty estimation works before anyone answers. It's refined slowly as the student's own answers come in.
- **FSRS retrievability** (`get_retrievability` in ts-fsrs) is a *separate* recall-strength signal for flashcards. It isn't treated as mastery; FSRS is unvalidated as a mastery measure.
- **Readiness for an assessment** = mastery weighted by that assessment's coverage, measured on **unseen, exam-style items**, not on repeated cards. This avoids the fluency illusion.
- **Shown as bands, not fake probabilities:** solid · shaky · untested · over-confident.
  - **The band thresholds are unvalidated hypotheses.** Until they are measured, a topic stays **untested** below about 10 unseen exam-style answers (the Elo evidence above), and bands don't drive blueprint decisions on their own. Readiness for an assessment is deferred until coverage and response evidence are adequate and the band meaning is validated ([performance plan](performance-plan.md) §3.6).
  - **Over-confident** = confident but wrong more than the student's own base rate.
- **The "how ready do you feel?" check is delayed** (asked at the start of the next session, not right after studying). Delayed judgments of learning are far more accurate (g=0.93).
- **It drives everything downstream:** quiz blueprints, flashcard deck makeup, study-session content, and the order of the "Up next" dossier.

## Flashcards: an intelligent trainer
- **Decks are generated per assessment,** weighted toward shaky and over-confident topics. The cards come from:
  - lecture-note blanks
  - self-questions
  - **mistake cards** (from wrong answers)
  - generated cards (gated)
- **Modes:**
  - **Learn:** adaptive rounds that move from recognition to recall (multiple choice → typed answer)
  - **Review:** FSRS spacing aimed at the exam date
  - **Test:** mixed formats
- **What makes it better than Quizlet-style tools:**
  - course-scoped
  - built from the student's own weak spots
  - scheduled to the actual exam date
  - pre-generated, so there's no waiting

## Study clocks (evidence in `practice-evidence.md` §5)
- **The timing comes from spacing and successive relearning, which have strong evidence,** not from Pomodoro, which has no evidence of better exam scores.
- **Study sessions are scheduled into free gaps in the calendar** before each assessment (class times come from the schedule), following the spacing plan.
- **The clock is a focus timer with flexible breaks.** The student can take structured breaks (fixed breaks raised concentration in one study) or break when ready (self-directed scored higher in another). It's never sold as a learning method.
- **When a session is due,** a notification offers to start a **study clock**: a focus timer with a queued plan (e.g. 12 review cards → one 10-question mini-quiz on the shakiest topic).
- **Sessions are banked:** planned vs actual, items done, outcomes. The plan adapts to them.

## Speed and intelligence: why it beats public tools
- **Pre-generation:** when an assessment appears, its blueprint and an item pool are built in the background, soonest assessment first. **"New quiz" draws from the pool instantly.**
- **Typed checks** (Jev) gate every item in the background, so gating never slows the student down.
- **The LLM writes items only.** Scope, blueprint, scheduling and scoring are code plus Jev.
- **Local bank:** results, preparedness and sessions live on the laptop and are instant to query.
- **Course intelligence public tools lack:**
  - which exam covers what
  - whether a practice source is current
  - the student's own error history

## Blueprint: format vs transfer
- Match the real exam's format when T1 or T2 gives it. Matching increases the testing benefit.
- **Also include application and transfer items.** Testing transfers (d=0.40), and questions that require transfer can help as much or more.
- **Mix topics within a quiz (interleaving, g=0.42),** except in a student's first pass on a brand-new topic.

## Answer keys (open risk)
- Nobody has published the error rate of LLM-generated answer keys.
- **For math and code:** check by running code or solving independently with a second model; items that disagree are dropped.
- For everything else: gate that the key is supported by the cited source.

## Open research (Opus lead, Sonnet retrievers): done 2026-09-26; see `practice-evidence.md`
1. What Quizlet, Anki, Knowt, Gizmo, StudyFetch and similar tools do for practice tests and adaptive learning, and what students complain about.
2. Estimating preparedness in practice: BKT, Elo, IRT / adaptive testing, FSRS. Calibration from confidence ratings, interleaving, and study-session timing (including whether Pomodoro-style timing has evidence).
3. Generating exam questions from past exams with LLMs: variants, difficulty control, distractor quality, validity; the effect of practice tests that match the real exam's format; staleness across semesters.
