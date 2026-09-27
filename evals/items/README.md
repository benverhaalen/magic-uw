# Item-quality harness (measurement plan MT4)

Scores the flashcards and quiz items the app generates, through the real pack path: `generatePack` in `packages/core/src/pack-handler.ts` (scope → passages → consent and egress → the student's client → the runner's checks → the N06 pipeline → the LearningStore). Every model call is observed at the backend seam. The harness never edits a check.

- **Pre-registered:** `thresholds.json` (metrics, populations, thresholds, one dated amendment), `cases/planted.json` (planted defects) and `rubric.json` (the blind rubric). The case files are frozen (`cases/FROZEN.sha256`, `tsx evals/freeze.ts --verify evals/items/cases`).
- **Every rate** is reported with n and a Wilson 95% interval. A met threshold whose interval crosses it reads "met, not established at 95%". A missed one stays in the table.
- **Outputs** go to `.data/evals/items/<sha>/<suite>-<time>/` (gitignored): `report.md`, `report.json`, `items.jsonl`. They can hold course text, so they're never committed.

## Suites

| Suite | Writer | Corpus | Scopes | Runs in |
|---|---|---|---|---|
| `smoke` | the offline model, through the fake CLI | synthetic computing and languages | whole course | `pnpm test` (`tests/item-eval.test.ts`) |
| `offline` | the offline model, through the fake CLI | the four synthetic families, plus the local OCW copy when present | whole course and each material | on demand |
| `live` | the student's own signed-in client (the app's profile) | synthetic and OCW, or one real course from a workspace copy | whole course | the operator's session |

```
pnpm eval:items --suite smoke
pnpm eval:items --suite offline [--corpus synthetic|ocw|all] [--ocw <dir>]
```

**The offline model** (`offline-model.ts`) is a deterministic, rule-based writer, not a language model. It reads only the prompt the app sent and follows it literally (facts by sentence pattern; distractors "of similar length"; the formula "using numbers, + - * / and parentheses" with the unit apart; negations in capitals; the subject profile line when present). `planted.ts` appends known defects to the same response. **Offline numbers therefore measure the app's code, never a model's writing.** On OCW captions the rule-based writer finds few facts, so OCW runs offline are a robustness check (parsing, grounding, no crash), and subject fit and coverage count synthetic courses only there (the dated amendment in `thresholds.json`).

## The live run (the operator's session)

The harness never signs in. Sign in to Claude or Codex inside the app first; the harness then uses that app-owned profile (`clients/<client>/` under the app's userData folder), the same backends the worker uses (`apps/desktop/src/worker.ts`).

```
# Synthetic and OCW courses, the chosen client, default counts (quiz 8, cards 10):
pnpm eval:items --suite live --user-data "<the app's userData folder>" --client claude

# One real course, on a temp copy of the workspace database (the original is never written):
pnpm eval:items --suite live --user-data "<userData>" --client claude --db "<userData>/workspace.sqlite" --course <courseId>
```

- **The userData folder:** the app names itself "Magic Canvas" (`apps/desktop/src/main.ts`), so on Windows Electron's default is `%APPDATA%\Magic Canvas` (inferred from Electron's `app.getPath("userData")` default, not checked on this machine). `MAGIC_USER_DATA` overrides it. Point `--user-data` at whichever folder the signed-in app actually uses.
- **Cost:** a live run of the default corpus is about 14 pack calls (7 courses × 2 packs) plus retries. Each repeat request must cost 0 tokens, and the harness checks that.
- **Private data:** a `--db` run is Tier B. Report only aggregates; the run folder stays under `.data/`.

## The blind rubric step (bench-judge seat or human raters)

```
tsx evals/items/blind.ts export --ours <run>/items.jsonl --ours-family anthropic \
  --theirs <export.txt> --theirs-format quizlet --theirs-name Quizlet --theirs-family unknown \
  --reference <the course text both tools were given> --seed 20260927 --limit 60 \
  --out .data/evals/items/blind/<name>
# the raters fill ratings.jsonl per judge-brief.md, then:
tsx evals/items/blind.ts score --export .data/evals/items/blind/<name> --ratings r1.jsonl [--ratings r2.jsonl]
```

