# Evidence behind the practice engine

Checked 2026-09-26. Labels: **sourced** (paper or page read) · **inferred** · **not-found**.

## 1. What existing study products do
| Product | Where items come from | How it adapts | Uses real exams? |
|---|---|---|---|
| Quizlet Learn | the user's set; "trickier" distractors drawn from ~400M community answers | moves each term from multiple choice to typed recall | no |
| Quizlet Test | a random mix of formats | none | no |
| Quizlet Q-Chat | — | **retired 2025-06-30** | — |
| Anki (FSRS) | cards the user writes | FSRS per card; FSRS-6 in Anki 25.09 | no |
| Knowt | AI from uploads; Quizlet import | "adaptive rounds weighted toward what you miss" | no (format only) |
| StudyFetch | uploads | confidence tracking; misses recur | **format only** (USMLE/AP style), not real past papers |
| Gizmo | uploads, Anki/Quizlet import | spaced repetition; slow to resurface mastered cards (third-party test) | no |
| NotebookLM | uploads | none within a session; "practice only the cards you missed" | no |

Sources (all sourced): quizlet.com/features/learn; medium.com/tech-quizlet (2017-12-20, 2022-05-26); help.quizlet.com (Q-Chat); github.com/ankitects/anki #3616; studyfetch.com/features/exam-specific; support.google.com/notebooklm/answer/16958963; tieup.io (2026-06-11).

**No product uses the instructor's real practice exams or past exams from the course** (not-found across 8 tools). **None publishes latency figures.**

**Recurring complaints** (counts are independent sources):
| Complaint | Sources |
|---|---|
| Paywalls and ads on free tiers | 4 |
| Billing and refund problems | 3+ |
| "Lives" lockouts in the middle of hard drilling (Gizmo) | 2 |
| AI items needing fixes: ~10–15% of cards (Gizmo test); "the correct answer is the longest one" (Quizgecko) | 3 |
| **Written answers graded on exact wording** (Knowt, Quizgecko) | 2 |
| Bugs and lost sets | 3+ |

## 2. Generating items
| Finding | Source | Strength |
|---|---|---|
| **LLM items match human ones on difficulty and discrimination:** GPT-4o vs human MCQs, difficulty 0.67 vs 0.65, discrimination 0.29 vs 0.27; students couldn't tell them apart; **experts barely agree on "quality"** (ICC 0.07–0.18) | npj Digital Medicine 2025, nature.com/articles/s41746-025-02313-7 (preregistered, blinded) | sourced, strong |
| The same holds in a CS (operating systems) course | Frontiers in Education 2026, doi:10.3389/feduc.2026.1837523 (n=42) | sourced, small |
| **Reused items inflate scores through memorization:** 48% of students used publisher test banks, for about a 30-point advantage | Simkin et al., J. Accounting Education (ScienceDirect S0748575116300434) | sourced |
| **Distractors matter:** less diverse distractors cut a reader model's accuracy by >20%; "more plausible" ones by up to 10% | arXiv 2311.04554 | sourced (reading comprehension domain) |
| Variant generation: pick from a pool vs parameter-varying templates | doi:10.1186/s41239-021-00257-y | sourced (pre-LLM) |
| Difficulty can be estimated from item text before anyone answers (R2DE) | arXiv 2001.07569 | sourced (not tested on LLM items) |
| Error rate of LLM-generated **answer keys** for math/CS | — | **not-found**, an open risk |

**Reusable, MIT-licensed:**
- `lfnovo/quiz-me`: generation with a second-model review and retry.
- `shahkhalid/mcqsagent`: generate → verify → distractors → review.
- `gkuling/QuizGen-RAG`: Bloom's-leveled items tied to the course schedule.

## 3. Estimating preparedness from one student's data
| Finding | Source | Strength |
|---|---|---|
| **BKT needs cohort data:** parameters settle at about 50–100 students; mastery estimates at ≥15 responses per skill; ~4× more parameter error at n=25 than at n=500 | Badrinath, Wang & Pardos, EDM 2021 (arXiv 2105.00385); Slater & Baker (Behaviormetrika) | sourced, strong |
| **Elo-style ratings:** accuracy close to IRT at much lower cost; **~10 answers give a reasonable skill estimate** (r≈0.8 in simulation); an extended Elo beat BKT and PFA on real data; item difficulties need about 100 students | Pelánek, Computers & Education 2016; Papoušek et al., UMUAI 2016, doi:10.1007/s11257-016-9185-7 | sourced, strong |
| More complex prior models add little over basic Elo | Nižnan, Papoušek & Pelánek, EDM 2015 | sourced |
| **FSRS gives a live recall probability** per card: `get_retrievability` / `forgetting_curve` in ts-fsrs; R = (1 + factor·t/S)^decay, with decay = −w[20] and factor = 0.9^(1/decay) − 1 (`computeDecayFactor` and `forgetting_curve` in `packages/fsrs/src/algorithm.ts`, read 2026-09-26; FSRS-6 default decay 0.1542) | github.com/open-spaced-repetition/ts-fsrs | sourced; **not validated as a mastery measure** |

## 4. Confidence, calibration and format
| Finding | Source | Strength |
|---|---|---|
| **Hypercorrection:** confident errors are corrected best when feedback follows | Butterfield & Metcalfe 2001/2006 (PubMed 11713883) | sourced, strong |
| Asking for confidence doesn't improve learning by itself: g=0.054, not significant; positive only for some materials | Double, Birney & Walker 2018 (Memory) | sourced |
| **Delayed judgments of learning are far more accurate than immediate ones:** g=0.93 | Rhodes & Tauber 2011 meta-analysis | sourced, strong |
| **Testing transfers:** d=0.40 overall; the most transfer is across formats and to application questions | Pan & Rickard 2018, doi:10.1037/bul0000151 | sourced, strong (reduced after publication-bias correction) |
| Matching the practice-test format to the final exam's increases the benefit | Adesope et al. 2021, doi:10.1002/acp.3796; Exp. Psychology doi:10.1027/1618-3169/a000664 | sourced, moderate |
| …but tests that require transfer can give equal or larger benefits | Rohrer et al. 2010 (JEP:LMC) | sourced, moderate |
| Interleaving, g=0.42 | Brunmair & Richter 2019, doi:10.1037/bul0000209 | sourced |
| Successive relearning, spacing timed to the exam | Rawson & Dunlosky 2011, doi:10.1037/a0023956; Cepeda 2006/2008 | sourced, strong |

## 5. Study-session timing
| Finding | Source | Strength |
|---|---|---|
| Fixed Pomodoro breaks: **no difference in effort or task completion**; higher concentration (d≈1.02) and lower perceived difficulty (d≈−0.89) than self-regulated breaks; learning not measured | Ayres et al. 2023, BJEP, doi:10.1111/bjep.12593 (n=87) | sourced, moderate |
| Self-directed breaks scored higher than Pomodoro on an immediate test (d=0.74) | Mabalda et al. 2026 (n=30) | weak |
| Pomodoro vs Flowtime vs self-regulated: no difference in productivity; Pomodoro showed steeper fatigue within a session | doi:10.3390/bs15070861 (n=94) | sourced, moderate |
| **No controlled study ties Pomodoro to better exam scores** | BMC Med Educ scoping review, doi:10.1186/s12909-025-08001-0 | not-found (causal claim) |

## Claims to avoid
- "Pomodoro improves learning."
- "Rating confidence makes you learn more." Its value is calibration and targeting feedback.
- "Our preparedness score is your probability of passing." Show evidence-backed bands instead.
- "Predicts your exam."
- "Verified answer keys" for math or code without execution-based checking.
