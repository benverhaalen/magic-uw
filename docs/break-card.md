# Checked quotes, unchecked sentences

Magic UW's entry for **The Art of the Break**: one failure specific to how we built the app, how often it happened, what we did to stop it and what we learned.

## The failure

A grounded answer in Magic UW is a set of short sentences. Each one cites a quote from the student's own course materials. The student's own AI (Claude Code or Codex) writes the sentences, and code checks the evidence. `checkAnswer` (`packages/core/src/intent/ask.ts`) confirmed that every cited quote was in its passage. It never compared the sentence with the quote.

So an answer could cite *"The midterm exam is on October 14 in 1240 Humanities."* (a real quote that passes the check) and say *"Your midterm is on Oct 21."* The wrong date would reach the student with a working citation beside it, which made it look more trustworthy.

This came from our own design rule: "AI writes, code decides." We trusted a check that proved the quote was real, not that the sentence said what the quote says. Reviewing the code for the same pattern found three more places where a check confirmed the evidence but not the claim built on it:
- **B2:** course mail was labelled "Course staff" when its subject named the course code.
- **B3:** an AI judgment could raise mail to urgent with no cap.
- **B4:** any link that named the course number was synced as the course site, even one posted in a discussion.

## How often

**Live stress test of our agent (2026-09-27).** The student's own Claude Code answered through the app's real ask prompt and schema, using the instant-mode client path the app uses. The model was `claude-sonnet-5`. We ran the build the fix shipped in (`0f710ed`). There were 20 synthetic course scenarios built to provoke the failure, each run 3 times: 60 answers with 87 sentences. The scenarios were:
- an announcement that supersedes a syllabus date, room or weight
- neighbouring numbers
- answers that need arithmetic
- weekdays
- two courses side by side

The intervals below are Wilson 95%.

| What is counted (live) | Result |
|---|---|
| Sentences stating a fact that their cited quote contradicts (the failure) | **0/87** [0, 4.2] |
| Sentences with a date, number or name that isn't in their own quote; the old check showed these unexamined | 17/87 [12.6, 29.1] |
| … of those, correct when a person reads them | 17/17 |
| **Answers where the fix replaced a correct sentence with its quote (false reject)** | **15/60** [15.8, 37.2] |
| … answers needing arithmetic / answers to an update / all others | 9/12 · 6/12 · 0/36 |

**Targeted cases (regression tests).** These use a scripted fake model and fake AI judgments, 60 generated cases per row. "Before" is `02c5c19` and "after" is `0f710ed`; we reran both today.

| | What is counted | Before | After |
|---|---|---|---|
| B1 | Sentence contradicting its real quote is shown | 60/60 | 0/60 [0, 6.0] |
| B2 | Outside sender with a course code in the subject labelled "Course staff" / urgent | 60/60 · 60/60 | 0/60 · 0/60 |
| B3 | Unknown sender raised to urgent by an AI "deadline due soon" judgment | 60/60 | 0/60 |
| B4 | Discussion-only link naming the course number synced as the course site | 60/60 | 0/60 |
| recall | Known staff mail still urgent (B2, B3); linked course sites still synced (B4) | 60/60 | 60/60 |

**How to read this:** the weakness fired every time its trigger was present. Our live agent never produced the trigger in 60 answers, which puts the rate for this model and these scenarios at or below 4.2%. That doesn't hold for every model or course. Our fix, meanwhile, cost a quarter of the live answers a correct sentence.

## What we did

- **B1:** `checkAnswer` now also checks the claim (`claimsMatch`): every month-day date, weekday, number and capitalized name in a sentence must appear in the quotes it cites. If one doesn't, the sentence is replaced by the cited quote, verbatim and still linked.
- **B2–B4:**
  - Mail matched only by its subject is labelled "Mentions <course>", and nothing more.
  - An AI raise moves mail at most one level, and only course staff can reach urgent.
  - A host linked only from a discussion is never synced as the course site.
- **What the live run showed the fix gets wrong** (not fixed yet):
  1. **Arithmetic** (11 of 17 flagged sentences). "63 days" between October 6 and December 8 isn't in any quote, so the student who asked "how many days?" sees only the two dates. The number they asked for is lost.
  2. **Labels outside the quoted span** (3 of 17): "Homework 4" and "Sep 20" come from the passage, not from the quoted words.
  3. **A parser bug** (3 of 17): the room code "B10" is read as the name "B".

## What we learned

- A verifier must check the claim, not just the evidence. A real citation on a wrong sentence is worse than no citation.
- **A verifier tuned on failures you wrote yourself over-fires on real output.** On our synthetic cases the fix wrongly rejected nothing; live it rejected a correct sentence in 15 of 60 answers, and none of the 17 sentences it flagged was actually wrong. Measure the cost on the real agent before you trust the fix.
- A strict check needs a lane for computed claims. The model should show its arithmetic from quoted numbers, and code should re-derive the result.

**Reproduce:**
- Live (a signed-in Claude Code; 60 calls, about 170k input tokens, 144k of them cached): `pnpm exec tsx evals/break-live/run.ts 3 5`. The raw answers and per-sentence verdicts are in `evals/break-live/results.json`.
- Targeted: `pnpm exec tsx --test tests/break-*.test.ts`.

Every page is synthetic: no course data and no student data.
