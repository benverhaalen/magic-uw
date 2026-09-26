# Course notebook and study tracking: product and technical specification

**Status: proposed specification with stated decisions.** Written 2026-09-26 against `main` at `73ff7a6` (Ben's build; the code is unchanged since). Nothing here is built unless it is labelled **built**.

**Ownership:** changes to Ben's packages (contracts, storage, core, ai, connectors, apps) reach `main` only as PRs he merges, each with its rationale (tasks Part B). That's how code lands. It doesn't reopen a decision the evidence already settled ([where we differ](../../notes/where-we-differ.md)).

**Labels used throughout:**
- **built:** present in the code at `73ff7a6`
- **Decision:** settled, by the operator or by the research, with its evidence named
- **proposed:** this specification's design, not yet built
- **measure first:** genuinely open until our own measurement decides it. Only three items qualify:
  - embeddings and hybrid retrieval (G4)
  - structural headers stored at ingest (G5)
  - `typesafe/jev-router` as the default model (G10)
- **researched:** taken from a cited public source; it is not our measurement

**Companions:** [tasks.md](tasks.md) (the build tasks), [complete app plan](../2026-09-26-complete-app/plan.md), [backend map](../../notes/backend-map.md), [where we differ](../../notes/where-we-differ.md).

---

## 1. Summary, goals and non-goals

### Summary
Magic Canvas builds a notebook for each course the student takes, in the style of NotebookLM, from what it has already captured from Canvas. The student uploads nothing. The notebook has:
- a sources panel
- grounded chat whose citations code has checked
- a notebook guide (study guide, briefing, FAQ, glossary, timeline)
- a mind map
- an answer to "what does Exam 2 cover?"
- flashcards and quizzes generated from the sources

Around the notebook sit Quizlet-like study modes:
- flashcards scheduled with FSRS
- Learn, which moves from multiple choice to typed recall
- practice exams labelled by source fidelity
- a Duolingo-like course path
- a mistakes queue

Underneath both sits the **knowledge model**. It records what the student has shown they know for each concept of the course, and which concepts are still **iffy**, with reasons. It decides what the next session contains, which flashcards come first, how a practice exam is weighted, and which topics the study guide emphasises. It shows four states: **Solid · Getting there · Iffy · Not seen yet**. It never shows a probability of passing.

### Product decisions
| Decision | Evidence and detail | What it supersedes in [decisions](../../decisions.md), and how code lands |
|---|---|---|
| Build the complete app, not only a demo (operator) | [complete app plan](../2026-09-26-complete-app/plan.md) | — |
| A one-time $5 purchase. The payment provider isn't chosen (operator) | [business model](../../notes/business-model.md) | The repo is MIT, so closed distribution needs the licensing change recorded there |
| **A paid AI provider is required** (operator). Four routes:<br>• the student's own Claude Code (Pro or higher)<br>• Codex (a paid ChatGPT plan)<br>• Gemini CLI with a paid API key<br>• an OpenRouter key used through Claude Code<br>The app reuses the CLI's existing login. Our own MCP server of coarse tools does the bulk work in code, and Jev makes the typed choices | [agent runtime](../../notes/agent-runtime.md): the free Claude plan excludes Claude Code; unpaid Gemini keys let Google use the content; Gemini CLI OAuth in third-party tools risks suspension | It supersedes "no paid-plan prerequisite" and "local AI as the default alternative". The runtime lives in our own package; the worker wiring is a Part B PR |
| **Disclosure without friction** (operator; §9.2) | [agent runtime](../../notes/agent-runtime.md), [where we differ, row 16](../../notes/where-we-differ.md) | It replaces the blocking preview before every hosted request with consent once per provider, a context chip and a receipt |
| **No per-student Jev budget;** only the gateway's global abuse cap. OpenRouter-key users pay their own Jev (operator) | [business model](../../notes/business-model.md) | Budget settings in Ben's gateway change through a Part B PR |
| Notes are local `.docx` files by default (operator) | [notes targets](../../notes/notes-targets.md) | — |
| The Part B seams in tasks.md: a routed command, the storage extension hook, learning jobs, Canvas coverage, passages, and the OR query (research decisions D1–D9) | [learning features plan, Track 2](../2026-09-26-learning-features/plan.md) | Each goes to Ben as a PR with this spec as the rationale |

The knowledge model, the grounding checks and the study modes are provider-neutral. Only the generation step depends on the route (§9).

### Goals
| # | Goal | Observable outcome |
|---|---|---|
| G1 | A notebook with no upload step | Every captured course has a notebook whose sources are that course's live resources |
| G2 | Answers the student can check | Every citation shown has passed a code check that its quote exists in that source version. Unsupported questions get an honest "couldn't find support" |
| G3 | Practice that remembers | Every answer, card review and self-rating is stored locally as evidence, and survives restarts |
| G4 | An explainable picture of what's iffy | Every concept shows a state, the rules behind it and the evidence counts |
| G5 | Truthful labels | Every check label names the check that ran. No generic "verified" badge |
| G6 | Personalisation stays on the device | The knowledge model runs in local code. Providers receive course text, not performance data, unless the student consents |

### Non-goals
- Pass probabilities, predicted grades, readiness percentages or "this will be on your exam" ([product principle 9](../../product.md)).
- Claims that Magic Canvas improves learning. We cite studies for design choices; gains are ours only after our own measurement ([performance plan](../../notes/performance-plan.md)).
- Producing graded work, or using an open graded assignment as practice ([integrity roles](../../notes/integrity-roles.md)).
- Uploads as the main path. Import stays available only for explicitly labelled imported material.
- Video overviews. Audio overviews are a Phase 2 option (§12).
- Leaderboards, "lives", streak paywalls or pooled data across students.
- Choosing among the [six organizing concepts](../../product-directions.md). The notebook is a per-course surface that any of them can open.
- An in-app Word editor. Notes open in the student's own `.docx` app.

---

## 2. Users and jobs

The three students are fictional composites. They cover different course shapes; they are not measured users.

| | CS student | Humanities student | Lab-science student |
|---|---|---|---|
| **Course** | An algorithms course: slide PDFs, problem sets, two midterms and a final, one practice exam posted by the instructor this term | A U.S. history survey: chapter readings, image-heavy lecture slides, discussion sections, an exam of term identifications plus an essay | Organic chemistry with a lab section: lecture notes, problem sets, a lab manual, graded pre-lab quizzes, exams with mechanisms and yield calculations |
| **Typical course AI policy** (UW templates, [integrity roles](../../notes/integrity-roles.md)) | "Allow AI in certain circumstances" | "Prohibit AI unless otherwise specified" | Not stated in the syllabus |
| **Jobs** | "What does Midterm 2 cover, and where is the recurrence method defined?"<br>"Drill me on algorithm tracing; grade my typed answers by meaning." | "Give me the term IDs with dates and significance, as flashcards and a timeline."<br>"Which readings argue what, for the essay question?" | "Which reactions are on Exam 2?"<br>"Mechanism recall cards; check my yield arithmetic." |
| **What must not happen** | A problem-set answer produced while the set is open | An essay paragraph written for the student; practice generated without showing the course rule | An open pre-lab quiz used as a practice source; a structure-drawing question pretended to be gradable as text |
| **What the notebook can't do yet** | Nothing extra, once slides are captured | Image-only slides are skipped until extraction handles them (labelled) | Structure drawing isn't supported. Numeric answers are checked by code |

**The job all three share:** "Show me which topics I'm shaky on, and make the next 15 minutes count."

---

## 3. Experience

### 3.1 Entry point
- **Course → Notebook** and **Course → Study**: two tabs on each course's view.
- **An assessment → "Prepare"** opens Study scoped to that assessment (practice exam, coverage, due cards).
- **"Study now"**, wherever the home view places it, builds a session across courses (J3).

No new top-level navigation is added until Ben picks an organizing concept.

### 3.2 Default state: a synced course with a connected provider
| Area | Contents |
|---|---|
| **Sources (left)** | The course's resources grouped by module (or by kind until modules are captured). Each row shows its kind, title, "captured ⟨time⟩", an include toggle and a source label: *Canvas*, *Imported: ⟨label⟩* or *Synthetic*. A coverage line underneath reads, for example, "Canvas files and pages aren't captured yet". |
| **Notebook (centre)** | Guide cards: Study guide, Briefing, FAQ, Glossary, Timeline, Mind map, and "What does ⟨next assessment⟩ cover?". Below them, the chat box. Guides for a course with an assessment in the next 14 days are prebuilt in the background. Other guides show **Build**. |
| **Your topics (right)** | Counts per state, for example "4 Iffy · 6 Getting there · 3 Solid · 9 Not seen yet". The Iffy concepts are listed with their first reason. **Study now (15 min)** sits at the bottom. |

### 3.3 Journeys

**J1: First sync → notebook ready**
1. The student signs in to UW and Canvas syncs (**built**: profile, courses with syllabus, assignments).
2. Code splits each resource version into passages with offsets (`learning.passages`).
3. Code lists concept candidates from module names, lecture titles and syllabus schedule headings. The student's AI proposes a concept map from them. Code validates the map: every concept's quote must exist in its source, and there must be at least one unit (`learning.concepts`).
4. The course appears as "Notebook ready · 23 sources · built from Canvas syllabus and assignments". The guide cards for the nearest assessment fill in as their jobs finish.
5. **Success:** the notebook opens before any generation finishes. Sources and search work from code alone. First paint never waits for a model ([product principle 5](../../product.md)).

**J2: Ask a question**
1. The student types "Where is the master theorem stated, and what are its cases?"
2. Code retrieves the top passages for the course (course-scoped BM25 over passages, §6.2). A context chip shows which sources are used (§9.2).
3. The student's model drafts an answer in which every factual sentence cites a passage and quotes it.
   - **Phase 0:** the app inlines the retrieved passages into the prompt (N03 with an injected `generate`).
   - **From Phase 1:** the CLI calls `materials_search` and `citations_check` through the MCP server.
4. The app checks each quote again against that resource version. A sentence whose quote isn't found is removed and a note appears: "1 sentence removed: its quote wasn't found in the source (show)".
5. The answer shows its citations, "Checks: quotes found in source · support not checked", scope ("searched 23 captured sources; files not captured") and freshness.
6. **If support is weak,** the answer reads: "I couldn't find support in the captured material I searched" (§6.1), with the scope and the missing sources.

**J3: Build a study session**
1. The student clicks **Study now** (default 15 minutes, difficulty *Normal*).
2. Code builds the plan from the knowledge model (§5.7). The plan shows its blocks with reasons, for example:
   - "2 confident misses to retry"
   - "8 due cards (Exam 2 in 6 days)"
   - "Learn: Recurrences (Iffy: recent lapse)"
3. The student works through the session. Confidence is asked before each answer is revealed. Drills give feedback straight away, with an explanation quoting the source and a line on why the tempting option was tempting.
4. The session ends with "What changed": the states that moved and why, observed counts ("7 of 9 right without hints") and the next due date. XP and the streak update. They are labelled engagement, not learning.

**J4: Take a practice exam**
1. From the Exam 2 card, the student chooses **Practice exam**.
2. Code picks the best available tier (§4, ST-4). The exam header states its tier, for example: "Built from the Exam 2 announcement and modules 4–7 (T2)" or "Built partly from Fall 2024 exams. The instructor or format may differ from this semester's (T3)".
3. The blueprint follows the stated coverage. The student can switch on **Lean toward my iffy topics** (§5.7).
4. The exam is untimed by default; exam conditions are opt-in. Feedback comes at the end.
5. Results are shown by concept as observed counts, with links to the source for every miss. Misses enter the mistakes queue, and "Make flashcards from my misses" is offered.

**J5: See iffy topics**
1. **Your topics → Iffy** lists each concept with its rules and counts, for example: "Iffy: you were sure and got it wrong on 26 Sep (Recurrences Q4); 2 lapses on cards this week. Evidence: 6 answers (4 without help), 11 card reviews."
2. Each concept offers:
   - **Why?** The evidence rows, and what would change the state ("Get the next 2 right without hints").
   - **Practise this:** a 5-minute Learn round.
   - **Open in study guide**
3. A **How this works** panel explains the rules. It says plainly: "These thresholds are starting guesses we haven't validated. This is not a grade or a prediction."

**J6: Recover from a wrong citation or a bad item**
- **Wrong citation:** the student clicks the citation → **This citation is wrong** and picks one of: *the quote isn't there*, *it doesn't support the claim*, *wrong source or version*.
  - Code re-checks the quote at once and shows the result.
  - The dispute is stored. The answer is regenerated without that passage, and cached answers that used it are bypassed.
- **Bad item:** during practice, the student clicks **Flag this item** and picks one of: *wrong key*, *two correct answers*, *no correct answer*, *unclear*, *off topic*, *not from my course*, *my answer was graded wrong*.
  - The item is quarantined at once and removed from every queue.
  - Attempts on it are excluded from the knowledge model.
  - A replacement is generated when the provider is available.
  - **Undo flag** restores all of it.

### 3.4 States other than the default
| State | What the student sees | What still works |
|---|---|---|
| **Empty** (no courses) | "Connect Canvas" and "Import a course file". The sample course is labelled *Synthetic* (**built**) | Nothing course-specific |
| **No provider connected** | "Connect an AI client to ask questions and generate study material" (Settings ▸ Connect) | Sources, passage search, existing items, cards, the knowledge model and coverage statements found by code |
| **Local-only privacy mode** (the **built** default until a provider is connected) | Hosted features say "Connect ⟨provider⟩ to use this". Connecting shows the one-time consent screen (§9.2) | The same as "no provider" |
| **Stale** | "Built from sources as of 20 Sep · 2 changed since · Rebuild". Items from a changed source are paused as "source changed" | Everything else. Stale artifacts are never shown unlabelled |
| **Partial capture** | "Some of this course couldn't be read (⟨reason⟩). Answers may miss material." Earlier data is kept (**built** partial semantics) | Everything, on the data that is present |
| **Signed out of UW** | The **built** reconnect prompt. The notebook stays usable from local data | Everything except refresh |
| **Provider limit or sign-in lost** | "⟨Provider⟩ reported a usage limit" or "Sign in again". Nothing is retried in a loop | Practice on existing items, cards and the knowledge model |
| **Course policy prohibits AI** | A banner quoting the syllabus sentence. The practice generator "shows the rule and asks" ([integrity roles](../../notes/integrity-roles.md)). The tutor is blocked on graded items | Cards and items the student made or confirmed |
| **Too little material** | "Only the syllabus and assignment descriptions are captured. Guides will be thin." No padding with general knowledge | Coverage from the syllabus |

---

## 4. Functional requirements

Every requirement is **proposed**. Acceptance criteria are observable behaviour. Criteria marked **¬** are negative cases that must hold.

**Phases** refer to §12:
- **0** means the headless demo minimum.
- **0.5** means in-app right after the demo.
- **1** and **2** as in §12.

### 4.1 Notebook (NB)
| ID | Requirement | Acceptance criteria | Phase |
|---|---|---|---|
| NB-1 | **An auto-sourced notebook** per course, keyed by account scope and course ID, made from that course's live resources | After a sync of course A, its notebook lists every live resource of A with kind, title and capture time. **¬** A resource of course B never appears in A's sources, retrieval or citations. **¬** A resource marked deleted shows "removed from Canvas on ⟨date⟩" and isn't used for new answers | 0 |
| NB-2 | **A sources panel** with an include toggle, freshness, a source label and coverage gaps | Excluding a source removes it from retrieval on the next question, and the exclusion persists after a restart. **¬** Imported material is never labelled *Canvas*. **¬** Sample data is always labelled *Synthetic*. **¬** Nothing that wasn't fetched appears as if it exists (e.g. files when files aren't captured) | 0.5 |
| NB-3 | **Passages with offsets** for each resource version | Joining a version's passages reproduces its `text` exactly. Every passage carries `resourceId`, `contentHash`, `start`, `end` and `heading`. **¬** After a new version, old passages aren't offered for new citations | 0 |
| NB-4 | **Grounded chat with code-checked quotes** | Every displayed citation's quote occurs at its stated offsets in its stated version. **¬** A quote the model invented, paraphrased, or took from another version or course is rejected with no fuzzy repair; its sentence is removed with a visible "show" note | 0 |
| NB-5 | **Honest not-found** | When retrieval finds no passage above the support threshold, the reply is "I couldn't find support in the captured material I searched" plus the scope and missing source types. **¬** No answer text is generated for that question | 0 |
| NB-6 | **Quote validity and claim support are separate** | Each answer shows quote validity (code) and support status (*judged by Jev*, *judged by ⟨model⟩ in a separate check*, or *not checked*) as separate labels. **¬** The UI never shows a single "verified" label | 0 (labels); 1 (support checks) |
| NB-7 | **A policy gate on chat** | With `policy.mode = restricted`, a question about that item returns the refusal and an allowed next step, with zero model calls (as `generate()` does, **built**). A question matching an open graded assignment (IP-2) switches to tutor mode: hints, no final answer. **"Matches" means** the Jaccard similarity of normalised word trigrams between the question and any 60-word window of the assignment text is ≥ 0.25, or the question contains an exact span of 12 or more words from it. Both are starting values, recall-leaning and unvalidated, and live in the N00 config. **¬** "My professor said it's fine" never loosens the mode. **¬** A question sharing only the assignment's topic words, below the threshold, isn't switched | 0 |
| NB-8 | **The notebook guide:** study guide, briefing, FAQ, glossary, timeline | Each is structured JSON rendered by code. Every entry has at least one quote-valid citation. Timeline dates parse, and each date string occurs in its quote. Each guide is cached by its source versions (§9.3). **¬** An entry whose quote fails is dropped and counted in "N entries removed". **¬** A guide built from older versions is shown only with the stale label | 0.5 (study guide); 1 (the rest) |
| NB-9 | **Study guide emphasis from the knowledge model** | Iffy concepts are marked "Iffy for you" and expanded with 2 self-check questions. Solid ones are collapsed. The order follows the modules. A state change re-renders the emphasis without regenerating the text. **¬** With no evidence, no concept is marked. **¬** Emphasis never shows a number for ability or probability | 1 |
| NB-10 | **A mind map** of the concept map (units → concepts), rendered with markmap | Each node opens its concept detail and its sources. A student's rename, merge or hide shows on the next render. **¬** A concept without a valid source quote is shown as "suggested by AI, no source found", never as an ordinary node | 1 |
| NB-11 | **Exam coverage:** "What does ⟨assessment⟩ cover?" | The reply states its basis:<br>• *stated by the instructor*, with the quote (T1/T2)<br>• *inferred from the schedule window* since the previous assessment<br>• *mapped by AI*, labelled<br>It lists the concepts and materials with reasons, and what's missing. **¬** It never says "will be on the exam". **¬** With no coverage statement, it says so first | 0.5 (syllabus statements); 1 (announcements, Jev mapping) |
| NB-12 | **Generate flashcards or a quiz from the notebook** ("from this section", "for this concept") | Generated items go through the checked-item pipeline (§6.3) into Study with provenance. **¬** No item is served before its code checks pass | 0.5 (quiz); 1 (flashcards) |
| NB-13 | **Freshness propagation** | After a sync that changes a resource, every artifact, item and card that cites it is marked stale before the next render. An item whose quote no longer exists in the new version is quarantined as "source changed". **¬** A card from a changed source is never served unchanged | 0.5 |
| NB-14 | **Disclosure without friction** (§9.2): consent once per provider; a context chip and a receipt on every hosted call; a blocking preview only for a new sensitive category or with "Always preview" on | After consent, a chat request sends without a blocking dialog, shows a chip listing its sources (it opens the exact payload), and writes a receipt (**built** receipt type). The first request that would send `student_work` or `learning_state` blocks on a preview of the exact payload. **¬** In `local_only` mode, no hosted call is made. **¬** With "Always preview" on, every request blocks until approved. **¬** Declining a sensitive-category preview sends nothing, and the feature falls back (e.g. code-only grading, labelled) | 0.5 |
| NB-15 | **Export a guide to `.docx`** in the local notes tree | The export writes to the course's notes folder and opens in the default app. Citations become footnotes with source titles. **¬** Nothing is written to a cloud folder unless the student chose that target | 1 |
| NB-16 | **Student notes as sources** (opt-in) | The student's `.docx` notes for a course can be included as sources, labelled *Your notes*. **¬** They're never sent to a provider unless `shareStudentWork` is on | 2 |
| NB-18 | **Course AI policy from the syllabus** (code first). Today every Canvas resource arrives with `policy: {mode: "unknown"}`, hard-coded at `canvas.ts:269` and `:442` (**built**), so without this every course falls back to coach mode | Code finds UW's three syllabus templates by phrase ("Allow AI with documentation and citation" → `allowed` + AI-use log; "Allow AI in certain circumstances" → `coaching`; "Prohibit AI unless otherwise specified" → `restricted`), plus nearby sentences mentioning AI, ChatGPT or generative tools. It stores the mode, a quote with offsets and the syllabus version. A stricter result applies at once. A looser one applies only after the student confirms the quoted sentence. **¬** No match gives `unknown` (coach mode), never `allowed`. **¬** A new syllabus version re-runs extraction, and a looser result waits for confirmation again. **¬** Text in an assignment description can't loosen the course policy | 0 |
| NB-17 | **An audio overview** (option) | A script built from the study guide, keeping its citations. The player shows "AI-generated audio from ⟨sources⟩". **¬** The script is never built from material outside the notebook's included sources | 2 |

