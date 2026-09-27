# Integrity roles: how an academic tool helps without doing the graded work

Checked 2026-09-26. Labels: **sourced** · **inferred** · **not-found**.

## The principle
**The tool helps with everything around the graded work, never the graded work itself.** The student sends every message and makes every submission.

**Evidence that guardrails decide whether AI helps or harms** (Bastani et al., PNAS 2025, doi:10.1073/pnas.2422633122, ~1,000 high-school math students, RCT; sourced):
- **Unrestricted GPT:** practice +48%, then **−17% on the unassisted exam**. Students used it as a crutch, copied answers and didn't notice the harm.
- **Hint-only GPT Tutor:** practice +127%, and the exam result was indistinguishable from control.

**A well-designed AI tutor beat in-class active learning:** 0.63 SD, with learning gains more than doubled (Kestin et al., *Scientific Reports* 2025, doi:10.1038/s41598-025-97652-6, Harvard physics, N=194; sourced).

## Policy levels the tool must respect
| Source | Levels |
|---|---|
| **UW–Madison** (ctlm.wisc.edu, AI statements for syllabi) | three instructor templates: **"Allow AI with documentation and citation"** · **"Allow AI in certain circumstances"** · **"Prohibit AI unless otherwise specified."** No campus-wide rule; "students are responsible for knowing their instructor's expectations"; violations fall under UWS 14.03 |
| **AI Assessment Scale** (Perkins et al. 2024; revised arXiv 2412.09029) | 1 No AI · 2 AI-assisted planning · 3 AI-assisted task completion · 4 Full AI · 5 AI exploration |
| **Stanford** (pace.stanford.edu) | sample syllabus **allows:** tutor yourself, quiz yourself, brainstorm, outline, get feedback, **draft group-project timelines, locate and summarize sources, copy-edit**. **Forbids:** complete problem sets, draft a full essay |
| **Michigan** (genai.umich.edu) | forbids doing a teammate's assigned group work "unless mutually agreed" and impersonating a student in discussion posts |

**The app reads each course's level from its syllabus** (quoting the sentence) **and lets each assignment override it:**
- **When the policy is vague or silent, it coaches:** tutor mode, with hints and explanations, and it never produces graded work. This is the team's established direction.
- **Loosening needs the student to confirm the quoted sentence.**
- "My professor said it's fine" never loosens anything.

These rules come from `jev-usage.md`.

## The roles
| Role | What it does | Where it's allowed | Guardrails | Evidence |
|---|---|---|---|---|
| **Logistics** | deadlines, rooms, what changed, where to submit | always | read-only | — |
| **Practice generator** | quizzes, practice exams, flashcards from course materials | self-study is allowed at every level; if a course bans AI, the app shows the rule and asks | items cite their sources; never uses graded-assignment questions as practice while they're open | retrieval practice (strong); see `practice-evidence.md` |
| **Tutor / coach** | hints, Socratic questions, concept explanations, pointers to materials | levels 2+; blocked on graded items under "Prohibit" | **never the answer or the code**; attempt before hint; staged hints; grounded in course material; marks general knowledge as such; offers to escalate to the TA (draft) | Bastani 2025; Kestin 2025; guardrailed CS1 tutor RCT (aimspress steme-06-05-037); SocraticAI (arXiv 2512.03501) |
| **Project coordinator** | groups a project's spec, rubric, materials, notes, milestones, team and messages; plans milestones | levels 2+ (Stanford: "draft group-project timelines") | never produces deliverable content; respects each assignment's collaboration rule | milestones cut late submissions from 41% to 12% (SIGCSE 2021); see `project-coordinator.md` |
| **External researcher** | finds outside sources (papers, docs, textbooks, videos) for course topics; summarizes them *for relevance only* | level 2 (Stanford: "locate sources…", "summarize sources to decide relevance") | **never shows an unverified citation** (below); the student reads the source; no drafted prose | fabrication rates below |
| **Proofreader** | flags spelling, grammar, clarity and structure issues in the student's own draft, and **explains why** | level 3 in AIAS terms; "editing/refining your own work" is a citable use at UW; blocked under "Prohibit" | **highlights and explains; the student makes every change.** Never rewrites sentences or paragraphs, adds content, or corrects facts or references | automated writing-feedback metas: g≈0.43–0.86 |
| **Communicator** | drafts messages to TA, instructor or team, with context | always, as the student's own message | **the student sends.** Never posts in graded discussions for the student | only 28% of college students seek help vs 41% who intend to (PMC12447698); about two-thirds never use office hours |
| **Metacognitive coach** | reflection prompts, calibration, "what's still unclear?" | always | — | built into tutor designs (SocraticAI; CS1 RCT) |
| **Accessibility support** | simplified summaries, read-aloud, note scaffolds | always (equity rationale, MLA–CCCC 2024) | active support over passive (see `notes.md`) | — |

