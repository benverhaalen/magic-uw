# Course compile: the model understands each course, code checks it

> **Superseded in part by the [course backend spec](../2026-09-26-course-backend/spec.md) (2026-09-26 late).**
> - **Models:** the pass now starts on GPT-6 Sol for Codex users, not Luna. gpt-5.6-terra is rejected, being older and more expensive.
> - **Views:** the dossier and assignment views have explicit caps (spec C5).
> - **Jev:** item cards need a gateway change first (plan D16).
>
> Still current: the pipeline shape, the checks, and the transcript and watch-link decisions.

**Status: Design, decided unless marked.** Written 2026-09-26.
- It replaces rule-only exam coverage from [design.md](design.md) §3.3 and [accuracy.md](accuracy.md) §3.
- It builds on the team's course-compiler design: harvest, then understand items, compile the course, link, precompute.

**The operator's direction:** course layouts vary too much for rules to be trusted. The model drives the understanding, with Jev for small typed calls, and the system adopts it wherever the tools let the model do the job accurately. Transcripts are used as provided. Recordings keep their stored link.

## 1. The decision

**Every course gets one compile by the student's own AI, per term and whenever its scope changes. decided**
- **Who does what:**
  - Code builds the input and checks the output.
  - Jev answers the per-item and per-link questions.
  - The student confirms.
- **The rules' role:** the signal ladder in [accuracy.md](accuracy.md) is no longer the decider. It becomes (a) the input the model is given and (b) a cross-check that flags disagreements.

**Why the model and not rules:** the hard part is language, not structure. Examples:
- "Midterm 2 covers everything since the first midterm, except the guest lecture."
- "See the course calendar; the syllabus schedule is tentative."
- "Chapters 4–6 and the lab on hashing."

A model reads these across a syllabus PDF, a calendar page, an external site and an announcement in one pass. Code can't. Code **can** check every claim the model makes against the source, and that check is what makes the model's answer trustworthy.

## 2. What the model must handle, and how

| What varies | Example | How it's handled |
|---|---|---|
| Where the schedule lives | a syllabus body, PDF, Box link, "course calendar" page or external site | code gathers every schedule-like source into the input, with its item ID, date and last-modified date; the model is told that newer instructor statements override older ones |
| How scope is stated | "weeks 5–9", "lectures 10–18", "chapters 4–6", "since the first midterm", "cumulative" | the model **extracts the statement verbatim, with its source ID**, then maps it to sessions or items. Code re-resolves week, lecture and date ranges itself and flags any mismatch |
| Scope never stated | no statement anywhere | the model says `stated: false` and proposes a window (previous assessment → this one), marked **inferred**; the student sees "not stated by the instructor" |
| Conflicting statements | the syllabus says weeks 5–9; a later announcement says weeks 5–8 | the newest instructor statement wins; both are kept, with a conflict badge |
| Layout with little in Canvas | only a gradebook; everything on an external site | the input includes the ingested external pages. If still no schedule is found, the output says so and the course runs on Jev links plus student confirmation |
| Recordings | Kaltura items with titles, recording dates, captions or none | the input has title, date, duration and the first ~2 minutes of transcript per recording (lecturers often say "today we cover…"). **Full transcripts are not sent to the compile.** They go to per-item understanding and retrieval |
| Topics | named in slides, readings and titles | the model produces the course's unit → topic list; Jev tags each item against it (§3, C4) |
| Output drift | invented IDs, dates or quotes | a strict JSON Schema. Every field cites `{sourceId, quote}`. Code rejects any quote not found verbatim, any unknown ID, and any date outside the term |

## 3. The pipeline

| Step | Who | What |
|---|---|---|
| **C0 Manifest** | code | Builds a compact input, with one line per item: `id · type · title · module#position · created/unlock/due dates · link`. It adds the syllabus text, schedule-like pages (HTML tables turned into rows by code), each assessment with its description, and announcements that mention an assessment (found by keyword). Recordings get title, date, duration and a transcript head. Typical size: tens of thousands of tokens per course (inferred; logged per run) |
| **C1 Compile** | the student's AI, **one structured call** ([design.md](design.md) §4.2 flags; `--json-schema` / `--output-schema`) | Returns: sessions (date → topic), units and topics, and each assessment with its date, format, weight and scope (`stated` + quote + source, or an inferred window). It also maps scope to item IDs, with a one-line reason per item, and extracts policies (AI use, late work, collaboration). **Every field cites a source** |
| **C2 Check** | code | quotes verbatim; IDs exist; dates inside the term; weights sum to about 100%; week and lecture ranges re-resolved in code and compared; disagreements with the signal ladder listed |
| **C3 Repair or escalate** | the student's AI | Failing checks go back once, with the errors listed. If they still fail, the next model tier runs (§4). What's still unresolved goes to the student as questions |
| **C4 Link** | Jev | One request per item for the item card: role, topics, which session. Then one request per assessment, a yes or no for each candidate item not already mapped with a reason. Results are stored by item hash and never recomputed unless the item changes |
| **C5 Confirm** | the student | One screen per upcoming assessment: the scope statement with its quote and link, the mapped materials with their reasons, and the conflicts. Confirming locks it |
| **C6 Stay live** | code → Jev → AI | A new or changed item gets C4 only. A new scope statement or changed assessment re-runs C1 **for that one assessment** (a small call). A confirmed scope that changes is flagged, never silently rewritten |

