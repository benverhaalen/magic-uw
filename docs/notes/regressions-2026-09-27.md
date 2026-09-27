# Regressions found while landing the September 27 waves, and the rules that prevent them

## 1. Back-to-back command-bar asks wait on a CLI start
- **Symptom:** `tests/intent-latency.test.ts` went from about 35 s to 240 s on Windows (the timeout); Linux CI still passed.
- **Cause:** `f097198` ("one ask per pooled session") made each interactive session answer one ask, then started the next ask's spare only after the answer returned. Asks that arrive faster than a CLI starts each waited for a spawn. It saved input tokens (a five-ask burst no longer grows 1,607 → 3,891) but moved the cost into latency.
- **Fix so far:** the spare now starts while the current ask answers (`packages/runner/src/pool.ts`), with a guard in `tests/session-pool.test.ts` asserting the spare starts before the first ask ends. The Windows latency test still runs long, so the remaining cause (the live-session cap or prefix changes between packs forcing respawns) is open.
- **Why it slipped:** the builder skipped the long timing test ("not run") and reported success from the short suites.

## 2. The GPA panel disappeared from My UW
- **Symptom:** GPA maths and tests merged, but nothing on screen.
- **Cause:** the GPA section was mounted in the old `MyUw.tsx`; the designed page (`myuw/MyUwPage.tsx`) replaced it, and the merge resolution took that page whole ("theirs wins"), silently dropping the mount.
- **Fix:** `myuw/Gpa.tsx` mounted in the designed page; the GPA what-if command now computes from the course history instead of replying "not on this build".
- **Guard:** `tests/feature-mounts.test.ts` lists every feature mounted into a shared page, and fails if a merge drops one.

## Rules
1. **A change to latency, caching or process lifecycle** runs the timing gates it could affect (`intent-latency`, `test:budgets`) before it lands. A skipped gate is reported as "not run", never as a pass.
2. **A trade-off needs both sides measured.** A token saving that adds latency, or the reverse, is reported with both numbers, and whoever decides is shown the trade-off.
3. **"Theirs wins" in a merge still keeps our mounts.** After taking one side of a page, re-mount every owner-tagged feature it hosted, and let `tests/feature-mounts.test.ts` prove it. A new mount into a shared page adds a row there.
4. **Integration reports list every dropped piece** ("left out: X, because Y") rather than folding it into "resolved".
