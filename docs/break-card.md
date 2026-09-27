# Checked quotes, unchecked sentences

Magic UW's entry for **The Art of the Break**: one failure specific to how we built the app, how often it happened, what we did to stop it and what we learned.

## The failure

A grounded answer in Magic UW is a set of short sentences, each citing a quote from the student's own course materials. The model writes the sentences; code checks the evidence. `checkAnswer` in `packages/core/src/intent/ask.ts` found every cited quote in its passage and dropped any sentence whose quotes were missing. It never compared the sentence with the quote.

So an answer could cite *"The midterm exam is on October 14 in 1240 Humanities."* (a real quote that passes the check) and say *"Your midterm is on Oct 21."* The student saw the wrong date with a working citation beside it. The citation made the wrong sentence look more trustworthy.

This comes from our own design rule: "AI writes, code decides" (every quote, ID and date is checked by code). We trusted a code check that proved the quote was real, not that the answer said what the quote says. Reviewing the code for the same pattern turned up three more places where a check confirmed the evidence but not the claim built on it:

- **B2, course mail.** `categorizeMail` (`packages/connectors/src/graph.ts`) linked mail to a course when the subject named the course code. The notification rules then labelled it "Course staff" and let a change keyword make it urgent, whoever sent it.
- **B3, Jev raises.** A Jev judgment could raise mail but never lower it. Raising had no cap, so an unknown sender could go straight from "not notified" to urgent.
- **B4, course sites.** `decideByCode` (`packages/core/src/site-triage.ts`) synced any host whose address named the course number, including a link a student posted in a discussion.

## How often

Each row is a set of generated synthetic cases: ordinary course passages, course mail and course links, a scripted fake model and fake Jev judgments. **There was no live model run and no real course data.** "Before" is the code at `7b9bdf9`; "after" is this change. The counts are over targeted cases, so "before" shows that the weakness fired every time its trigger was present. It is not a measure of how often a real model produces the trigger. The intervals are Wilson 95%.

| | What is counted | N | Before | After |
|---|---|---|---|---|
| **B1** | Sentence contradicting its real quote is shown (date, number, name, weekday, room) | 60 | 60 (100%) [94.0, 100] | 0 (0%) [0, 6.0] |
| B1 | Correct paraphrase rejected (false reject) | 60 | 0 (0%) [0, 6.0] | 0 (0%) [0, 6.0] |
| **B2** | Outside sender with a course code in the subject labelled "Course staff" | 60 | 60 (100%) [94.0, 100] | 0 (0%) [0, 6.0] |
| B2 | Same mail shown as urgent | 60 | 60 (100%) [94.0, 100] | 0 (0%) [0, 6.0] |
| B2 | Known staff address, same subjects, still urgent (recall) | 60 | 60 (100%) | 60 (100%) [94.0, 100] |
| **B3** | Unknown sender raised to urgent by a Jev "deadline due soon" judgment | 60 | 60 (100%) [94.0, 100] | 0 (0%) [0, 6.0] |
| B3 | Staff mail with the same judgment still urgent (recall) | 60 | 60 (100%) | 60 (100%) [94.0, 100] |
| **B4** | Discussion-only link naming the course number synced as the course site | 60 | 60 (100%) [94.0, 100] | 0 (0%) [0, 6.0] |
| B4 | Same addresses linked from modules or the syllabus still synced (recall) | 60 | 60 (100%) | 60 (100%) [94.0, 100] |

The first B1 run of the false-reject set rejected 8 of 60 correct sentences, because the claim check did not read plural weekdays ("Thursdays"). We fixed the parser, not the cases. The correct answers are phrased by us, so real model phrasing will vary more (for example "Rm 1240" or a first name only); expect some false rejects in use. A rejected sentence shows the quote itself, so the student loses wording, never the fact.

Reproduce with `pnpm exec tsx --test tests/break-*.test.ts` (it prints the "after" rates). The generators are in `tests/break-cases.ts` and the measurements in `tests/break-measure.ts`.

## What we did

- **B1:** `checkAnswer` now also checks the claim (`claimsMatch` in `packages/core/src/intent/ask.ts`). Every month-day date, weekday, number and capitalized name in a sentence must appear in the quotes it cites. If one doesn't, the sentence is replaced by the cited quote, verbatim and still linked.
- **B2:** mail matched only by its subject is labelled "Mentions <course>", at most important (`packages/domain/src/notifications.ts`, `subjectOnlyReasonPrefix`). "Course staff" and keyword urgency need a known staff address from `graph.ts`. Canvas notification mail was already handled by the Canvas change itself. There is a cost: nothing fills the course directory's `staffEmails` yet. Until something does, an instructor's email reaches important but not urgent.
- **B3:** a Jev raise now moves at most one level (not notified counts as info), and only course staff can be raised to urgent (`notifications.ts`, the mail triage block).
- **B4:** a host linked only from a discussion is `link_only` whatever its address names (`packages/core/src/site-triage.ts`). `locationOf` now labels discussion topics as discussions; before, they were counted as announcements.
- Regression tests: `tests/break-ask-claims.test.ts`, `tests/break-mail-senders.test.ts` and `tests/break-site-links.test.ts`. They are free, run in CI and use only the fake model.

## What we learned

- A verifier must check the claim, not just the evidence. A real citation on a wrong sentence is worse than no citation.
- Wherever code "confirms" something, ask what exactly it proved. Each of the four checks proved something narrower than the decision that relied on it.
- Stopping the failure is not enough: measure the recall cost. When the fix rejects a sentence it shows the quote, and staff mail keeps its urgency.