Precompute and flashcards then build only from confirmed, or clearly stated, scopes ([design.md](design.md) §4).

## 4. Which model

**The compile runs on the student's AI route.** On a subscription it uses their plan's quota, not money. On the OpenRouter-key route it costs the student per token. Per course, assuming ~100k input and ~8k output tokens (both inferred; the ledger records real numbers):

| Route | First try | If checks fail | Price per million tokens, in / out | ≈ per course, first try |
|---|---|---|---|---|
| Claude Code | **Sonnet 5** | Opus 5.5 | Sonnet $2 / $10 · Opus $4 / $20 | $0.28 (Opus $0.56) |
| Codex | **gpt-6-luna** | gpt-6-sol | Luna $0.10 / $0.50 · Sol $2 / $10 | $0.014 (Sol $0.28) |
| Gemini CLI | the provider's fast tier (name confirmed by probe) | its pro tier | not checked | — |
| OpenRouter key | the cheapest of the above the key can reach | the next tier | as listed | — |

Sources: Anthropic prompt-caching pricing table; OpenAI model pricing (checked 2026-09-23).

**Why cheap first, then escalate:** a cascade that validates and escalates "can match the performance of the best individual LLM (e.g. GPT-4) with up to 98% cost reduction" (FrugalGPT, arXiv 2305.05176). Our check (C2) is code, so escalating costs nothing to decide.
- **Luna:** OpenAI positions it as "fast and affordable for easier tasks"; extraction and structured summaries are what the compile mostly is.
- **Opus 5.5 and Sol are reserved** for courses that fail the checks, and for the hardest courses: those with no schedule anywhere.

**Student cost:** 5 courses × one compile per term, plus small per-assessment re-runs, is a few dollars on the most expensive first-try route and a few cents on Luna. Precompute for upcoming exams is the larger, ongoing spend. It's bounded by consent and the 10-day window ([design.md](design.md) §4.1).

**Jev** does the per-item and per-link typed calls (C4). These are the many small calls that would cost an AI call each otherwise. Jev's figures stay in the team's private notes until the vendor agreement allows publishing them.

## 5. Transcripts and the recording link

**Used as provided. decided** (the operator: inaccurate transcripts are fine when they're the course's resource).
- **Grounding:** transcripts can ground answers and cards. Every such citation reads "Lecture 14 recording · 12:34 · machine transcript" and carries a **watch link** built from the stored recording link plus the segment's start time. The student can check the exact moment in one click. The time-offset format for UW's Kaltura player is confirmed by probe K1.
- **Card priority:** when the same fact is in slides or readings, the card cites those first, and the recording as a second source.
- **No captions:** the recording still dates its session, its title still feeds the compile, and its watch link still appears in the assessment's materials.

## 6. How we know it works, without a benchmark project

- **Every run is checked by code (C2).** Invented quotes, IDs and dates never reach the student.
- **The live ledger:** for every compile it records model, tokens, latency, check failures, escalations, and the student's edits at confirmation. **Edits per confirmed assessment is the running accuracy signal**, visible to us only as aggregates the student chooses to share.
- **Smoke run tonight:**
  1. Compile the operator's synced courses with the first-try and escalation models on each available route.
  2. The operator confirms the scopes.
  3. Record check failures, edits and cost per model.

  This picks the defaults. The measurement program in [accuracy.md](accuracy.md) §4 becomes optional follow-up.

## 7. Open

- **Probe K1:** can the signed-in session read Kaltura captions, and what start-time parameter does the watch link need?
- **Gemini tiers:** the fast and pro tier model names, confirmed by probe.
- **Merging with the current design:** C0–C6 map onto the team's course-compiler steps. The current design owns the storage tables for the course graph (schema v4 PR).