### 4.2 Study modes (ST)
| ID | Requirement | Acceptance criteria | Phase |
|---|---|---|---|
| ST-1 | **Only checked items are served** | Every served item has passed the code stages of §6.3, and its check line lists exactly the checks that ran and passed. **¬** An item whose quote check fails is never served; the drop reason is logged | 0 |
| ST-2 | **Flashcards with FSRS** (ts-fsrs, MIT; researched: [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)) | Ratings are Again, Hard, Good or Easy. The next due date comes from ts-fsrs with desired retention 0.90. Each rating writes an immutable review log. When a card covers an assessment within 14 days and its next due date is later than one day before that assessment, code adds a pre-exam review at the later of now and two days before the assessment. The FSRS state isn't edited. **¬** **Undo** restores the previous card state from the log and never deletes the log row silently (the undo is logged too) | 1 |
| ST-3 | **Learn:** adaptive rounds that move from multiple choice to typed recall (the pattern of Quizlet Learn; researched: [quizlet.com/features/learn](https://quizlet.com/features/learn)) | A round holds 7 **item families**. A family is a set of **linked item variants** testing the same key idea from the same sources: an MC variant and a typed (or cloze) variant with one `family_id`. Each variant is its own item, with its own format, difficulty prior and checks, and each attempt is recorded against the variant it used. The family starts at its MC variant and moves to the typed variant after one correct answer. A miss moves it back one stage, and it reappears after at least 2 other items. Typed answers are graded against a key-idea checklist (§6.3). **Flag this grade** stores a dispute. **¬** The typed stage never shows the options. **¬** A grade isn't exact-wording only: code accepts case, whitespace, punctuation and listed synonyms | 0.5 |
| ST-4 | **Test / practice exam with fidelity tiers T1–T4** ([practice engine](../../notes/practice-engine.md)) | The tier comes from the best source available:<br>• **T1:** this term's instructor practice exam<br>• **T2:** this term's exam information plus mapped material<br>• **T3:** past terms' exams<br>• **T4:** course materials only<br>This term's coverage always sets the scope. The header and every item show the tier and provenance. T3 shows the past-term warning. The exam is untimed by default, with feedback at the end. **¬** A T3 question outside this term's coverage is dropped or shown as "may not apply". **¬** No score prediction is shown | 1 (T4 in 0.5) |
| ST-5 | **A Duolingo-like course path** (engagement only) | Units follow module order, with one lesson per concept (a Learn round). XP is awarded for completed activities. The streak counts local calendar days with at least one completed activity. Progress bars show lessons completed. **¬** There are no lives or lockouts, and a lost streak never blocks content. **¬** XP, streaks and progress are never labelled as learning, mastery or readiness. **¬** The product carries no copy claiming learning gains | 1 |
| ST-6 | **A mistakes review queue** ([performance plan §3.7](../../notes/performance-plan.md)) | Every unassisted miss enters the queue, confident misses first. Each spaced, unassisted success (a day or more after the last one) lowers its priority. Nothing retires permanently. "Make flashcards from my misses" creates cards linked to the original items. **¬** A quarantined or disputed item leaves the queue at once and doesn't return | 0.5 |
| ST-7 | **A session builder** ("Study now") | Given a number of minutes (5–120) and a difficulty, the plan follows §5.7 and states a reason for each block. **¬** With no evidence, the plan is a labelled, skippable diagnostic of 8 items or fewer across the units. **¬** The planned length never exceeds the requested minutes by more than one item | 0.5 |
| ST-8 | **Confidence before the reveal** | A 4-step scale (Guess, Unsure, Fairly sure, Sure → 0, 0.33, 0.67, 1.0) appears before the answer is revealed in Learn and Test. It can be skipped, and it's off in quick card review. **¬** Confidence is never collected after the reveal. **¬** A skipped rating is stored as `null`, not as a default value | 0 |
| ST-9 | **Flag and replace an item** | On flagging, the item is quarantined within the same command, its attempts are excluded from the knowledge model, and a replacement job is queued. **Undo** reverses all three. **¬** A flagged item never reappears in any mode while the flag stands | 0 |
| ST-10 | **Explanations on every item** | Each item carries an explanation quoting its source, and a "why that option was tempting" line for MCQs. Drills show it at once; exams at the end. **¬** No explanation is shown without a quote-valid citation | 0 |
| ST-11 | **Practice works without the provider** | With the provider disconnected, existing items, cards, the queue and the path all work. Generation shows reconnect. **¬** A missing provider never fails a practice session that doesn't need generation | 0.5 |
| ST-12 | **A hint ladder that is logged** | A hint reveals the smallest next step and marks the attempt `assistance: "hint"`. "Show answer" marks it `explained`. **¬** A hinted or explained correct answer never counts as unassisted evidence (§5.2) | 0.5 |

### 4.3 Knowledge model (KM)
| ID | Requirement | Acceptance criteria | Phase |
|---|---|---|---|
| KM-1 | **A concept map for each course** (units → concepts), built from modules, lecture titles and the syllabus | Every concept has at least one quote-valid source or is marked "suggested by AI, no source found". The student can rename, merge, hide and restore concepts, and those edits survive rebuilds. **¬** A rebuild never overwrites a student edit. **¬** A concept never links to another course's items | 0 |
| KM-2 | **Items tagged to 1–3 concepts**, with one primary | Code validates that the tags exist, belong to the same course and number 1–3. The student can retag an item. **¬** An item with 0 or 4 tags, or an unknown or other-course concept ID, is rejected. **¬** A retag doesn't rewrite past evidence; the attempt stores the tags as they were | 0 |
| KM-3 | **Evidence events**: attempts, card reviews, self-ratings | Attempts record correctness (or a key-idea score), assistance, confidence, format, response time, mode, item version and tags. Reviews record the rating and the FSRS state before and after. Self-ratings record the rating and whether it was delayed. All are immutable. Disputes are separate rows. **¬** A write missing a required field is rejected. **¬** An attempt ID can't overwrite existing evidence (**built** rule for `attempts`) | 0 (attempts); 1 (reviews, self-ratings) |
| KM-4 | **Deterministic per-concept state** | The state is a pure function of the ordered events, the configuration version and "now" (§5.3). Replaying the same events gives the same state. **¬** Excluded events (assisted, disputed, quarantined, repeated in the same session) don't move the ability estimate | 0 |
| KM-5 | **Explicit iffy rules R1–R6** (§5.6) | Each rule fires on its stated condition and produces its reason text with evidence counts and event IDs. **¬** Each rule has a test where it must not fire (see §5.6) | 0: R1–R4; 1: R5–R6 |
| KM-6 | **Student-facing states:** Solid · Getting there · Iffy · Not seen yet | Every concept shows its state, its reasons and its evidence counts (answers, answers without help, card reviews, self-ratings). The "How this works" panel labels the thresholds as unvalidated. **¬** No student-facing result type, and no string the product itself writes (labels, state chips, reasons, templates), contains an ability value, a probability or a percentage about passing or readiness. A test scans the result types and the renderer's own strings. Quoted course text and model sentences shown as quotes are out of scope | 0 |
| KM-7 | **The state drives study** | One priority function (§5.7) orders the next session, prioritises flashcards, weights the "lean" practice exam and sets the study guide's emphasis. **¬** With no evidence, only coverage and module order set priorities, and the UI claims no personalisation | 0.5 (session); 1 (the rest) |
| KM-8 | **Explanations** | "Why?" lists the rules that fired, the evidence rows (date, item, outcome, assistance, confidence) and a concrete clearing condition. **¬** A reason never cites an excluded event | 0 |
| KM-9 | **Cold start** | Every concept starts as *Not seen yet* with θ = 0. Item difficulty starts from priors (§5.8). An optional diagnostic of 8 items or fewer can be skipped at any point. **¬** A self-rating alone never moves a concept out of *Not seen yet* | 0 |
| KM-10 | **Decay** | Retrievability is recomputed on read from FSRS stability and the time since the last review, so a concept can become Iffy (R5) with no new events. **¬** A concept with no cards and no scored attempts never triggers R5 | 1 |
| KM-11 | **Self-ratings stay separate from performance** | A delayed self-rating ("How well do you know ⟨concept⟩?", asked at the start of the next session, because delayed judgments of learning are far more accurate than immediate ones: Rhodes & Tauber 2011, g = 0.93, researched) is stored and shown beside the state. "I know this" offers a 2-item check. **¬** A self-rating never changes the state by itself | 1 |
| KM-12 | **Versioned configuration** | Thresholds and constants live in one versioned configuration. The state records the version it used. Changing the version recomputes by replay. **¬** Two versions are never mixed in one displayed state | 0 |
| KM-13 | **Covered by purge** | "Delete local data" removes all concepts, evidence, cards, states and artifacts. **¬** After a purge, every table is empty: the test enumerates `sqlite_master`, excludes FTS5 shadow tables and `schema_components`, and counts FTS rows through the virtual tables (§7.3). **¬** A cross-course session (null course) is deleted too | 0.5 |

---

## 5. The knowledge model

**Status: proposed.** The formulas below are design choices informed by cited work. Every constant is a **starting value that hasn't been validated**, and the UI says so.

### 5.1 State
**Stored per course:** the concept map (§7).

**Computed per concept `c`** (cached, and rebuildable by replay):
| Field | Meaning | Shown to the student? |
|---|---|---|
| `θ_c` | Ability estimate in logits (Elo-style) | No |
| `n_c` | Effective count of scored evidence | As "N answers (M without help)" |
| `acc_c` | Observed unassisted accuracy over the last 10 or fewer scored attempts (score-weighted) | As counts ("7 of 9 right without hints"), never as a percentage |
| `s_c` | **Evidence spread:** a margin that shrinks as evidence grows | No |
| `p̂_c`, `p_low`, `p_high` | Internal expected success on a reference item, with a heuristic margin either side (**not** a statistical interval) | **Never** |
| `R_c` | Retrievability now (FSRS) | No. It appears in a reason only as "due for review" or "fading" |
| `band` | Solid · Getting there · Iffy · Not seen yet | Yes |
| `reasons[]` | The rules that fired, with event IDs | Yes |
| `counts` | Answers, unassisted, correct, card reviews, self-ratings | Yes |
| `configVersion` | Which constants were used | In "How this works" |

### 5.2 Evidence and what counts
| Event | Stored as | Moves `θ`? | Counts toward `n_c`? |
|---|---|---|---|
| Unassisted attempt, first exposure to the item | `learning_attempts` | yes, weight `v = 1` | `v · ω_c` |
| Unassisted attempt on an item seen in an earlier session | same | yes, `v = 0.5` | `v · ω_c` |
| Repeat of the same item in the same session | same | no | no |
| Attempt with `assistance = hint` or `explained` | same | no | no (shown as "with help") |
| Attempt on a disputed or quarantined item, or a disputed grade | same + `learning_disputes` | no, while the dispute stands | no |
| FSRS card review | `learning_reviews` | no | no. It feeds `R_c`, R3 and R5 |
| Self-rating | `learning_self_ratings` | no | no |

**Why only unassisted, exam-style answers move θ:**
- A newly explained answer is weak evidence of independent ability ([product](../../product.md)).
- Performance on repeated cards risks the fluency illusion ([practice engine](../../notes/practice-engine.md); Karpicke & Blunt 2011, doi:10.1126/science.1199327, researched).

**Response time** is stored for evaluation. It doesn't enter the state until it has been validated.

### 5.3 Update rules (Elo-style ability against item difficulty)
**Why Elo:**
- Elo-style models reach accuracy close to IRT at much lower cost, and about 10 answers give a reasonable estimate in simulation (Pelánek, *Computers & Education* 2016; Pelánek, Papoušek, Řihák, Stanislav & Nižnan, "Elo-based learner modeling for the adaptive practice of facts", *UMUAI* 2016, doi:10.1007/s11257-016-9185-7; researched, [practice evidence §3](../../notes/practice-evidence.md)).
- BKT needs cohort data we don't have.

**Definitions**, for item `i` with tagged concepts `C_i`:
- **Tag weights:** `w_c = 1.0` for the primary tag and `0.5` for each secondary tag. The normalised weight is `ω_c = w_c / Σ_{k∈C_i} w_k`.
- **Item ability:** `θ_i = Σ_{c∈C_i} ω_c · θ_c`
- **Guessing floor:** `g_i = 1/k` for multiple choice with `k` options, `0.5` for true/false, and `0` otherwise. This is the multiple-choice adjustment described in the Elo literature above.
- **Expected success:** `P_i = g_i + (1 − g_i) · σ(θ_i − b_i)`, where `σ(x) = 1 / (1 + e^(−x))`
- **Outcome:**
  - `y = 1` or `0` for choice, numeric and cloze items
  - for typed answers graded against a key-idea checklist, `y = found / required` (partial credit)
- **Step size:** `U(n) = α / (1 + β·n)`. The update shrinks as evidence grows. The Elo papers above call this form the "uncertainty function"; here it is called the step size, to keep it apart from the evidence spread `s_c`

**Update after a scored attempt** with exposure weight `v` (§5.2), for each `c ∈ C_i`:
```
θ_c ← θ_c + v · ω_c · U(n_c) · (y − P_i)
n_c ← n_c + v · ω_c
```

**Item difficulty `b_i`** is held at its prior in Phases 0–1 (§5.8). One student can't separate item difficulty from ability; difficulties need about 100 learners (Pelánek et al. 2016, *UMUAI*, researched). It isn't updated from this student's answers.

**Concept summaries**, against a fixed reference item (a typed "understand" item, `b_ref = 0.5`), so that concepts are comparable:
```
s_c    = s0 / √(1 + n_c)
p̂_c   = σ(θ_c − b_ref)
p_low  = σ(θ_c − b_ref − s_c)
p_high = σ(θ_c − b_ref + s_c)
```
`p_low` and `p_high` are **heuristic margins,** not confidence intervals. `s_c` has no sampling model behind it; it only makes a thin record harder to call Solid. Validation (§5.10) decides whether to keep it, recalibrate it or replace it.

### 5.4 Retrievability and decay (FSRS)
**How ts-fsrs computes retrievability** (researched: read in the ts-fsrs v5.4.2 source, `forgetting_curve` and `computeDecayFactor`; MIT):
```
R(t, S) = (1 + F · t / S)^(−d),  where  F = 0.9^(−1/d) − 1
```
- `t` is the days since the last review, `S` is stability, and `R(S, S) = 0.9`.
- **The pinned default:** ts-fsrs **5.4.2** uses FSRS-6 with `FSRS6_DEFAULT_DECAY = 0.1542` (`constant.ts:23`), so `F ≈ 0.980`. FSRS-6 can fit `d` per user; FSRS-5's default was `d = 0.5` (`F = 19/81`).
- **What that means for R5:** `R` falls below 0.80 when `t / S > (0.8^(−1/d) − 1) / F ≈ 3.3`, i.e. after about 3.3 × the stability. Under the old `d = 0.5` it would have been about 2.4 × the stability.
- **If the student's parameters are refitted,** or the pin changes, `R` is recomputed with the new `d`. The configuration records the ts-fsrs version and parameter hash.

**For each concept:**
- `R_c` is the **median** `R` over the concept's cards that have at least one review.
- If a concept has scored attempts but no reviewed cards, `R_c` comes from a **concept track**: a hidden FSRS card fed by the first scored attempt on the concept each local day (correct → Good, miss → Again).
- The concept track is a proxy. FSRS is validated for card recall, not for mastery ([practice engine](../../notes/practice-engine.md)), and the UI never calls it mastery.

### 5.5 Bands
Rules are evaluated in this order:
1. **Not seen yet:** `n_c = 0` and no card reviews on the concept.
2. **Iffy:** any rule R1–R6 fires (§5.6).
3. **Solid:**
   - `n_c ≥ 8`
   - `p_low ≥ 0.75`
   - `R_c ≥ 0.80` (when `R_c` exists)
   - no rule fires
   - **Hysteresis:** a Solid concept drops to Getting there only when `p_low < 0.65`, or straight to Iffy when a rule fires.
4. **Getting there:** anything else.

**Hysteresis stays pure.** "The previous band" and "R1 active" mean the values computed after the prior event, with the same configuration. The state is a fold over the ordered events, then evaluated at "now", so it's still a pure function of events, configuration and time (KM-4).

**Worked check** (replayed with the defaults; items at Bloom level *understand*, so a typed item has `b = 0.5`):

| Unassisted, first-exposure record | `acc_c` | `p̂_c` | `p_low` | R1 | Band |
|---|---|---|---|---|---|
| 3/3 MC (4 options) | 1.00 | 0.546 | 0.362 | no | Getting there |
| 4/4 MC | 1.00 | 0.583 | 0.416 | no | Getting there |
| 10/10 T/F | 1.00 | 0.575 | 0.463 | no | Getting there |
| 20/20 MC | 1.00 | 0.791 | 0.732 | no | Getting there |
| 6/6 typed | 1.00 | 0.816 | 0.716 | no | Getting there |
| **8/8 typed** | 1.00 | 0.851 | 0.776 | no | **Solid** |
| 8/8 typed at Bloom *remember* (`b = 0.25`) | 1.00 | 0.825 | 0.741 | no | Getting there |
| typed: right, right, wrong | 0.67 | 0.499 | 0.320 | **yes** | Iffy |
| typed: wrong, right, right, right | 0.75 | 0.656 | 0.494 | no | Getting there |
| MC: right, wrong, right, wrong | 0.50 | 0.231 | 0.133 | **yes** | Iffy |
| typed: 3 wrong, then 4 right (hysteresis) | 0.57 | 0.641 | 0.512 | **stays** (`p̂` is under the 0.65 exit) | Iffy |

**What the table shows:**
- Eight typed answers in a row are the fewest that reach Solid. One miss keeps the concept at Getting there or Iffy.
- **A recognition-only record never reaches Solid,** by design: recognition success can overstate recall (§5.6, R6).
- This is deliberately conservative. The [practice engine](../../notes/practice-engine.md) note says a topic stays "untested below about 10 unseen exam-style answers". **This spec's decision replaces that line:**
  - `n ≥ 8` is required for Solid.
  - With 3–7 answers, a concept can show Getting there or Iffy, so a thin record is never called Solid.
  - R2 flags thin evidence when an exam is near.
  - The "about 10" figure is where an Elo estimate becomes reasonable in simulation. We use it to set the bar for *Solid*, not to hide everything below it.

### 5.6 Iffy rules
The lookback windows use the student's local calendar.

| Rule | Fires when | Reason shown (example) | Clears when | Must not fire when (tested) |
|---|---|---|---|---|
| **R1 Mid band** | `n_c ≥ 3` **and** the observed unassisted accuracy `acc_c < 0.70` (score-weighted, over the last 10 or fewer scored attempts on `c`) **and** `p̂_c < 0.60`. Both are needed: `p̂_c` is measured against a typed reference item, so a perfect multiple-choice record has a low `p̂_c` without being a mid-band record | "Right on 2 of 4 answers without help." When `acc_c < 0.40`, the text says "mostly missed" | `acc_c ≥ 0.70`, or `p̂_c ≥ 0.65` (hysteresis: it enters below 0.60 and exits at 0.65 or above) | **All scored answers correct in any format** (e.g. 3/3 MC, 4/4 MC, 10/10 T/F); `n_c < 3`; only assisted attempts are wrong |
| **R2 Too little evidence** | `0 < n_c < 3`, or card reviews but no scored answers, **and** the concept is covered by an assessment in the next 14 days | "Only 2 answers so far, and it's on Exam 2 in 6 days." | `n_c ≥ 3`, or the assessment passes | No covered assessment within 14 days; or `n_c = 0` with no reviews (that's Not seen yet) |
| **R3 Recent lapse** | In the last 7 days: an unassisted miss on an item previously answered correctly, or an Again on a card in the Review state (an FSRS lapse), with no unassisted correct answer or Good/Easy review on the concept since | "Missed Q4 on 26 Sep after getting it right on 22 Sep." | An unassisted correct answer or a Good/Easy review after the lapse | A miss on a first attempt; a miss with a hint; a lapse older than 7 days |
| **R4 Confident miss** (a hypercorrection target) | In the last 14 days: an unassisted miss with confidence ≥ 0.67, and the item hasn't been answered correctly since | "You were fairly sure and got it wrong (26 Sep)." The item goes to the front of the mistakes queue | A correct unassisted answer on that item | Confidence `null` or ≤ 0.33; a miss on a disputed item |
| **R5 Decay** | `R_c < 0.80`: desired retention 0.90 minus a margin of 0.10. With the pinned FSRS-6 default decay (§5.4), a card falls below 0.80 at about 3.3 × its stability, e.g. about 20 days after a review for a card with a 6-day stability | "Fading: last reviewed 20 days ago." | `R_c` is back to 0.80 or above. What moves `R_c` depends on its source (§5.4): with reviewed cards, **only card reviews**; with the concept track, the first scored attempt on the concept each local day (it counts as a review of that track) | No cards and no scored attempts |
| **R6 Inconsistent across formats** | In the last 30 days, **at least 3** scored attempts in recognition formats (MC, T/F) and **at least 3** in recall formats (typed, cloze, numeric), and recognition accuracy minus recall accuracy ≥ 0.34 | "Right on multiple choice (4 of 4) but missed typed answers (1 of 3)." | The gap falls below 0.34, or the window moves on | Fewer than 3 attempts in either group; a gap in the other direction (that's flagged for item review, not for the student) |

**Why these rules** (researched):
- **R4:** confident errors are corrected best when feedback follows (Butterfield & Metcalfe 2001).
- **R3, R5:** successive relearning and spacing (Rawson & Dunlosky 2011, doi:10.1037/a0023956; Pyc & Rawson 2011).
- **R6:** recognition success can overstate recall (Kang et al. 2007, via the [performance plan §3.3](../../notes/performance-plan.md)).
- **R2:** readiness needs representative evidence ([performance plan §3.6](../../notes/performance-plan.md)).
- **Why explicit rules:** a secondary review reported that a competing product's mastery dashboard "promoted" topics after a handful of correct answers (Android Police, 2026-07-22, on Gemini Study Notebooks; researched, secondary). Explicit rules with counts keep the reasoning inspectable.

**Overconfidence:** the [product brief](../../product.md) lists "overconfident" as a skill state. Here it becomes a **reason within Iffy (R4)**, not a fifth state. This is an open question for Ben (§13).

### 5.7 What the model drives
**The priority of concept `c`:**
```
need_c   = 1 − p̂_c          (n_c > 0)
         = 0.6              (Not seen yet)
rules_c  = min(0.75, 0.25 × number of fired rules)
urgency_c = 1 + 2 · e^(−d_c / 7)   when c is covered by an assessment d_c ≥ 0 days away
          = 1                     otherwise
priority_c = urgency_c · (need_c + rules_c)
```

| Consumer | How it uses the model |
|---|---|
| **Next session** (ST-7) | Blocks are filled in this order until the minutes run out:<br>1. R4 items (up to 3)<br>2. Due mistakes<br>3. Due cards, by covered-assessment date, then `priority_c`, then lowest `R`<br>4. Learn items on the highest-priority concepts: Iffy, then Getting there, then Not seen yet in module order<br>The difficulty setting is a **preference, not a filter**: among the eligible items, the one whose predicted `P_i` is **nearest** the target band is chosen, so a thin pool never empties a block. The target bands: **Warm-up** 0.75–0.90, **Normal** 0.60–0.80, **Push** 0.45–0.65. The target of roughly 65–75% success is a design hypothesis ([performance plan §3.5](../../notes/performance-plan.md)). Concepts are interleaved, except on the first pass through a new concept (Brunmair & Richter 2019, researched) |
| **Flashcard priority** (ST-2) | The due queue is sorted by covered-assessment date, then `priority_c` of the card's primary concept, then lowest `R`. New cards are capped at 15 a day by default, and the student can change the cap |
| **Practice exam blueprint** (ST-4) | Coverage weights `κ_c` come from T1/T2 statements, or from each concept's share of lecture sessions in the window. The first exam is **exam-faithful** (`λ = 0`). Each blueprint mixes in application and transfer items alongside the exam's stated format: testing transfers, most across formats and to application questions (Pan & Rickard 2018, d = 0.40; researched). **Lean toward my iffy topics** sets `λ = 0.5`: `κ'_c = κ_c · (1 + λ·[Iffy] + 0.5λ·[Not seen yet])`, then normalised and allocated by largest remainder. **No cap is needed:** the multiplier is at most 1.5 and the weights sum to at least 1 before normalising, so no concept's share can exceed 1.5 × its coverage weight. The practice exam stays close to what the course covers, with at least 1 item per covered concept when the length allows |
| **Study guide emphasis** (NB-9) | A render-time ordering and expansion, based on the band. The guide text itself isn't personalised, so it stays cacheable and never carries performance data |

### 5.8 Cold start
- `θ_c = 0` and `n_c = 0`. Every concept is **Not seen yet**.
- **Difficulty prior:** `b_i = b_format + b_bloom`.
  - `b_format`: T/F −1.0 · MC −0.5 · cloze 0.0 · typed +0.5 · numeric +0.5
  - `b_bloom`: remember −0.25 · understand 0 · apply +0.25 · analyse or evaluate +0.5
  - The Bloom level comes from the generating model, or from a Jev Choice when Jev is enabled. Difficulty can be estimated from item text before anyone answers (R2DE, arXiv 2001.07569, researched; not tested on generated items).
- **Diagnostic:** optional and skippable, 8 items or fewer, one per unit, labelled "Placement: helps pick where to start. It isn't a grade."
- **Self-ratings** are shown, but they don't change the state (KM-11).

### 5.9 What is unvalidated
- Every constant:
  - `α = 1.0`, `β = 0.06`, `s0 = 1.5`, `b_ref = 0.5`
  - the difficulty priors
  - the band cut-offs (Solid: `p_low ≥ 0.75` enter, `< 0.65` exit, `n ≥ 8`)
  - R1 (`n ≥ 3`, `acc < 0.70`, `p̂ < 0.60` enter, `≥ 0.65` exit)
  - the rule windows (7, 14, 30 days), the R5 margin (0.10), R6 (a gap of 0.34 with at least 3 per group)
  - the priority weights and the difficulty bands
- **Also starting values in the same configuration:**
  - the **retrieval support threshold**: the minimum BM25 score of the top passage before an answer is attempted, a placeholder until it's fitted on the gold set (§11)
  - **minutes per item**, used to size sessions: 0.5 for a card, 0.75 for T/F or MC, 1.5 for cloze, 2 for typed or numeric
- Whether the bands mean what their names say for UW students.
- The concept-track proxy for decay.
- Whether multi-concept credit sharing (`ω_c`) assigns blame correctly.

The **How this works** panel lists all of these as unvalidated guesses, with the configuration version.

### 5.10 How to validate later
| Question | Method | Data | Reported as |
|---|---|---|---|
| Does `P_i` predict the next unseen, unassisted answer? | Offline replay: predict each attempt from the events before it. Compare log-loss and AUC with a running-accuracy baseline and a constant baseline | Opted-in, local, anonymised exports from team members' courses ([benchmarking](../../notes/benchmarking.md) tier B) plus labelled imported material | Raw counts per course; no clustered SEs under about 20 clusters |
| Do the bands separate? | Next-unseen-item accuracy for Iffy vs Getting there vs Solid, from held-out items the band never saw | The same | A count table per band; the exact binomial interval for each cell |
| Is each rule useful? | For each rule: the miss rate on the next unseen item when it fired vs didn't; how often it fired; how often students clicked "Why?" | The same | Per-rule counts. A rule that doesn't separate is removed or reworded |
| Is FSRS calibrated for these cards? | Predicted `R` against actual recall on due reviews, in bins | Review logs | A calibration table |
| Do students understand the states? | Think-aloud: 5 students explain in their own words why a concept is Iffy, and what they'd do next | Sessions with consent | Quotes and counts. Failure means rewording, not tuning |
| Minimum before any claim | At least 300 held-out unassisted attempts over at least 20 concepts from at least 3 students, and a frozen analysis plan | — | Until then, every threshold keeps the "unvalidated" label |

Engagement mechanics (XP, streaks) are measured only as usage. No learning claim is attached to them.

---

## 6. Grounding and item quality

### 6.1 Quote validity is not claim support
- **Quote validity (code):** the quoted span occurs in the cited resource at the stated version and offsets. The check is an exact match, with no fuzzy repair ([pipeline details](../../pipeline-details.md), Ben's direction).
- **Claim support (a judgment):** the passage supports the sentence built on it. A real quote can still fail to support the claim. Even strong citation systems lacked complete citation support about half the time on one benchmark (ALCE, Gao et al. 2023; researched, [performance plan §1.1](../../notes/performance-plan.md)).
- The two are always **stored, labelled and reported separately** (NB-6; [benchmarking](../../notes/benchmarking.md)).
- **"Not found" wording:** "I couldn't find support in the captured material I searched", plus the scope, freshness and missing source types. A retrieval miss doesn't prove absence.

### 6.2 The citation pipeline for answers and guides
1. **Retrieve (code):**
   - Build the query from the question's content words, OR-joined. Ben's FTS query is prefix-AND over every term (**built**), which a natural question rarely matches ([where we differ, row 3](../../notes/where-we-differ.md)).
   - Rank the passages of the course's included sources with BM25.
   - Take the top 8 passages, 1,200 characters or fewer each.
   - If no passage scores above the support threshold (fitted on the gold set), go to "not found".
2. **Policy gate (code):** apply the course and item policy (NB-7).
3. **Draft (model):** the model must answer as JSON: `{sentences:[{text, citations:[{passageId, quote}]}]}`.
4. **Check (code):**
   - Find each quote inside its passage's span of the resource version.
   - A quote must be 12–400 characters long.
   - Drop any citation that fails. Remove any factual sentence left with no valid citation, and record the removal.
5. **Support (Phase 1, when available):** one of, in order:
   - Jev `supports / contradicts / does_not_address` for each citation (G-rules in [Jev insights](../../notes/jev-insights.md))
   - a separate check pass by the student's model, labelled as the same model
   - nothing, labelled "support not checked"
6. **Render:** the sentences and citation chips, the check line, scope and freshness.

### 6.3 The checked-item pipeline
Stages run in order. A failed code stage drops the item. The check line lists only the stages that ran and passed.

| # | Stage | Layer | Rule |
|---|---|---|---|
| 1 | Policy and source gate | code | No items when the course is restricted. Open graded assignments are never a source ([integrity roles](../../notes/integrity-roles.md)) |
| 2 | Schema | code | Required fields are present. An MCQ has 3–5 options and exactly one key. Options are distinct after normalising |
| 3 | Quote found | code | The item's quote occurs in its source version (as in §6.2 step 4) |
| 4 | Flaw rules | code | Reject:<br>• a correct option longer than every distractor by more than 30%<br>• "all/none of the above"<br>• negation stems without emphasis<br>• duplicate options<br>• a key that repeats the stem's words verbatim<br>Pure code rules cover cue flaws only ([performance plan §3.1](../../notes/performance-plan.md)) |
| 5 | Near-duplicate | code | Jaccard similarity of normalised token trigrams ≥ 0.8 against items the student has seen means rejection. Reused items inflate scores through memorisation (Simkin et al., researched) |
| 6 | Executed answer | code | For numeric items with a formula in the source: a safe arithmetic evaluator (no `eval`) recomputes the key. Sandboxed code execution is deferred |
| 7 | Support and one correct answer | Jev when enabled; otherwise the model in a separate pass; otherwise not run | Jev: a `supports / contradicts / does_not_address` Choice, plus a Noul per option, with code checking that exactly the keyed option passes ([Jev usage](../../notes/jev-usage.md)). `contradicts` → reject. Abstain → regenerate once, then drop. A hybrid checker (scripts plus an LLM) caught more human-identified flaws than an LLM alone, but it over-flagged (Moore et al. 2023, researched), so drops are counted and reported as the false-drop rate (§11) |
| 8 | Tags | code | 1–3 concepts from the course map (KM-2) |
| 9 | Explanation | code | The explanation has a quote-valid citation (ST-10) |

**Typed-answer grading** (ST-3):
1. Code normalises the answer and matches it against the key and listed synonyms.
2. If that doesn't match, each key idea is judged by a Jev Noul ("Does the answer state ⟨idea⟩?") when Jev is enabled, or by the model in a separate pass otherwise.
3. The feedback shows which key ideas were found.
4. **Flag this grade** stores a dispute and removes the attempt from the knowledge model.

**Why a checklist and a flag:** LLM graders approach human agreement without reaching it (κ 0.70 vs 0.75 human–human on K-12 short answers, arXiv 2405.02985; researched, [performance plan §3.4](../../notes/performance-plan.md)).

### 6.4 Labels that name the check that ran
| Label shown | Shown when | Never shown when |
|---|---|---|
| Quote found in source | Stage 3 passed (code) | Any quote failed |
| Answer checked by running it | Stage 6 ran and matched | No evaluator applied |
| One correct option: structure checked | Stage 2 passed and stage 7 didn't run | — |
| One correct option: judged by Jev | Stage 7 per-option Nouls passed | Jev abstained or was off |
| Support judged by Jev | Stage 7 `supports` cleared its fitted bar | Before thresholds are fitted: shown as "Support: Jev (shadow)" |
| Support judged by ⟨model⟩ in a separate check | The model's check pass agreed | Always adds "(same model that wrote it)" when that's true |
| Support not checked | Stage 7 didn't run | — |
| From your instructor's practice exam (T1) · From this term's exam info (T2) · Partly from ⟨term⟩ exams (T3) · From course materials (T4) | The tier of the item's source | — |

**Rule:** no label says "verified", "correct" or "accurate". In the seeded-error evaluation (§11), each label reports its catch rate and false-drop rate before it appears in public material.

### 6.5 Disputes and repair
- **Types:** citation, item, grade and concept tag.
- **Effect:** each dispute takes effect at once (quarantine and exclusion), is stored with its reason, and can be undone.
- **Silence isn't approval,** and an undo isn't proof of an error. Disputes are reviewed offline, and thresholds are never tuned automatically from them ([pipeline details](../../pipeline-details.md), link thresholds §7).
- **Cache keys include the dispute set** (§9.3), so a disputed citation never comes back from a cache.

---

## 7. Data model

**Status: proposed.** It's additive to Ben's store, which uses `node:sqlite` `DatabaseSync` in the worker, with migrations by `PRAGMA user_version` (v2) (**built**; [local DB](../../notes/local-db.md)).

### 7.1 Where it lives
Feature data must live in the workspace database, so that "Delete local data" covers it. A separate file would survive a purge ([backend map](../../notes/backend-map.md)).

| Option | What changes in Ben's code | Our recommendation |
|---|---|---|
| **A. A storage extension hook** | `createStore(path, {extensions})`. Each extension brings its own migrations, tracked in a `schema_components(component, version)` table, and a purge step. `user_version` stays Ben's | **Recommended.** Ben's migrations and tests are unaffected. Our tables version on their own |
| B. Migration v3 inside `packages/storage` | `SCHEMA_VERSION = 3`, our tables in his `schemaVersion < 3` block, and new `Store` methods | Simpler to read, but every learning change touches his file |

Both options need **a purge step** (listed in §7.3): FTS tables don't cascade, course-level rows don't hang off `sources`, and cross-course sessions and preferences have no course at all.

### 7.2 Tables
Every table is prefixed `learning_`. "→ X ⊗" means a foreign key to X with `ON DELETE CASCADE`.

| Table | Key and cascade | Fields |
|---|---|---|
| `learning_courses` | `id` = `accountScope:courseId`; UNIQUE (account_scope, course_id). Deleted explicitly by purge | label, term (nullable), created_at |
| `learning_passages` | `id`; → resources ⊗; UNIQUE (resource_id, content_hash, start) | version, content_hash, text_hash, start, end, heading, part_kind, part_label, splitter_version |
| `learning_passage_search` | FTS5 (passage_id UNINDEXED, heading, body). Rows are rewritten on a new version and cleared by purge | — |
| `learning_concepts` | `id`; → learning_courses ⊗; parent → learning_concepts ON DELETE SET NULL | label, kind (`unit`\|`concept`), position, origin (`code`\|`model`\|`student`), status (`active`\|`merged`\|`hidden`), merged_into, student_label, map_version |
| `learning_concept_sources` | (concept_id, resource_id, start); → concepts ⊗; → resources ⊗ | content_hash, end, quote, quote_valid |
| `learning_items` | (`id`, `version`); → learning_courses ⊗ | family_id (linked variants: MC and typed forms of one key idea), kind (`mc`\|`tf`\|`typed`\|`cloze`\|`numeric`\|`card`), stem, options_json, key_json, key_ideas_json, explanation, tempting_json, bloom, b_prior, tier (`T1`–`T4`), source_term, origin (`generated`\|`instructor`\|`mistake`\|`note`\|`student`), status (`active`\|`quarantined`\|`stale`), status_reason, generator_json (client, model, prompt_version), created_at |
| `learning_item_sources` | (item_id, item_version, resource_id, start); → items ⊗; → resources ⊗ | content_hash, text_hash, end, quote, quote_valid |
| `learning_item_concepts` | (item_id, item_version, concept_id); → items ⊗; → concepts ⊗ | weight (1.0 or 0.5), primary |
| `learning_item_checks` | (item_id, item_version, check); → items ⊗ | method (`code`\|`jev`\|`model:<id>`\|`human`), outcome (`pass`\|`fail`\|`abstain`\|`not_run`), detail_json, created_at |
| `learning_cards` | `id`; → items ⊗ | the ts-fsrs `Card` fields (due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review), fsrs_version, params_hash, is_concept_track |
| `learning_reviews` | `id`; → cards ⊗; immutable | rating (1–4), state_before_json, state_after_json, review_ms, local_day, undoes_review_id, created_at |
| `learning_attempts` | `id`; → learning_courses ⊗; immutable (a conflicting write with the same ID throws, as Ben's `addAttempt` does) | item_id, item_version, source_resource_id (nullable: student-made or note items, or a source since deleted), primary_concept_id, correct, assistance (`none`|`hint`|`explained`), seen_before, confidence (0–1 or null), created_at, format, mode (`learn`\|`test`\|`exam`\|`review`\|`diagnostic`), response_json, score (0–1), grading_method, response_ms, concept_tags_json, session_id, local_day |
| `learning_self_ratings` | `id`; → concepts ⊗ | rating (`dont_know`\|`shaky`\|`know_it`), delayed, local_day, created_at |
| `learning_disputes` | `id`; → learning_courses ⊗ | target_kind (`citation`\|`item`\|`grade`\|`concept_tag`), target_id, reason, note (≤500), status (`open`\|`undone`\|`resolved`), created_at, resolved_at |
| `learning_artifacts` | `id`; → learning_courses ⊗; UNIQUE (cache_key) | kind (`answer`\|`study_guide`\|`briefing`\|`faq`\|`glossary`\|`timeline`\|`mind_map`\|`coverage`\|`audio_script`), scope_json, cache_key, body_json, removed_count, status (`ready`\|`stale`\|`partial`\|`failed`), generator_json, created_at |
| `learning_artifact_sources` | (artifact_id, resource_id); → artifacts ⊗; → resources ⊗ | content_hash (for staleness) |
| `learning_coverage` | (assessment_id, concept_id); assessment → resources ⊗; → concepts ⊗ | basis (`stated`\|`schedule_window`\|`mapped`), tier, evidence_resource_id, start, end, quote, status (`proposed`\|`accepted`\|`rejected`); a student decision is never overwritten |
| `learning_sessions` | `id`; → learning_courses ⊗ (a null course means cross-course) | kind, plan_json, minutes, difficulty, started_at, ended_at |
| `learning_concept_state` | `concept_id` → concepts ⊗; a cache | theta, n, s, p_hat, r, band, reasons_json, counts_json, config_version, computed_at |
| `learning_jobs` | `id`; → learning_courses ⊗; UNIQUE (kind, subject, input_hash) | kind, subject, input_hash, priority, status, attempts, run_after, lease_until, lease_token, error, waiting_for (`provider`\|`jev`\|null) |
| `learning_prefs` | `key`; deleted by the extension's purge step | value (daily goal, new-card cap, always-preview, background generation, and the sensitive categories already approved) |

**Derived, not stored:** XP, streaks, path progress and "What changed" are computed from the events. The daily-goal, new-card-cap and "always preview" settings live in our `learning_prefs(key, value)` table, cleared by the extension's purge step. This avoids needing new preference accessors on Ben's `Store`, which exposes only `privacy()`.

### 7.3 Mapping onto Ben's tables and `Store`
| Need | Ben's (built) | Proposal |
|---|---|---|
| Attempt evidence | `attempts` (id, resource_id, item_id, skill, correct, assistance, seen_before, confidence 0–1, created_at); `Store.addAttempt` is immutable by ID | **Decision: learning evidence lives in our `learning_attempts`**, with the same fields plus details. **Why:** `addAttempt` requires a live resource (`storage:715`), but evidence must also exist for student-made and note items and must outlive a source that Canvas deleted. Keeping it out of `attempts` also keeps it out of `Snapshot` (§8.2). Ben's `attempts` table stays as it is; nothing writes learning evidence to it |
| Timestamps | `timestamp()` normalises to UTC, so the local offset is lost | Store `local_day` alongside, for streaks and rule windows |
| Cached verdicts | `judgments` is keyed to a resource's **whole-input** content hash | Use our own `learning_item_checks`. Ben's `contentHash` also changes when `submitted` or `points` change, which would invalidate item checks whose text is unchanged. Our keys use `text_hash = sha256(title + text)` |
| Links | `Link.type` = `specifies`\|`supports`\|`same_as` | Assessment → material coverage uses a `covers` link (**needs Ben**: contracts and storage). Assessment → concept uses `learning_coverage` |
| Jobs | `jobs` requires a live resource and the matching `inputHash`; `lease` has no kind filter; core fails any kind other than `enrich.resource` | Course-level jobs don't fit a resource anchor, so use `learning_jobs` (§8.4). If both queues stay, add an optional kind filter to `lease` |
| Snapshot | `Snapshot.attempts` returns **every** attempt on **every** command | Leave learning evidence out of `Snapshot`. Add a small `learning` summary (§8.2) |
| Purge | Deletes sources (cascade), receipts, preferences, `resource_search`; then `VACUUM` | The extension's purge step runs `DELETE FROM learning_courses` (cascading to course-keyed tables), `DELETE FROM learning_sessions` (cross-course sessions have a null course and don't cascade), `DELETE FROM learning_prefs` and `DELETE FROM learning_passage_search`. **The purge test:** enumerate `sqlite_master` tables, **excluding** FTS5 shadow tables (names ending `_data`, `_idx`, `_content`, `_docsize`, `_config`) and `schema_components`; assert zero rows in each; count FTS rows through the virtual tables themselves (`SELECT count(*) FROM learning_passage_search`, `resource_search`) |

### 7.4 The `LearningStore` interface (ours)
It's implemented in SQL through the extension (option A), and in memory for tests and the evaluation harness. Methods, grouped:
- **Courses and passages:** `course(accountScope, courseId)` · `putPassages(resourceId, contentHash, passages[])` · `searchPassages(courseRef, query, limit)`
- **Concepts:** `concepts(courseRef)` · `putConceptMap(courseRef, map, mapVersion)` · `editConcept(id, edit)`
- **Items:** `putItem(item, sources, tags, checks)` · `items(filter)` · `setItemStatus(id, version, status, reason)`
- **Cards:** `cards(filter)` · `putCard(card)` · `addReview(review)`
- **Evidence:** `addAttempt(attempt)` · `addSelfRating(r)` · `evidence(courseRef, since?)`
- **Disputes:** `addDispute(d)` · `setDisputeStatus(id, status)`
- **Artifacts and coverage:** `artifact(cacheKey)` · `putArtifact(a)` · `markStale(resourceId, newHash)` · `coverage(assessmentId)` · `putCoverage(rows)` · `decideCoverage(key, status)`
- **Sessions, state and jobs:** `putSession(s)` · `conceptState(courseRef)` · `putConceptState(rows)` · `enqueueLearning(...)` · `leaseLearning(now, ms, kinds)` · `finishLearning(...)`

---

## 8. Interfaces

**Status: proposed.** Every change to `packages/contracts`, `packages/core` or `apps/desktop` **needs Ben** (§13).

### 8.1 Commands and results
**Recommended:** add **one** routed variant to Ben's strict `commandSchema`. This keeps his union small and core's switch readable. The request schema sits in contracts, so that both the renderer and the worker type-check it.

```ts
// packages/contracts (additive)
{ type: "learning", request: LearningRequest }             // new Command variant
type CommandResult = { snapshot; manifest?; message?; learning?: LearningResult };

type LearningRequest =
  | { op: "notebook.open"; courseId: string }
  | { op: "notebook.include"; courseId: string; resourceId: string; included: boolean }
  | { op: "notebook.ask"; courseId: string; question: string /* ≤2000 */; scope?: { assessmentId?: string; resourceIds?: string[] /* ≤50 */ } }
  | { op: "notebook.artifact"; courseId: string; kind: "study_guide"|"briefing"|"faq"|"glossary"|"timeline"|"mind_map"; assessmentId?: string; rebuild?: boolean }
  | { op: "notebook.coverage"; courseId: string; assessmentId: string }
  | { op: "notebook.dispute"; artifactId: string; citationId: string; reason: "quote_missing"|"does_not_support"|"wrong_source"|"other" }
  | { op: "study.plan"; courseId?: string; assessmentId?: string; minutes: number /* 5..120 */; difficulty: "warmup"|"normal"|"push" }
  | { op: "study.answer"; sessionId: string; itemId: string; itemVersion: number;
      response: { kind: "choice"; optionId: string } | { kind: "text"; text: string /* ≤2000 */ } | { kind: "number"; value: number; unit?: string };
      confidence: 0 | 0.33 | 0.67 | 1 | null; responseMs: number }
  | { op: "study.hint"; sessionId: string; itemId: string; level: "hint" | "explain" }
  | { op: "study.review"; cardId: string; rating: 1 | 2 | 3 | 4; reviewMs: number }
  | { op: "study.undoReview"; reviewId: string }
  | { op: "study.exam"; courseId: string; assessmentId: string; length: number /* 5..60 */; lean: boolean; timed: boolean }
  | { op: "study.submit"; sessionId: string }
  | { op: "study.flag"; itemId: string; itemVersion: number; reason: "wrong_key"|"two_correct"|"no_correct"|"unclear"|"off_topic"|"not_my_course"|"grade_wrong"; note?: string /* ≤500 */ }
  | { op: "study.unflag"; disputeId: string }
  | { op: "study.generate"; courseId: string; kind: "flashcards"|"quiz"; conceptIds?: string[] /* ≤20 */; assessmentId?: string; count: number /* ≤30 */ }
  | { op: "study.path"; courseId: string }
  | { op: "knowledge.state"; courseId: string }
  | { op: "knowledge.concept"; conceptId: string }
  | { op: "knowledge.selfRate"; conceptId: string; rating: "dont_know"|"shaky"|"know_it"; delayed: boolean }
  | { op: "knowledge.edit"; conceptId: string; edit: { kind: "rename"; label: string } | { kind: "merge"; intoId: string } | { kind: "hide" } | { kind: "restore" } }
  | { op: "knowledge.retag"; itemId: string; conceptIds: string[] /* 1..3 */; primary: string };
```

**Key result shapes.** Student-facing types carry **no** ability or probability fields; KM-6 enforces this.
```ts
interface Citation { id: string; resourceId: string; version: number; contentHash: string; start: number; end: number;
  quote: string; quoteValid: true; support: "jev" | "model_same" | "model_other" | "not_checked" | "disputed" }
interface Answer { kind: "answer" | "not_found" | "policy_limited"; sentences: { text: string; citationIds: string[] }[];
  citations: Citation[]; removed: number; checks: string[]; scope: { searched: number; excluded: number; missing: string[]; capturedAt: string };
  receiptIds: string[] }
interface ConceptView { conceptId: string; label: string; unit: string | null;
  state: "solid" | "getting_there" | "iffy" | "not_seen";
  reasons: { rule: "R1"|"R2"|"R3"|"R4"|"R5"|"R6"; text: string; eventIds: string[]; clearsWhen: string }[];
  counts: { answers: number; unassisted: number; correct: number; cardReviews: number; selfRatings: number };
  coveredBy: { assessmentId: string; title: string; daysAway: number }[]; configVersion: string }
interface Grade { itemId: string; outcome: "correct" | "partial" | "incorrect"; keyIdeas?: { idea: string; found: boolean }[];
  explanation?: { text: string; citation: Citation }; tempting?: string; deferred: boolean /* exams */ ; checks: string[] }
interface SessionPlan { sessionId: string; minutes: number; blocks: { kind: "confident_misses"|"mistakes"|"due_cards"|"learn"|"diagnostic";
  itemIds: string[]; reason: string }[] }
interface Coverage { assessmentId: string; tier: "T1"|"T2"|"T3"|"T4"; statement?: Citation;
  concepts: { conceptId: string; basis: "stated"|"schedule_window"|"mapped"; citation?: Citation }[];
  materials: { resourceId: string; reason: string }[]; missing: string[]; warnings: string[] }
```

**The alternative** is one `Command` variant per operation. It's more explicit, but the union grows to about 30 variants, and core's switch has no default branch: a variant added to contracts but not to core silently returns a snapshot (**built** behaviour, [backend map](../../notes/backend-map.md)). **Either way,** core should gain an exhaustive `never` check.

**Streaming:** chat and guide generation stream through a separate IPC channel in Phase 1 (`magic:learning-stream`, with events `delta · citation · check · done · error`). Phase 0 returns whole results.

### 8.2 Snapshot additions
```ts
Snapshot.learning?: { courses: { courseId: string; notebook: "ready"|"building"|"stale"|"partial"|"empty";
  dueCards: number; iffy: number; streakDays: number; provider: "connected"|"missing"|"signed_out"|"limited" }[] }
```
Evidence, items and concept states are fetched with `learning` commands, never on every snapshot.

### 8.3 The Magic tools MCP server
A stdio server bundled with the app (`packages/magic-tools`). The student's CLI gets **only** these tools, in an isolated configuration ([agent runtime](../../notes/agent-runtime.md)).

**Rules for every tool:**
- Tools are coarse, and code does the bulk work.
- They are read-only towards school systems.
- Every tool passes the policy and integrity gates.
- Every tool that returns course text writes an egress receipt for the provider route.
- Inputs are validated with zod. Oversized inputs are refused, never truncated.

| Tool | Input | Output | Layers | Writes locally? | Receipt categories |
|---|---|---|---|---|---|
| `course_list` | `{}` | `{courses:[{courseId, name, term, sources, capturedAt}]}` | code | no | none (metadata) |
| `course_outline` | `{courseId}` | `{units:[{id,label,concepts:[{id,label}]}], modules[], assessments:[{id,title,dueAt,kindLabel}], policy:{mode, quote}}` | code | no | `course_text` |
| `materials_search` | `{courseId, query ≤500, assessmentId?, limit ≤12}` | `{passages:[{passageId, resourceId, version, title, heading, start, end, text ≤1200}], scope:{searched, excluded, missing[], capturedAt}}` | code | no | `course_text` |
| `passage_get` | `{passageId, context?: 0..2}` | `{passageId, text, neighbours[]}` | code | no | `course_text` |
| `citations_check` | `{courseId, sentences:[{text, citations:[{passageId, quote}]}]}` | `{results:[{sentence, citations:[{passageId, quoteValid, start?, end?}]}]}` | code | no | none (no new text returned) |
| `artifact_context` | `{courseId, kind, assessmentId?}` | `{schema, outline, passages[], instructions}` | code | no | `course_text` |
| `artifact_save` | `{courseId, kind, assessmentId?, body}` | `{accepted, removed, errors[]}` (the model may fix and resubmit once) | code (schema + quotes) | yes, `learning_artifacts` | none |
| `exam_coverage` | `{courseId, assessmentId}` | `Coverage` (§8.1) | code → Jev (when enabled) | yes, `learning_coverage` (proposed rows) | `course_text` |
| `items_context` | `{courseId, conceptIds? ≤20, assessmentId?, count ≤30, formats[]}` | `{coverageBlueprint, passages[], poolStems[], schema}`. The blueprint uses coverage weights only (λ = 0); `poolStems` are the pool's stems, not the student's seen or missed items | code | no | `course_text` |
| `items_submit` | `{courseId, items:[…] ≤30}` | `{accepted:[id], rejected:[{index, stage, reason}]}` | code; Jev stage queued | yes, `learning_items` | none |
| `concept_map_submit` | `{courseId, units:[…]}` | `{accepted, rejected[]}` | code (quotes, structure; student edits preserved) | yes | none |
| `knowledge_summary` | `{courseId}` | `{concepts:[{id,label,state,reasons[]}]}`: states and reason text only | code | no | `learning_state`, **off by default** |
| `policy_get` | `{courseId, resourceId?}` | `{mode, quote, source}` | code | no | `course_text` |
| `deadlines` | `{courseId?}` | `{items:[{resourceId, title, planningAt, dueAt, conflict}]}` | code (`resolveDeadline`, **built**) | no | `course_text` |

**Not exposed:** a shell, network access, file writes outside the app's scratch folder, attempt or review rows, the student's notes (unless `shareStudentWork`), URLs, account IDs, grades and submissions.

**The CLI can't reach the database file.** The workspace database sits in the same user account as the CLI, and its `0600` file mode doesn't stop a process running as the same user. So the CLI's own tools are switched off and its working directory contains nothing:

| Route | Built-in tools | Working directory | Status |
|---|---|---|---|
| Claude Code | `--allowedTools "mcp__magic__*"` and `--disallowedTools "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch,NotebookEdit,Task"`, plus `--permission-prompts none` so anything else is denied without a prompt ([agent runtime](../../notes/agent-runtime.md)) | a fresh, empty scratch folder per session | decision; the tool names are checked against the pinned CLI version in N20 |
| Codex | `-s read-only`, with `-C <empty scratch folder>` | the same | **Open.** Codex's read-only sandbox blocks writes, not reads, so a shell command could still read the database. The Codex route ships only after the N20 negative test passes with a configuration that denies it |
| Gemini CLI | the isolated settings file limits the core tools to none and allows only our MCP server | the same | the same negative test before shipping |

**The MCP-to-worker bridge.** The CLI starts our MCP server as a stdio child process. That server **never opens the database.** It forwards each tool call to the worker, which owns the single `Store` writer ("One local writer", `packages/storage/src/index.ts:41`):
- **Transport:** a local socket (a Unix domain socket in the app's data folder, mode `0600`; a named pipe on Windows) that the worker opens for the session.
- **Authentication:** the worker passes the socket address and a random per-session token to the CLI's MCP configuration as environment variables. It rejects any connection without the token and closes the socket when the session stops.
- **Protocol:** one JSON message per tool call: `{id, tool, input}`, answered with `{id, output | error}`. The worker validates the input with the same zod schemas, runs the handler (N18) against its store, and writes the receipt.
- **Failures:** if the worker is gone, the server returns an MCP error. It never falls back to opening the file.

### 8.4 Job kinds
All jobs run in the worker. Jobs that need a model wait with `waiting_for: "provider"` instead of burning retries. The queue runs soonest assessment first.

| Kind | Subject and input hash | Layers | Trigger | Phase |
|---|---|---|---|---|
| `learning.passages` | resource; `text_hash` + splitter version | code | ingest of a new version | 0 |
| `learning.concepts` | course; hash of syllabus, module and lecture-title versions + prompt version | code → model | first sync; a change to those inputs | 0 |
| `learning.tag` | item batch; the items' hashes + the map version | code → Jev (candidate Nouls ≤8) → model | new items; a map change | 0 (model), 1 (Jev) |
| `learning.artifact` | course + kind + scope; §9.3 key | code → model | an assessment within 14 days; the student clicks Build | 0 (study guide), 1 |
| `learning.coverage` | assessment resource; its `text_hash` + candidate-set hash | code → Jev → model | a new or changed assessment | 0 (code), 1 |
| `learning.items` | concept or assessment pool; source hashes + blueprint | code → model | pool below its target size; `study.generate` | 0 |
| `learning.check` | item@version | code → Jev or model | new items | 1 |
| `learning.state` | course; last event ID + config version | code | an event, or a new day | 0 (inline; a job only when large) |
| `learning.audio` | the study guide artifact | model → local TTS (candidate) | the student asks | 2 |

**Background use of the student's plan** (proposed):
- Prebuilding is on only for the nearest assessment by default.
- Settings shows "Background generation: on for the next assessment / on for all / off" and a daily count of background runs.
- It stops when the CLI reports a usage limit.

### 8.5 The agent-runtime adapter (`packages/agent-runtime`)
One interface for all four routes: `detect() · status() · start(session) · send(message) · events() · stop()`.
- Each adapter maps its CLI's stream to one internal event type ([agent runtime](../../notes/agent-runtime.md)).
- The app keeps only `loggedIn`, `authMethod` and `subscriptionType` from `claude auth status --json`.
- The runtime never reads or copies credential files.
- **Isolation (decision; probed once, per the [agent runtime](../../notes/agent-runtime.md) note):**
  - **Claude:** reuse the existing login with `--setting-sources project,local --strict-mcp-config --mcp-config <ours>`. In the probe, no user CLAUDE.md, skills or MCP servers loaded.
  - **Codex:** reuse the existing login with `--ignore-user-config --ignore-rules --ephemeral -s read-only -c developer_instructions="<Magic Canvas role; the user's AGENTS.md is out of scope>"`. In the probe, the model declined to follow or quote the global AGENTS.md. Its text still enters the context, which the consent screen says.
- **Tool lockdown:** the tool lockdown in §8.3 applies to every route.

---

## 9. AI usage

### 9.1 The cascade for each feature
The order is code first, then Jev for bounded typed choices when it's enabled, then the student's model for writing. Jev never writes text, does dates or arithmetic, or authorises anything ([Jev usage](../../notes/jev-usage.md)).

| Feature | Code | Jev (when enabled, under the global cap) | Model (the student's CLI) |
|---|---|---|---|
| Passages, retrieval, freshness | all of it | — | — |
| Concept map | candidates from modules, lecture titles and schedule headings; validation; merging student edits | — | proposes units and concepts with quotes |
| Item tagging | candidate concepts (≤8) by term overlap | one Noul per candidate | fallback: picks from the same closed list |
| Grounded chat | retrieval, policy, quote check, removal, not-found | support Choice per citation (Phase 1) | writes the sentences with citations |
| Study guide, briefing, FAQ, glossary | outline, schema, quote check, rendering, emphasis | — | writes the entries |
| Timeline | date parsing and ordering; the date must occur in its quote | — | proposes the events |
| Mind map | built entirely from the concept map (markmap) | — | — |
| Exam coverage | statement search in the syllabus (and announcements later); schedule window; tier choice | a Noul per candidate material (≤30) | maps a stated scope to concepts, labelled "mapped" |
| Item generation | blueprint, flaw rules, duplicates, arithmetic evaluator | support + a Noul per option | writes the stem, options, key, explanation and "tempting" line |
| Typed grading | normalisation and synonyms | a Noul per key idea | fallback per key idea, labelled |
| Knowledge model, sessions, FSRS, path, XP | all of it | — | — |
| Integrity gate | triggers: an open graded item, a restricted policy | a strict-only Noul ("asking to produce graded work?") | — |

**Jev limits (decision: no per-student budget).**
- **Today:** the **built** gateway enforces per-device caps (20 a day, 5 an hour) and a global cap of 100 a day. Those can't carry item gates across a whole course ([Jev insights §7](../../notes/jev-insights.md)).
- **The decision:** remove the per-device and per-student caps and keep **only a global abuse cap** that protects the owner's bill ([business model](../../notes/business-model.md)). This lands as a gateway PR (B07).
- **OpenRouter-key users** call Jev through OpenRouter's decisions route on their own key, so they don't count against the gateway at all.
- **When the global cap is hit,** or Jev is off or unreachable, each check falls back to the labels in §6.4 ("Support judged by ⟨model⟩…", "Support not checked"), never to silence.
- **The order of calls** stays the same, so the most useful checks run first: coverage for the nearest assessment → support checks on items in the next session → key-idea grading on disputed grades → everything else.

### 9.2 Disclosure: what each call receives, and when the student sees it
**Decision** ("Disclosure without friction", [agent runtime](../../notes/agent-runtime.md); [where we differ, row 16](../../notes/where-we-differ.md)):
1. **Consent once per provider,** when it's connected. The consent screen names:
   - the recipient (the student's own provider)
   - the categories that can leave (`course_text` by default)
   - that Codex also reads the student's global AGENTS.md
   - a link to the provider's data settings

   Connecting sets privacy to `selective_cloud` with `shareCourseText: true` for that provider.
2. **Every request after that is visible but not blocking:**
   - a **context chip** on the answer or artifact lists the sources used, and opens the exact payload
   - an **egress receipt** goes to the AI-use log
3. **A blocking preview appears only when:**
   - a **new sensitive category** would leave for the first time: `student_work` (the student's drafts or answers), messages, anything with classmates' content, and `learning_state`. The preview shows the exact payload once. After the student approves, that category behaves like the others.
   - the student has turned on **"Always preview"** in Settings, which brings back a blocking preview for every request.
4. **Local-only mode** (the **built** default before a provider is connected) still blocks everything hosted, including Jev.

| Call | Recipient | Categories | Fields sent | Never sent |
|---|---|---|---|---|
| Chat | the chosen provider (via its CLI) | `course_text` | the question; ≤8 passages (course, title, heading, text ≤1,200 chars); the policy line | URLs, account IDs, grades, submissions, other courses, attempts, the knowledge model |
| Guides | provider | `course_text` | outline; passages for the scope; schema | the knowledge model: emphasis is applied locally |
| Item generation | provider | `course_text` | passages; concept labels; a **coverage** blueprint (counts per concept from coverage weights only); stems of items already in the pool, for de-duplication | anything derived from the student's performance |
| Typed-answer fallback | provider | `course_text`, `student_work` (first send → blocking preview) | the key idea, the student's typed answer, the passage | anything else. Until `student_work` is approved, grading stays code-only and is labelled so |
| `knowledge_summary` and personalised generation ("more like my misses") | provider | `learning_state` (first send → blocking preview) | concept labels, states, reason text; for "more like my misses", the missed item stems | raw events, timestamps, confidence values |
| Jev judgments | Magic Canvas gateway → TypeSafe (**built** route); OpenRouter-key users go through OpenRouter's Jev route on their own key | `course_text` (+ `student_work` for grading) | named, minimal state per [Jev insights](../../notes/jev-insights.md) | content in the journal (hashes only) |

**Keeping performance data local by construction:**
- **Pools are generated by coverage** (concepts and weights from the course, not from the student) and **selected locally** by the knowledge model. Sessions, the lean practice exam and iffy self-checks all draw from those pools, so choosing *which* items a student sees never tells the provider what's iffy.
- **"Flashcards from my misses"** turns the missed items themselves into cards locally (front: the stem; back: the key and the explanation), with no provider call.
- When a pool runs short for an Iffy concept, the app tops up **that concept's coverage pool** as part of a scheduled coverage refill. Its request is shaped like any other coverage request. It does not ask for "items the student got wrong".

**Name scrubbing:** it's accepted policy but not implemented. The chip's payload view and the consent screen say "Course text may contain names" ([pipeline details](../../pipeline-details.md)).

### 9.3 Caching keys
All keys are SHA-256 over canonical JSON. `text_hash` is our hash of title + text, so changes to `submitted` or `points` don't invalidate them (§7.3).

| Output | Key |
|---|---|
| Passages | `resourceId · text_hash · splitterVersion` |
| Answer | `courseRef · normalised question · sorted [resourceId@text_hash] of the retrieved passages · included-source set · promptVersion · route · model · disputeSetHash` |
| Guide artifact | `courseRef · kind · scope · sorted [resourceId@text_hash] of its inputs · promptVersion · route · model · disputeSetHash` (emphasis isn't in the key) |
| Concept map | `courseRef · hash of the syllabus, module and lecture-title inputs · promptVersion · model` (student edits are applied on top, not keyed) |
| Items pool | `conceptId or assessmentId · source text hashes · blueprint hash · promptVersion · model` |
| Item checks | `itemId@version · check · method · questionVersion` |
| Coverage | `assessment text_hash · candidate-set hash · tier sources hash · questionVersion` |
| Concept state | `last event ID · configVersion · local day` (recomputed on read for R5) |
| Jev | Ben's `judgments` where one resource is the input; otherwise `learning_item_checks`. The journal keeps hashes only ([Jev insights §2](../../notes/jev-insights.md)) |

---

## 10. Integrity and privacy rules

| # | Rule | Enforced by |
|---|---|---|
| IP-1 | **Course policy first.** Restricted means no generation for that item, with an allowed next step. Vague or silent means coach mode ([decisions](../../decisions.md)) | code gate before any model call (NB-7) |
| IP-2 | **Never use an open graded assignment** (or quiz) as an input while it's open: not for items, and not for the study guide, briefing, FAQ, glossary or timeline. An assignment is **open** until its closing time: its `lock` claim if it has one, otherwise its resolved due time, otherwise **no date means open**. `submitted = null` counts as open, and `submitted = true` doesn't close it either, because resubmission may be allowed. The timeline may still show its title and dates from structured fields | code: assignment kind, then `lock` → `due` → no date; the gate runs on every generation input list (N04) |
| IP-3 | **Tutor mode on graded work:** hints and explanations only, never a submission-ready answer. In an RCT, unrestricted GPT access raised practice scores but lowered the later unassisted exam, while a hint-only tutor didn't (Bastani et al. 2025, *PNAS*; researched) | integrity gate; the CLI's appended system prompt; the strict-only Jev Noul |
| IP-4 | **Loosening needs the student to confirm the quoted syllabus sentence.** Claimed permission never loosens anything | code |
| IP-5 | **No school writes:** read-only access; no submit, enrol or post (**built**) | the connector design; the MCP tools are read-only |
| IP-6 | **The recipient is visible without friction:** consent once per provider; a context chip and a receipt on every call, including MCP tool results that carry course text; a blocking preview for the first send of each sensitive category, or always if the student chooses (§9.2) | the bridge host (N26), the core receipt path, the renderer chip |
| IP-7 | **Local-only blocks everything hosted**, Jev included (**built** for Jev) | `maySend` |
| IP-8 | **Performance data stays local** unless the student approves `learning_state` at its blocking first-send preview. Pools are generated by coverage and selected locally (§9.2) | the category gate (B11); pool design (N06, N10) |
| IP-9 | **No pass probability or readiness percentage anywhere.** Engagement features carry no learning claims | KM-6 test; copy review |
| IP-10 | **No manipulative engagement:** no lives, no paid streak repair, at most one opt-in daily reminder, no loss-framed copy | design review |
| IP-11 | **An AI-use log** for each course and assignment (role, time, prompts, what the student did next), from which the student can draft an AI Usage Statement ([integrity roles](../../notes/integrity-roles.md)) | local log |
| IP-12 | **Purge covers everything** (KM-13). Clearing the UW session stays separate (**built**) | purge test |
| IP-13 | **Imported material is labelled as imported; sample data as synthetic.** A failed live path is never replaced by fixtures (AGENTS.md) | the source label |
| IP-14 | **No credentials in context:** the runtime never reads the CLI's credential files; cookies and tokens never enter a payload | the runtime design; tests |

---

## 11. Evaluation

The method follows [benchmarking](../../notes/benchmarking.md):
- frozen gold, written independently of the pipeline
- seeded errors
- blind rating
- paired comparisons
- raw counts per course
- no Jev performance numbers in public material

Quote validity and claim support are always reported separately.

| Requirement(s) | Metric | How it's measured | Gold / data |
|---|---|---|---|
| NB-1, NB-2 | Course isolation; label correctness | Unit and integration tests with two courses whose titles collide | synthetic fixtures |
| NB-3, NB-4 | Quote validity rate; invented-quote rejection | The harness replays answers; seeded fake quotes (paraphrased, off by one, other version) | ≥30 answerable questions per course ([benchmarking](../../notes/benchmarking.md) task 2) |
| NB-5 | Correct not-found on unanswerable questions; false not-found on answerable ones | paired per question | ≥8 unanswerable questions per course |
| NB-6 | Claim-support rate, human-rated blind; and by the support checker | blind sample; the judge is a different model family or a human | stratified sample |
| NB-8, NB-10 | Entry quote validity; removals per guide; human usefulness rating (blind) | harness + blind raters | the same courses |
| NB-11 | Precision and recall of material and concept mapping | against the coverage key | the coverage key from the course calendar (task 3) |
| NB-13 | Minutes from a source change to a stale label or quarantine | a planted edit | task 6 |
| ST-1, §6.3 | **Seeded-error catch rate and false-drop rate per stage and per label** | ~20 items with wrong keys, two correct answers, no correct answer, cue flaws | task 4 |
| ST-3 | Agreement of typed grading with human grades; dispute rate | a human-graded sample | typed answers from a sample |
| ST-4 | Share of a held-out real exam's topics covered by practice built without it | a held-out public exam | task 5 |
| ST-2, KM-10 | FSRS calibration (predicted vs actual recall) | review logs | opted-in data |
| KM-4, KM-5 | Replay determinism; rule unit tests, positive and negative | property tests | synthetic event streams |
| KM-6 | No forbidden fields or strings | a type-level test and a renderer string scan | — |
| KM-1 … KM-9 | §5.10 validation plan | offline replay | tier B, opted in |
| All | Latency (cold and warm) and model usage per action on the target laptop | the harness ledger | measured, never quoted from vendors |

**Claims we won't make:** a learning gain; readiness or a pass probability; "verified" items; any vendor's speed or cost as ours; any Jev performance number.

---

## 12. Phasing

| Phase | Scope | Depends on Ben | Honest framing |
|---|---|---|---|
| **Phase 0: demo, Sunday 2026-09-27 ~10:00 CT. Headless and scripted, not in-app** | One course: its Canvas **syllabus and assignments** (what the connector reads today), or **labelled** imported material. The demo minimum ([tasks](tasks.md), N00–N07, N11, N20, N22, N27, N28) shows:<br>• the course policy from the syllabus (NB-18)<br>• a grounded answer with code-checked quotes, and an honest not-found (NB-3–5, NB-6 labels, NB-7), with passages inlined into the Claude Code route; no MCP yet<br>• the concept map (KM-1–2)<br>• checked items (ST-1, ST-10)<br>• a scripted student's answers<br>• knowledge-model states with reasons and counts (KM-3–9, KM-12, rules R1–R4)<br>• a flag removing evidence (ST-9, evidence side) | **None.** Every B task comes after the demo | "A scripted run on ⟨labelled material⟩ with a scripted student." It's reproducible by one replay command. Nothing is shown in the app |
| **Phase 0.5: right after the demo** | In-app seams and the rest of the Phase 0 journeys: Learn (ST-3), the mistakes queue (ST-6), the session builder (ST-7), the study guide (NB-8), exam coverage from the syllabus (NB-11), practice-exam tier T4 (ST-4), the MCP server and bridge | §13 decisions 1–5, 7 (B01–B04, B06, B11, B12) | As for Phase 1 |
| **Phase 1: about a week** | Codex, Gemini and OpenRouter adapters.<br>• the full guide set, mind map, exam coverage with Jev<br>• FSRS flashcards (ST-2), practice exams T1–T4 (ST-4), the path with XP and streaks (ST-5)<br>• R5–R6, self-ratings, streaming, `.docx` export<br>• support checks | Canvas modules, pages and files + extraction; Jev endpoints and budget; the streaming IPC | Labels per §6.4; no validation claims |
| **Phase 2** | Audio overview (NB-17); student notes as sources (NB-16); evidence export; payments live; signed distribution; §5.10 validation run | Licence and gateway; distribution | Thresholds stay "unvalidated" until §5.10's minimum is met |

---

## 13. Risks and open questions for Ben

### Risks
| Risk | Effect | Mitigation |
|---|---|---|
| Canvas gives only the syllabus and assignment text today (**built**) | Thin notebooks; weak coverage; no slide or page citations | Ask for modules, pages and files + extraction ([where we differ, row 1](../../notes/where-we-differ.md)); label thin notebooks |
| LLM answer keys are wrong often enough to matter (QUEST-AI: 32 of 50 GPT-4 items judged correct; researched, [performance plan §3.1](../../notes/performance-plan.md)) | Wrong feedback; evidence polluted | Code stages, support checks, flag and quarantine, disputed evidence excluded, the seeded-error evaluation |
| One learner's Elo is noisy, and item difficulty can't be learned from one student | Bands that flap or mislead | Conservative Solid; hysteresis; reasons with counts; "unvalidated" labels; §5.10 |
| Concept maps from thin material are poor | Wrong tags, wrong emphasis | Student edits that survive rebuilds; the "no source found" marker; retagging |
| A CLI changes its flags or output, or login needs a TTY | The provider route breaks | The adapter interface; a version check; practice keeps working (ST-11); the TTY probe ([agent runtime](../../notes/agent-runtime.md)) |
| Background generation spends the student's plan | Surprise limits | Nearest assessment only by default; a visible count; stop on a reported limit |
| Streaks cause pressure | Harm to wellbeing, and conflict with the calm visual direction | IP-10; the path is optional; streak loss never blocks anything |
| Hash coupling: `contentHash` includes `submitted` and `points` | Needless invalidation of cached checks | Our `text_hash` keys (§7.3) |
| `Snapshot` returns every attempt | Growth with each command as evidence accumulates | Keep learning evidence out of `Snapshot` (§8.2) |

### Decisions that reach Ben as PRs (tasks Part B, each with its rationale)
1. **Command seam** (B01, B03): one routed `{type:"learning"}` variant, plus an exhaustive check in core's switch. **Why:** it keeps the strict union small, and it closes the silent-snapshot gap for unhandled variants.
2. **Storage** (B02, B12): the extension hook (option A), the purge lines, and a purge-completeness test. **Why:** Ben's migrations stay untouched, and "Delete local data" covers everything.
3. **Jobs:** our own `learning_jobs` queue inside the extension. **Why:** `lease` has no kind filter, and core fails unknown kinds (research decision D5).
4. **Worker and IPC** (B04): the learning router and the agent runtime run in the worker; CLIs are spawned from the worker; streaming comes in Phase 1.
5. **Canvas coverage and fields** (B05, B01): modules, pages, files, announcements, the syllabus AI policy, and the optional `parts`, `role`, `term`, `module`, `format` fields, shipped together so that every hash bumps only once (D1, D6).
6. **Provider routes** (operator decision): `hostedProvider` gains `openrouter` (B01). The local model is kept only as an optional offline fallback (B10), never as the default.
7. **Privacy** (B11): a `learning_state` category, off by default; MCP tool results count as egress and write receipts.
8. **State names:** Solid / Getting there / Iffy / Not seen yet, with overconfidence as an Iffy reason (R4). **Why:** four states with reasons are easier to act on than a separate "overconfident" state, and R4 keeps the hypercorrection target visible. The product brief's wording is updated when this lands.
9. **Dependencies** (B06): ts-fsrs 5.4.2, the MCP SDK, markmap and docx, all MIT ([open-source candidates](../../notes/open-source-candidates.md)).
10. **Jev** (B07, operator decision): four versioned endpoints for item checks and coverage. There is no per-student budget, only the gateway's global abuse cap. OpenRouter-key users pay their own Jev.

### Genuinely open
1. **Where the notebook sits** among the six organizing concepts. This spec uses a per-course tab that any home view can open; Ben's choice of home view doesn't change this spec.
2. **The Codex route's file access:** it ships only after a configuration passes the N20 negative test (§8.3).
3. **Measure first:** G4 (embeddings and hybrid retrieval), G5 (structural headers stored at ingest), G10 (`typesafe/jev-router` as the default model).
4. **Accepting Anthropic's Commercial Terms** before the Claude route ships ([business model](../../notes/business-model.md)). This is a team signature, not a design question.

---

## Sources (public)
**Learning research:**
- Pelánek 2016, *Computers & Education*
- Pelánek, Papoušek, Řihák, Stanislav & Nižnan 2016, "Elo-based learner modeling for the adaptive practice of facts", *UMUAI*, doi:10.1007/s11257-016-9185-7
- Butterfield & Metcalfe 2001 (PubMed 11713883)
- Rhodes & Tauber 2011
- Rawson & Dunlosky 2011, doi:10.1037/a0023956
- Pyc & Rawson 2011
- Brunmair & Richter 2019, doi:10.1037/bul0000209
- Pan & Rickard 2018, doi:10.1037/bul0000151
- Karpicke & Blunt 2011, doi:10.1126/science.1199327
- Kang et al. 2007
- Gao et al. 2023 (ALCE)
- arXiv 2405.02985 (LLM marking of K-12 short answers)
- R2DE, arXiv 2001.07569
- Simkin et al., *J. Accounting Education*
- Bastani et al. 2025, *PNAS*, doi:10.1073/pnas.2422633122

**Citations and generated items:**
- ALCE (Gao et al. 2023)
- QUEST-AI (medRxiv)
- Moore et al. 2023

**Tools and products:**
- ts-fsrs: github.com/open-spaced-repetition/ts-fsrs
- Quizlet Learn: quizlet.com/features/learn
- NotebookLM help: support.google.com/notebooklm
- Android Police review of Gemini Study Notebooks, 2026-07-22

**Our notes:** [performance plan](../../notes/performance-plan.md), [practice engine](../../notes/practice-engine.md), [practice evidence](../../notes/practice-evidence.md), [benchmarking](../../notes/benchmarking.md), [local DB](../../notes/local-db.md), [Jev usage](../../notes/jev-usage.md), [Jev insights](../../notes/jev-insights.md), [integrity roles](../../notes/integrity-roles.md), [notes](../../notes/notes.md), [agent runtime](../../notes/agent-runtime.md), [where we differ](../../notes/where-we-differ.md).