## External researcher: citations must be verified
**Raw LLM citations are often fabricated** (all sourced):
| Study | Fabricated |
|---|---|
| Walters & Wilder, *Scientific Reports* 2023 (636 citations) | 55% (GPT-3.5), 18% (GPT-4); 24–43% of the real ones had errors |
| Chelli et al., JMIR 2024 | 39.6% (GPT-3.5), 28.6% (GPT-4), 91.4% (Bard) |
| PMC12658395, 2025 | 19.9% (GPT-4o); **64% of the DOIs on fabricated citations were real DOIs pointing at unrelated papers** |

**The pipeline:**
1. Find candidates through search tools, not the model's memory.
2. **Resolve every identifier** (Crossref/DOI, OpenAlex, PubMed, arXiv, OpenLibrary). Code compares title, authors and year field by field. A real DOI with a different title is the "chimera" pattern, and the citation is rejected.
3. Fetch the source, and have Jev check that the quoted passage supports the stated relevance (supports / contradicts / doesn't address).
4. Show only sources that pass, each with its link and the passage.

There's no RCT on how much verification reduces student errors (not-found). The pipeline design is inferred from five independent checker tools.

## Proofreader: where feedback turns into authoring
**Policies that draw the line** (all sourced):
| Institution | Allowed | Not allowed |
|---|---|---|
| **UCL** (Academic Manual 9.2(6a)) | checking "structure, fluency, presentation, grammar, spelling, punctuation" | "substantive changes to content" |
| **Manchester** | "correct grammar or spelling" | substantive changes to "content or meaning" |
| **King's College London** | may highlight errors | may not "assist with substantive content creation or structuring… correct information or references, or involve any tutoring" |
| **Waikato** | proofreading of spelling, punctuation and grammar; clarity edits | "adding new material, rewriting paragraphs… changing the emphasis or argument" |
| **Glasgow** | — | prohibits the tool rewriting or redrafting, "though you could ask for feedback and then implement changes based on that feedback" |

**This is exactly our design: feedback in, the student's own edits out.**

**Evidence on automated writing feedback:**
- g=0.55 (Frontiers in AI 2023, 20 studies). **Transfer effects were large; same-task revision effects were small.**
- g=0.86 (Zhai & Ma 2022, 26 studies).
- g=0.59 (EFL, Ngo et al. 2022).
- g=0.43 (Li 2022).
- No RCT yet on GPT-4-class proofreading (not-found).

## Disclosure: an AI-use log the student owns
- **Some UW courses require an "AI Usage Statement":** tool and version, a description of the use, and the prompt (ctlm.wisc.edu).
- The app keeps a **per-assignment AI-use log** from its own audit trail: role used, when, the prompts, and what the student did next. **It drafts the statement; the student edits and attaches it.**
- **The log stays local and under the student's control.** This is a process-transparency approach like Grammarly Authorship, not detection. Stanford calls AI detectors "unreliable" and says they "flag English-language learners incorrectly".

## Role permissions by course policy (a starting matrix; the course's own wording overrides it)
| Role | Prohibit (unless specified) | Allow in certain circumstances | Allow with documentation |
|---|---|---|---|
| Logistics, communicator, metacognitive, accessibility | ✓ | ✓ | ✓ |
| Practice generator (self-study) | shows the rule, asks | ✓ | ✓ |
| Project coordinator (planning only) | shows the rule, asks | ✓ | ✓ + log |
| External researcher | ✗ on graded work | as stated | ✓ + log |
| Tutor on a graded item | ✗ | as stated | ✓ hints only + log |
| Proofreader on a graded draft | ✗ | as stated | ✓ + log |
