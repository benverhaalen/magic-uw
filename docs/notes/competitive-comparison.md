# Magic Canvas vs Gemini Notebook (NotebookLM), Quizlet and Duolingo

**Status:** researched facts about the competitors (sources below, checked 2026-09-26). Our side is **decided design, not yet measured.** Every speed or cost claim about Magic Canvas is a *target* until the [measurement plan](../plans/2026-09-26-measurement/plan.md) produces a number.

## Cost to the student
| Product | What the student pays | Limits that bite during study |
|---|---|---|
| **Gemini Notebook** (NotebookLM was renamed; its Help Center is now "Gemini Notebook Help") | Free; Google AI Plus $4.99/mo; AI Pro $19.99/mo; AI Ultra $100 or $200/mo | Free: 50 sources/notebook, 50 chats/day, 10 quizzes/day, 10 flashcard sets/day, 3 audio overviews/day. Pro: 300 sources, 500 chats/day, 100 quizzes/day. **Consumer tiers moved to compute-based usage limits (quota refreshes every 5 hours) from 2026-09-02, so these fixed daily counts may be outdated (corrected 2026-09-26; support.google.com/gemininotebook/answer/17670842)** |
| **Quizlet** | Plus $35.99/yr; Plus Unlimited $44.99/yr (annual billing shown) | Plus: 3 practice tests, 20 Learn rounds, 3 textbook solutions **per month**. Unlimited removes those caps and adds study paths, progress and smart grading |
| **Duolingo** | not a course-material tool; used here for engagement mechanics only | — |
| **Magic Canvas** | **$5 a month** (covers Jev and the service; September 27 decision), plus **the student's own paid AI**: Claude Pro or higher, a paid ChatGPT plan, a paid Gemini API key, or an OpenRouter key | No app-side daily quotas. The student's provider limits apply. The app caches and precomputes, so repeated views don't spend the student's quota again |

**Honest reading:**
- **Gemini Notebook's free tier costs less than Magic Canvas** for a student with no paid AI plan. Magic Canvas requires one.
- **For a student who already pays for Claude, ChatGPT or Gemini,** the marginal cost is $5 a month, against Quizlet's annual fee or Gemini Notebook's quotas.

**Our side of the cost** (targets, measured by the ledger in the [backend plan](../plans/2026-09-26-backend-optimization/plan.md)):
- Jev calls per course sync and per 100 items checked. Internal figures only; see [Jev insights](jev-insights.md).
- No hosted model spend, because the student's own plan or key pays.

## Efficiency: what the student spends in time and effort
| Measure | Gemini Notebook | Quizlet | Magic Canvas (target, to measure) |
|---|---|---|---|
| **Getting course material in** | manual: upload or link each source (PDF, Docs, Slides, web, YouTube, audio; up to 500k words or 200 MB per source); Drive files re-sync | manual: make sets, import, or AI-generate from notes and slides | **automatic after one UW sign-in:** Canvas syllabus and assignments today; modules, files and pages next |
| **Knows dates, assessments and course policy** | no in practice for a student: Google's Gemini LTI imports Canvas files as notebook sources, but only after an institution's Workspace for Education admin sets it up; an individual student can't connect it (corrected 2026-09-26; support.google.com/edu/assignments/answer/15672329) | no | yes: deadlines with evidence; course AI policy from the syllabus |
| **Time to first useful answer** | not published (no independent latency benchmark found) | n/a | target: first grounded answer within the first session after sync; measured cold and warm |
| **Repeated artifacts** (guide, quiz, flashcards) | regenerated on request, within the daily quotas | Learn and Test rounds capped on Plus | precomputed when idle and cached by content hash; a revisit costs nothing |