- **What the export does:** it writes one shuffled set with no system names, no quotes and one surface format (`tasks.jsonl`). It also pairs items across systems by shared words, each pair in both orders and placed separately (`pairs.jsonl`). It writes the rubric and the brief, and the key sealed in `sealed/key.json`. The seed, counts and hashes go in `manifest.json`.
- **What the scorer does:** it refuses an LLM rater of the same model family as any generator in the set (MT4's negative check, exit 3). It reports per-system means and the acceptable share (≥ 3) with Wilson intervals, and order-swap consistency (Zheng et al. 2023, arXiv 2306.05685, sourced in the benchmark-validity brief). With two raters it also reports Cohen's kappa per dimension, quadratic-weighted for the ordinal scale.
- **Other tools' exports:**
  - `quizlet`: one card per row, front then back, tab-separated unless `--delimiter` says otherwise. Quizlet's own help page on exporting could not be fetched (a Cloudflare challenge, https://help.quizlet.com/hc/en-us/articles/360034345672-Exporting-your-sets), so the format is **not verified**. Match `--delimiter` to what the export dialog was set to.
  - `csv`: a header with `front,back` or `question,a,b,c,d,answer`. Use it for NotebookLM or any other tool: whether NotebookLM exports flashcards or quizzes as a file is **not found**.

## What the offline runs showed, and what changed

Both runs used the same harness and corpus. **Baseline** is the pack code at `10eeb2d`; **after** is this branch.

| Metric | Baseline | After |
|---|---|---|
| planted-defect catch | 0.69 (43/62; CI 0.57-0.79), missed | 0.98 (58/59; CI 0.91-1.00) |
| false drops of correct items | 0.03 (5/198; CI 0.01-0.06) | 0.00 (0/196; CI 0.00-0.02) |
| cue-flaw rate | 0.01 (2/200; CI 0.00-0.04) | 0.00 (0/197; CI 0.00-0.02) |
| subject fit | 0.75 (3/4; CI 0.30-0.95), missed | 1.00 (4/4; CI 0.51-1.00) |
| prompt carries the subject profile | 0.00 (0/57; CI 0.00-0.06), missed | 1.00 (57/57; CI 0.94-1.00) |
| cloze answers left visible in the stem | 2 of 59 | 0 of 53 |
| reverse vocabulary cards | 0 | 14 |

The other rows met their thresholds in both runs:
- parse 1.00 (147/147)
- verbatim quotes 1.00
- single key 1.00
- duplicates at most 0.01
- repeat requests at 0 tokens, 38/38
- module coverage 12/12
- gold-topic coverage 0.69 (35/51)

**The one planted defect still reaching the student** is the unparseable response (item 4 below).

1. **Numeric items with a unit were dropped when correct.** The prompt asks for a formula "using numbers, + - * / and parentheses" and the unit apart. Stage 6 compares units, so "25 * 4" against 100 bytes failed. `withUnit` in the quiz pack now applies a one-word unit to a unitless formula. The value is still recomputed, so a wrong value still fails.
2. **Cloze cards could teach a false sentence, leak their answer, or blank nothing worth recalling.** The pack now:
   - requires the cloze sentence to lie inside the verified quote
   - blanks every occurrence of the answer. At baseline, "(15 - 3) / (5 - 1) = 3" was stored with the operand blanked and "= 3" left showing. Blanking every occurrence can also blank an operand that equals the answer; the card stays correct and answerable.
   - rejects a blank that is only function words or covers most of the sentence
   - capitalises negations in the stem, so a verbatim sentence with "not" isn't dropped by the negation rule
   - rejects a term card whose back only repeats its front
3. **No subject profile reached the model (plan D35, D52).** The handler now derives the family from the course code and title (`subjectFamily`), and both packs state that family's item mix. Language courses also get each vocabulary card in both directions, made by code at 0 tokens (`reverseCards`; ids end in `r`).
4. **Not fixed here (outside this harness's files):** an unparseable model answer makes the pack command throw. The runner writes a ledger row with `model: ""`, and `addLedgerEntry` rejects it (a ZodError), so there's no retry. The `probe-unparseable` unit and a `todo` test in `tests/item-eval.test.ts` keep it visible.

## What these numbers cannot show

- **Offline:** code behaviour only. The writer, the planted defects and the gold topics are builder-written, not independent.
- **Live:** one client, model and date. There are no false-drop labels, and OCW text may be in the model's training data (contamination not ruled out).
- **Neither:** learning gain, exam prediction, or a comparison with another tool. Those need the blind rubric step, with raters from outside the generator's model family.
