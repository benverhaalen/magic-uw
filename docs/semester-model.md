# Semester model: what a student's semester costs, ours vs a typical AI study tool

Status: **modelled on synthetic data, with measured prompt sizes; not live.** Every number below is labelled: *measured* (from the harness), *inferred* (from a published rate, with our arithmetic), or *assumed* (our stated choice). The live baseline has not been run, so neither side has a measured model latency or a live correctness score yet.

## Result

Mid usage, one student, one 105-day semester, actions 1–7 and 10 (actions 8 and 9 are left out on both sides because ours doesn't answer them yet):

| System | Model tokens | $ at list price | Uses answered with 0 tokens | Median latency per use |
|---|---|---|---|---|
| Ours, one-shot runner | 0.40 M | $1.91 | 55% | 7 ms, a code path (measured) |
| Ours, warm session pool (what the command bar uses) | 0.51–0.53 M | $2.13–2.24 | 55% | 7 ms, a code path (measured) |
| Typical, whole context, no caching | 0.86 M | $2.70 | 1% | not measured |
| Typical, whole context + prompt caching | 0.86 M (0.59 M are cache reads) | $1.71 | 1% | not measured |
| Typical, retrieval + prompt caching | same as cached at this corpus size | $1.71 | 1% | not measured |

Ranges over usage: ours one-shot $0.07 (low) to $3.22 (high); typical with caching $0.48 to $2.84. The full tables, including low and high use and all ten actions, are in `evals/semester/out/semester.md` after a run.

What this says:

- **About half of a mid-use student's actions cost our side nothing.** "What's due", "what changed", "find the slides", and reviewing a saved quiz or deck run in code in milliseconds. At low use the share is 88%. The typical tool answers almost every action with a model call.
- **On a small course corpus, a caching-aware typical tool costs slightly less in dollars than we do.** It sends about twice our tokens, but most of them are cache reads at a tenth of the price. We don't win on dollars at this scale, and we say so.
- **Our warm pool costs more per ask than our one-shot runner.** Its prefix carries the classify/ask union schema (998 tokens against 272). That is just under the 1,024-token caching minimum, so it is never cached, and in a burst of asks it also re-sends the history. This is a finding about our system, not the baseline.
- **Our output tokens are high.** Generated quizzes and cards come back as JSON with a verified quote per item, and at mid use that is about 128k output tokens, billed at 5× the input price.
- **The gap opens with the size of the course.** On an assumed 100k-token corpus, our cost stays where it was, because we retrieve the top passages. The typical tool costs $114 with whole context and no caching, $36.69 with caching, and **$6.98 with retrieval and caching**. The retrieval figure is the fair comparison, since real products switch to retrieval at that size.

## Method

1. **One synthetic semester** (`evals/semester/workspace.ts`) has three courses. One of them has a hashing lecture, a syllabus, graded work, an announcement that moves a deadline overnight, and a TA email. No real data.
2. **Ten everyday actions** run through the code path the desktop worker wires (`evals/semester/ours.ts`). The student's model is played by the fake CLI (`tests/fixtures/fake-cli`). Calls are counted from its log. Prompt size is every character that reached it (system-prompt file + JSON schema + stdin). Tokens = characters ÷ 4, an approximation, not a tokenizer. Both routes are measured: the one-shot runner, and the warm session pool the command bar actually uses (`packages/runner/src/pool.ts`), including a five-ask burst in one session.
3. **The baseline** (`evals/semester/typical.ts`) is a Projects/NotebookLM-style notebook holding every source the student would upload. It is priced in three variants (below).
4. **The projection** (`evals/semester/model.ts`) multiplies each action's per-use cost by the usage mix, for low, mid and high use, over 105 days. It prices at Sonnet 5's list price, $2 in and $10 out per million (the course-backend plan's price table, OpenRouter, 2026-09-26), with Anthropic's cache multipliers: write 1.25×, read 0.1×, and nothing cached under 1,024 tokens.

## The actions

| # | Action | Where it starts in our app | Ours: path, calls per use (measured) | Ours: prompt tokens (measured) | Typical: prompt tokens (measured) |
|---|---|---|---|---|---|
| 1 | What's due this week | command bar | code, 0 | 0 | 1,297 |
| 2 | What changed since yesterday | Today rail (the bar answers "Not in your materials.") | code, 0 | 0 | 1,299 |
| 3 | Explain a topic from lecture | bar, course open | model, 1 | 881 one-shot / 1,607 warm | 1,306 |
| 4 | Quiz me (5 questions) | generation through the pack handler, then the bar | model once per topic, then code | 1,316 per generation | 1,312 per generation |
| 5 | 20-card flashcard review | generation through the pack handler, then the bar | model once per topic, then code | 1,092 per generation | 1,311 per generation |
| 6 | Find the slides for a topic | command bar | code, 0 | 0 | 1,298 |
| 7 | When and where is the exam, what's on it | bar, course open | model, 1 | 435 one-shot / 1,161 warm | 1,303 |
| 8 | What do I need on the final for a B | bar, course open | model, 1; **wrong**: no code computes it, and the ask doesn't send the scores | 880 | 1,307 |
| 9 | Summarize the new announcement | bar, course open | code, 0; **not answered** ("Not in your materials.") | 0 | 1,299 |
| 10 | Open the TA's email about a regrade | command bar | model (routing), 1 | 1,635 one-shot / 1,936 warm | 1,302 |

Output tokens are estimates on both sides. Ours is the size of the scripted reply, whose shape is set by the pack's schema. The baseline's is a stated length per action.

Correctness is only partly measured. The code rows (1, 2, 6, 9) are checked end to end. On the model rows the fake CLI returns answers built to pass, so a "pass" there only means the code-side checks held: the right evidence was sent, quotes were verified, and IDs and dates were right. It is not an answer-quality comparison, and none is claimed.

## Usage mix

Uses per day, low / mid / high. None of these is a direct measurement:

- **One LMS-visit budget** covers actions 1, 2, 6 and 9, because all four were derived from the same Canvas page-view proxy. The budget is 1.5 / 3 / 6 visits a day, *inferred* from about 10–20 page views per student per week. It is split 1 : 1 : 3 : 0.3, following the supplied mix's own ratios, so the same visits aren't counted three times.
- **3 Explain:** 0 / 1 / 3, *inferred* from the Guelph survey's weekly AI-use rates.
- **4 Quiz:** 0 / 0.3 / 1, *inferred*. **5 Cards:** 0 / 0.5 / 2, *inferred* from Anki daily card counts.
- **7 Exam question:** 0.1 / 0.3 / 1, *inferred*.
- **8 Grade calculator** (0.02 / 0.1 / 0.3) and **10 Mail lookup** (0.1 / 0.3 / 1) are *assumed*. The mix supplied for this run was cut off at action 8.

## Fairness choices and why

- **Same call on both sides.** The live baseline runs with our runner's one-shot flags: our system prompt from a file (the instruction plus the sources), the question alone on stdin, tools off, no MCP, project and local settings only, and no saved session. It is spawned without a shell and always from the same folder, so the sources prefix can be cached. It is rejected if it takes more than one turn. Without this setup, the baseline would have been billed for Claude Code's own system prompt and the operator's settings.
- **Three baseline variants, all reported:**
  - whole context, no caching: an upper bound;
  - whole context with prompt caching, where every call in a day falls inside one cache window. That is favourable to the baseline, because the real window is 5 minutes;
  - retrieval with caching: a 4,000-token top-k budget once the corpus passes 50,000 tokens.

  At the synthetic corpus size, retrieval equals caching.
- **Saved generations on both sides.** A quiz or deck is generated once per topic studied, capped at 48 topics (4 courses × 12). It is regenerated once for every four topics after a content change. Reviewing a saved set is free on both sides.
- **No free repeats.** Each explain, exam, grade or mail use is priced at a first-run cost (identical-repeat rate 0). Our artifact cache only hits for a byte-identical question over identical passages.
- **Caching applied to ours too.** Claude Code caches automatically. The same rule prices our calls: under 1,024 tokens nothing is cached; otherwise the prompt is written at 1.25× and a shared prefix is read at 0.1×. This rule charges our generation calls more, not less.
- **Our warm pool is priced as it runs.** It is shown two ways: every ask in a fresh session (asks more than 10 minutes apart; the pool closes idle sessions), or a day's asks for one course in one session, which re-sends the growing history. The pool rotates at 40k tokens, which these bursts never reach.
- **Unanswered actions are never cheaper.** The headline leaves out actions 8 and 9 on both sides. The all-ten table keeps them and marks them unanswered.
- **The same tolerance on both sides.** The grade check accepts any percentage within ±1 point of 77.8% for both. The baseline's "what's due" check no longer fails an answer that mentions Homework 4's move, since both of its due dates fall outside the week.
- **Latency on like paths only.** We report only measured code-path times. A model row's fake-CLI time is a Node spawn, not inference, so it is left blank. A repeat's time is a cache hit, labelled as one.
- **The $ is API-equivalent usage.** NotebookLM and Claude Projects are free or subscription products, so the baseline's $ is what the same tokens would cost on the API, not what a student pays. Ours runs on the student's own AI plan or key.

## One-time costs

- **Ours, first sync:** 0 student model calls (*measured* from the code that runs).
  - The pipeline jobs (passages, links and facts, the course pass) are code.
  - Cards and mail gists are stubs that are never enqueued.
  - The concept map grows from the topic labels that generation already returns.
- **Jev on our gateway:** one assignment-kind judgment per assignment whose Canvas submission types don't settle its kind, once per title and text. That is 8 of 8 synthetic assignments, an upper bound, because they carry no submission types. These calls are paid by the service, not the student, and are not in the student totals.
- **Typical:** uploading sources is not billed to the student as model tokens (not measured).

## Limitations and what is not measured

- **Model latency, on both sides.** The live baseline has not been run, and our model paths use the fake CLI. The median per use is a measured code path only because more than half of our uses make no call.
- **Answer quality.** Our model rows are scripted. The baseline's correctness checks exist but have not run live.
- **Real token counts.** These are characters ÷ 4, with no tokenizer. The CLI may add overhead on both sides, which the live run would show.
- **Output lengths.** These are estimates on both sides.
- **The mix.** Actions 3–7 are inferred and actions 8 and 10 are assumed. The topic count, the regeneration rate and the 105 days are assumed.
- **Scale.** The 100k-token corpus is assumed. It also assumes our retrieved passages stay the same size as the corpus grows.
- **What the command bar actually does.** Action 2 answers only from the Today rail; the bar returns "Not in your materials." For action 7, the bar answers with no course open, but the phrasing that names the course ("… in cs 400 …") returns "Not in your materials." with no call. With no course open, action 8 returns "Sharing communications is disabled." and action 9 returns "Not in your materials." The bar's generation asks for the pack's default count (8 questions, 10 cards), not the number typed. The table's entry-point column shows where each measured row starts.

## Reproduce

```sh
pnpm semester                      # the harness and projection, headless, no network; writes evals/semester/out/
pnpm exec tsx --test tests/semester.test.ts
pnpm semester --live --only=1,3    # optional: the baseline through your own Claude Code, capped at $15
```