## Capabilities
| Capability | Gemini Notebook | Quizlet | Duolingo | Magic Canvas |
|---|---|---|---|---|
| Grounded chat with citations | ✅ inline citations to sources | — | — | ✅ quotes **checked by code** against the exact source version; "couldn't find support" when unsupported |
| Study artifacts | ✅ reports, mind maps, infographics, slide decks, audio and video overviews (incl. "cinematic"), Deep Research | AI study guides, summaries | — | study guide, briefing, FAQ, glossary, timeline, mind map, **exam coverage map**. Audio overview later |
| Flashcards and quizzes | ✅ within the daily quotas | ✅ Flashcards, Learn (adaptive), Test | — | ✅ FSRS flashcards, Learn (MC → typed), practice exams from real course exams (fidelity tiers), checked-item labels |
| Spaced repetition | not documented | "smart grading" and study paths on Unlimited | ✅ half-life regression (published) | ✅ FSRS (ts-fsrs), scheduled toward the exam date |
| Knowledge model / "what's still iffy" | — | progress tracking (Unlimited) | skill strength | ✅ per-concept states with explainable reasons and evidence counts, mapped to specific lectures and pages. No pass probabilities |
| Habit mechanics | — | — | ✅ streaks, freezes, XP, leagues, hearts | streaks and freezes, daily goal, XP. **No lockouts,** and no leagues by default |
| Course policy and integrity | — | — | — | ✅ course AI policy first; coaching when policy is vague; no open graded work used as practice |
| Notes | — | — | — | ✅ a templated .docx folder tree per course (local first; Drive/OneDrive only if present) |
| Privacy | personal accounts: "not used to train… unless you provide feedback" | — | — | local storage; the student's own provider receives the context; consent per provider; receipts |

**Where competitors are ahead,** stated plainly:
- **Gemini Notebook:** audio and video overviews, infographics and slide decks, Deep Research, a free tier, web and mobile availability, and a strong grounding record in controlled studies (86% vs 39% on lung-cancer staging; PMID 39585559).
- **Quizlet:** a huge community set library and textbook solutions.
- **Duolingo:** years of tuned habit mechanics; learners with a 7-day streak are "3.6 times more likely to complete their course" (Duolingo blog, 2022; correlational).

## How we'll prove the rows we claim
[Benchmarking](benchmarking.md) and the [measurement plan](../plans/2026-09-26-measurement/plan.md) define the rules:
- the same material goes to each system
- the gold is frozen and written independently
- rating is blind
- quote validity and claim support are reported separately
- latency and cost are measured on our own hardware
- rows we lose are reported

## Sources (fetched 2026-09-26)
- **Gemini Notebook:** support.google.com/gemininotebook answers 16213268 (tiers, limits, data use), 16215270 (source types, research), 16269187 (FAQ). Pricing from blog.google (Google AI subscriptions).
- **Quizlet:** quizlet.com/upgrade, /features/flashcards, /features/learn, /features/test, /features/ai-study-tools, and help article 360041181691.
- **Duolingo:** blog.duolingo.com "how-duolingo-streak-builds-habit" (2022-01-31); Settles & Meeder 2016, research.duolingo.com/papers/settles.acl16.pdf.

## Update, 2026-09-26 late: Gemini Notebook and Open Notebook facts
**Gemini Notebook** (support.google.com/gemininotebook):
- **Usage limits:** "Starting on September 2, 2026, Gemini Notebook will have compute-based usage limits… the quota refreshes every 5 hours until you reach your weekly limit."
- **Sources:** up to 50 per notebook on Free, 300 on Pro; "up to 500,000 words or up to 200MB" each.
- **Studio outputs:**
  - Audio Overview (Deep Dive, Brief, Critique, Debate)
  - Video Overview (Cinematic, Explainer, Short)
  - Mind Maps
  - Reports (interactive or document)
  - Flashcards and Quizzes with progress tracking
  - Infographics, Slide Decks
  - a "Learning Guide" chat style
- **Citations:** chat "uses direct quotes… from your sources as citations". They aren't independently checked.
- **No Canvas or other LMS integration for an individual student:** Google's Gemini LTI imports Canvas files as notebook sources, but only after an institution's Workspace for Education admin sets it up; an individual student can't connect it (corrected 2026-09-26; support.google.com/edu/assignments/answer/15672329). Public sharing is "disabled for Workspace Enterprise or Education accounts".

**Open Notebook** (lfnovo/open-notebook v1.14.0, MIT, 2026-07-21):
- **Stack:** Next.js + FastAPI + SurrealDB; 17–21 providers through Esperanto; 400-token chunks.
- **"Transformations"** are saved prompt templates run per source.
- **Per-source context levels:** "FULL CONTENT / SUMMARY ONLY / NOT IN CONTEXT".
- **Podcasts:** 1–4 speakers.
- **Its own README lists citations as "Basic references (will improve)".**
- Manual sources, and no deadlines, grades or course policy.
- The team's artifact inventory is `docs/notes/open-notebook-artifacts.md` (on the `northcutt-frontend` branch).

**Where we position** (spec Part D):
- The notebook builds itself from Canvas and stays current.
- Assessments come with their materials in capped tiers.
- Citations are checked by code, with page, slide or recording time.
- Studio artifacts are versioned prompt packs scoped to what's on the exam.
- The student's own AI does the writing, with no source caps.
