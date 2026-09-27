# Regressions found while landing the September 27 waves, and the rules that prevent them

## 1. Back-to-back command-bar asks wait on a CLI start
- **Symptom:** `tests/intent-latency.test.ts` went from about 35 s to 240 s on Windows (the timeout); Linux CI still passed.
- **Cause:** `f097198` ("one ask per pooled session") made each interactive session answer one ask, then started the next ask's spare only after the answer returned. Asks that arrive faster than a CLI starts each waited for a spawn. It saved input tokens (a five-ask burst no longer grows 1,607 → 3,891) but moved the cost into latency.
- **Fix so far:** the spare now starts while the current ask answers (`packages/runner/src/pool.ts`), with a guard in `tests/session-pool.test.ts` asserting the spare starts before the first ask ends. That was not enough on Windows: a spare started 40 ms before the next ask is still loading. **Fixed** by the routing table below: one warm session per course keeps a short conversation instead of respawning per ask.
- **Why it slipped:** the builder skipped the long timing test ("not run") and reported success from the short suites.

## 2. The GPA panel disappeared from My UW
- **Symptom:** GPA maths and tests merged, but nothing on screen.
- **Cause:** the GPA section was mounted in the old `MyUw.tsx`; the designed page (`myuw/MyUwPage.tsx`) replaced it, and the merge resolution took that page whole ("theirs wins"), silently dropping the mount.
- **Fix:** `myuw/Gpa.tsx` mounted in the designed page; the GPA what-if command now computes from the course history instead of replying "not on this build".
- **Guard:** `tests/feature-mounts.test.ts` lists every feature mounted into a shared page, and fails if a merge drops one.

## 3. The GPA what-if command stopped naming its action
- **Symptom:** `tests/intent-bar-misses.test.ts` ("the grade what-if runs in code…") failed on Linux CI: "what gpa do i need…" came back as an answer, not a run of `grades.gpa`.
- **Cause:** `8c89817` made the GPA adapter compute from the course history and return an answer-shaped reply.
- **Fix:** the adapter returns a `ran` result carrying the same text as `message` (the command bar shows it as a notice), so the action stays visible.

## Routing table (static, measured)
Operator direction: "ascribe what we know Jev should handle and what the model will, as we previously measured it." `packages/core/src/intent/routes.ts` is the one table; each row cites its measurement or file. `tests/intent-routes.test.ts` fails when a registered action or ask kind has no route or a route names no evidence.

| Route | Rows |
|---|---|
| **code** (0 tokens, never acquires the client or the pool) | page.open, course.open, assignment.open, agenda.due, changes.since, materials.search, grades.whatif, grades.gpa, calendar.proposeEvent, mail.search, guide.view, analytics.*, assignment.references, course.overview, practice.quiz/flashcards/learn (serve stored, checked items), notes.open/append/new/setTemplate; ask kind notInMaterials (the coverage gate) |
| **model**, pass tier, interactive (the course's warm session) | ask: explain, exam, followUp, allCourses; classify, only for an utterance code can't place |
| **model**, pass tier, background | pack.generate, notes.fillFrom, generation |
| **jev**, background | message triage (notifications.ts), assignment kind (jobs/enrich.ts) and nothing else |

**How the router uses it:** a code hit on a `code` route runs with no client at all (before, the client was acquired at submit for every command). A code hit on `ask` sends straight to the course's interactive session with no classify call. Opening the bar with a course open now pre-warms that course's ask session too (same prefix as `groundedAsk` builds), besides the classify session. Only a code miss goes to classify, unchanged; privacy checks unchanged.

**Pool lifecycle (`turns: "bounded"`, the new default for interactive lanes):** one warm session per course answers asks back to back and keeps its conversation until the history (earlier messages and replies, chars/4) reaches `INTERACTIVE_HISTORY_TOKENS` = 1,000. A spare starts at half of that, and the lane rotates to it at the budget. Each message is still only the question and its passages, plus the one earlier exchange when the question refers back. `fresh` (respawn per ask) stays available as an opt-in.

**Both sides measured (Windows laptop, fake CLI, chars/4 tokens):**

| | Before (fresh per ask) | After (bounded, 1k) |
|---|---|---|
| Five-ask burst, input tokens per turn | 1,909 / 1,910 / 1,908 / 1,908 / 1,905 (total 9,540) | 1,909 / 2,088 / 2,265 / 2,442 / 2,616 (total 11,320, +18.7%) |
| Same burst, wall time per ask | 4,517 / 1,912 / 1,474 / 1,569 / 1,051 ms | 1,221–1,406 (first spawn) / 8–9 / 520–2,027 / 10–12 / 10–14 ms over two runs (the third ask's spike is not explained yet; it has no spawn before it) |
| `intent-latency` gate test | timed out at 240 s (fail); file 440 s | passes in 79 s; file 96 s |
| End to end, 800 ms model, fallback p50 / paired added median | 3,299 ms / +864.6 ms | 814.5 ms / −6.8 ms |
| Race-mode miss p50 | 4,524 ms | 817 ms |

The token cost is the trade: the kept history re-sends up to 1k tokens per turn (on Anthropic these are cache reads at 0.1×, so the billed difference is smaller than the chars/4 count). Latency after the first ask drops from about 1–2 s to about 10 ms.

**Open (not built in this change):**
- **Voice fast path:** prewarm the course's session on mic press and send the transcript through the interactive dispatch (main still wires the trial dispatch). Needs the renderer to pass the open course at voice start.
- **Codex pre-spawned one-shot** (and the same for Claude's one-shot path) on mic press, with argv byte-identical to the normal one-shot and a test proving it.
- **Operator direction on chat and voice model:** "driven using really just the model understanding it… an opus 5.5 or gpt 6 sol… but don't close the session". Chat already uses no Jev, and the session is now kept. Moving the ask and classify rows from the pass tier to the strong tier on the interactive lane (not the escalation lane, which closes its session after each ask) is a one-row change per route plus the prewarm tier, and is left for the operator to confirm because it changes cost and latency on the student's own subscription.

## Rules
1. **A change to latency, caching or process lifecycle** runs the timing gates it could affect (`intent-latency`, `test:budgets`) before it lands. A skipped gate is reported as "not run", never as a pass.
2. **A trade-off needs both sides measured.** A token saving that adds latency, or the reverse, is reported with both numbers, and whoever decides is shown the trade-off.
3. **"Theirs wins" in a merge still keeps our mounts.** After taking one side of a page, re-mount every owner-tagged feature it hosted, and let `tests/feature-mounts.test.ts` prove it. A new mount into a shared page adds a row there.
4. **Integration reports list every dropped piece** ("left out: X, because Y") rather than folding it into "resolved".
