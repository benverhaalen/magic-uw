# Checked quotes, unchecked sentences

Magic UW's entry for **The Art of the Break**: one failure specific to how we built the app, how often it happened, what we did to stop it and what we learned.

The one-page submission is [break-card.pdf](break-card.pdf) (source: [break-card.tex](break-card.tex), written in ASD-STE100 Simplified Technical English; build with `pdflatex break-card.tex`).

## The failure

A grounded answer in Magic UW is a set of short sentences. Each one cites a quote from the student's own course materials. The student's own AI (Claude Code or Codex) writes the sentences, and code checks the evidence. `checkAnswer` (`packages/core/src/intent/ask.ts`) confirmed that every cited quote was in its passage. It never compared the sentence with the quote.

So a sentence could cite *"final project 45%"* (a real quote that passes the check) and say the project was worth 30%. The wrong number reached the student with a working citation beside it, which made it look more trustworthy. Our own agent wrote exactly that sentence in our live stress test (below).

This came from our own design rule: "AI writes, code decides." We trusted a check that proved the quote was real, not that the sentence said what the quote says. Reviewing the code for the same pattern found three more places where a check confirmed the evidence but not the claim built on it:
- **B2:** course mail was labelled "Course staff" when its subject named the course code.
- **B3:** an AI judgment could raise mail to urgent with no cap.
- **B4:** any link that named the course number was synced as the course site, even one posted in a discussion.

## How often

**Live stress test of our agent, 2026-09-27.** The student's own Claude Code (`claude-sonnet-5`) answered through the app's real ask prompt and schema, using the instant-mode client path the app uses. We ran the build the first fix shipped in (`0f710ed`), then that same build with the final fix. There were 20 synthetic course scenarios built to provoke the failure, each run 3 times (60 answers):
- an announcement that supersedes a syllabus date, room or weight
- neighbouring numbers
- answers that need arithmetic
- weekdays
- two courses side by side

The intervals below are Wilson 95%, and we read every sentence ourselves.

| What is counted (live) | First fix, as shipped (87 sentences) | Final fix (80 sentences) |
|---|---|---|
| Sentences contradicting their own cited quote (the failure) | 0/87 | **1/80** [0.2, 6.7], caught |
| Contradicting sentences the student sees | 0/87 | **0/77** [0, 4.8] |
| Answers where a *correct* sentence was replaced by its quote (false reject) | **15/60** [15.8, 37.2] | **2/60** [0.9, 11.4] |

Across both runs, 1 in 167 sentences contradicted its quote. Without the fix it would have been shown with a working citation.

**Targeted cases (regression tests).** These use a scripted fake model and fake AI judgments, 60 generated cases per row. "Before" is `02c5c19`; we reran it today.

| | What is counted | Before | After |
|---|---|---|---|
| B1 | Sentence contradicting its real quote is shown | 60/60 | 0/60 [0, 6.0] |
| B2 | Outside sender with a course code in the subject labelled "Course staff" / urgent | 60/60 · 60/60 | 0/60 · 0/60 |
| B3 | Unknown sender raised to urgent by an AI "deadline due soon" judgment | 60/60 | 0/60 |
| B4 | Discussion-only link naming the course number synced as the course site | 60/60 | 0/60 |
| recall | Known staff mail still urgent (B2, B3); linked course sites still synced (B4) | 60/60 | 60/60 |

## What we did

- **First fix (B1):** `checkAnswer` also checks the claim (`claimsMatch`): every date, weekday, number and name in a sentence must appear in its cited quotes. If one doesn't, the sentence is replaced by the quote, verbatim and still linked. The fake-model tests passed at 0/60 false rejects.
- **The live run broke that fix.** It replaced a correct sentence in 15/60 answers, and all 17 sentences it flagged were correct. The causes were:
  - computed answers ("63 days", "175 points"), where the number the student asked for was lost
  - labels just outside the quoted words ("Homework 4", a heading date)
  - the room "B10" read as the name "B"
- **Final fix:**
  - A kind of detail the quote states (a date, weekday, name, label or code) must match it. A kind it doesn't state may come from the rest of the cited passage.
  - A computed number passes only when the sentence writes the arithmetic from quoted numbers and code re-does it: "8 − 1 = 7 count, so 7 × 25 = 175 points", "3 × 24 = 72 hours", "October 13 + 7 days", or the days between two named dates. The ask prompt now asks for that. Wrong arithmetic is replaced.
  - A second live run found three more shapes (6/60), which were fixed before the final run. The 2 remaining false rejects are "25 + 30 + 8 = 63" (25 and 30 aren't quoted) and "week of October 20" with no calculation shown.
- **B2–B4:**
  - Mail matched only by its subject is labelled "Mentions <course>", and nothing more.
  - An AI raise moves mail at most one level, and only course staff can reach urgent.
  - A host linked only from a discussion is never synced as the course site.

## What we learned

- A verifier must check the claim, not just the evidence. A real citation on a wrong sentence is worse than no citation.
- **A verifier tuned on failures you wrote yourself over-fires on real output.** Ours passed every synthetic test and then rejected a correct sentence in a quarter of live answers. Measure the cost on the real agent, and fix it there.
- Give computed claims a lane: the model shows its arithmetic, and code re-does it. That is how "AI writes, code decides" works for numbers nobody quoted.

**Reproduce:**
- Live (a signed-in Claude Code, 60 calls, about 180k input tokens, 155k of them cached): `pnpm exec tsx evals/break-live/run.ts 3 5`. The raw answers and per-sentence verdicts are in `evals/break-live/results.json` (final fix) and `results-shipped-0f710ed.json` (first fix).
- Targeted and regression tests: `pnpm exec tsx --test tests/break-*.test.ts`.

Every page is synthetic: no course data and no student data.
