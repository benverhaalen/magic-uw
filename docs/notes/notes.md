# Notes: the right method for each session, turned into retrieval practice

**Status: Proposal.** Notes are Word-first: each session gets a templated `.docx`, opened in Word and read back into the course notebook on save. The evidence table is at the end.

## The principle, from the evidence
The benefit comes from **active responding while taking notes** (blanks, cues, building a map or matrix) and **self-testing afterwards**, not from the page layout.

So every template does three things:
1. It leaves something for the student to *generate*.
2. It feeds self-questions into FSRS flashcards.
3. It prompts a review within 24–48 hours.

We don't force handwriting, and we don't hand out fully completed notes by default.

## Choosing a template per session (L0 code + L2 Jev, at compile time)
Inputs:
- the session type from Course Schedule: LEC / DIS / LAB / SEM
- the course's character: a Jev Choice on the skeleton, one of:
  - quantitative/proof
  - programming
  - conceptual/humanities
  - lab science
  - language
- today's content: slides posted? A comparison topic? A Noul: "does today compare ≥2 parallel concepts?"
- the student's settings (accessibility, preference)

| Session | Default template | Why (evidence) | What the student fills in |
|---|---|---|---|
| Lecture with slides posted | **Guided notes:** a skeleton built from today's slides, with key terms, steps and definitions left **blank** | guided notes d≈0.55 in college, larger in K-12; equal benefit for students with LD or ADHD | the blanks, plus "my example" and "question I have" lines |
| Lecture on a comparison ("sorting algorithms", "types of bonds") | **Matrix:** rows are the items, columns are the attributes, taken from the topics | Kiewra: matrix > outline for relationships and transfer | the cells |
| Math / proof / algorithms | **Worked-problem layout:** problem · approach · steps · *why each step* · check | worked examples + self-explanation (strong in the learning-science literature); the format itself is untested, so it's labelled | the why-lines (self-explanation) |
| Programming lecture | Guided notes + **code-annotation blocks** (snippet from the slides, "what does line N do?") | self-explanation; format untested | the annotations |
| Discussion / seminar | **Cornell:** notes · cue column · summary | the benefit is the cue and summary activity (modest evidence) | cues and the summary |
| Lab | **Lab notebook:** aim · procedure · observations · data table · result · error sources | conventional; no controlled evidence | all of it |
| Reading due before class | **Reading prep** (SQ3R-lite): questions first, then a paraphrased summary. Labelled "promising, weakly tested" | reading-strategy meta: small effects on standardized tests | questions + summary |
| End of each week or unit | **Build a concept map** in the app (React Flow). We supply the week's concept nodes; the **student draws the links** | *constructing* g≈0.72 vs studying g≈0.43 | the edges and labels |

**Building the skeleton** (for guided notes):
1. An LLM (L3) turns today's slides into an outline.
2. Jev picks which terms become blanks: a Choice over the candidates, ranked by importance and by how often they appear in assessments.
3. Code writes the `.docx` (header: course, date, time, room, topic, slide links, due soon).

**Cost:** about one small LLM call per lecture, created 7 days ahead.

## After class: making notes into study (the strongest part of the evidence)
1. **Within 24 hours, a "Review & quiz yourself" prompt** (King 1992: self-questioning beats summarizing at 1 week).
   1. The student writes 3–5 questions from their notes into the cue section.
   2. **Only after they try** does the app suggest more, generated from their notes plus the slides and gated by Jev.
2. **Every filled blank becomes a cloze card, and every question a Q/A card.** Both go into the course's FSRS deck, scheduled toward the next assessment that covers the topic.
3. **A review nudge after 24–48 hours.** The remaining handwriting-vs-laptop evidence is about *review*, so review is the feature.
4. **Paraphrase check:** if a note is mostly copied slide text, the app offers "put this in your own words" (generative > verbatim). It never rewrites the note for the student.

## Accessibility (active support, not passive support)
- Guided notes with blanks are the default for everyone. They help students with and without disabilities about equally.
- For ADHD / LD, an optional **strategy-prompt mode** (CUES+-style cues: "Cluster · Use cues · Enumerate · Summarize") instead of full completed notes. Passive supports can reduce active processing.
- **"Full notes"** is available on request, with a nudge to fill in cues. It isn't the default.
- Photos of handwritten notes are welcome: imported and OCR'd into the same pipeline.

## Integrity and honesty
- Skeletons come only from instructor materials. The student's notes are theirs, and the app never writes them.
- Every template carries its evidence label in the settings ("strong", "promising", "untested format").
- **Never claim** handwriting beats typing, drawing doubles memory, or SQ3R and Cornell are proven.

## Evidence: note-taking methods
**Strength labels:** strong / moderate / contested / weak. Effect sizes are as reported by the sources. Numbers from secondary summaries are marked *(unverified)*.

| Method | Best evidence | Effect | Strength | When it fails | Fits |
|---|---|---|---|---|---|
| **Guided / skeletal notes** (blanks to fill in) | Konrad, Joseph & Eveleigh 2009, doi:10.1353/etc.0.0066; college meta ERIC EJ1016535 (12 studies, N=1,529); Larwin et al. K-12 meta (EJ1001064) | college d≈0.55 (18.5% of effects negative); K-12 d≈1.1–1.2; **equal for students with and without disabilities** | moderate–strong | no consistent edge over fully completed notes on some quizzes (Neef 2006) | lectures, especially intro courses |
| **Matrix / charting notes** | Kiewra et al. 1988 doi:10.1037/0022-0663.80.4.595; 1991 doi:10.1037/0022-0663.83.2.240 | matrix > outline > text for relationships and transfer | strong (≥6 studies) | outline can win for pure recall | comparing ≥2 parallel concepts |
| **Constructing concept maps** | Nesbit & Adesope 2006 (RER 76:413); Schroeder et al. 2018 doi:10.1007/s10648-017-9403-9 | constructing g≈0.72–0.82; studying a given map g≈0.40–0.43 | strong (2 meta-analyses) | high heterogeneity; mapping with a partner showed no edge (g=.19) | weekly or unit synthesis |
| **Self-questioning from notes** | King 1992 doi:10.3102/00028312029002303 | self-questioning > summarizing > note review at a 1-week delay | strong | — | after every session |
| **Generative (paraphrase) vs verbatim; reviewing notes** | Bretzing & Kulhavy 1979; review × method interaction in RCTs | paraphrase > verbatim; review > no review | strong | the sheer volume of verbatim notes still predicts scores | all |
| **Cornell** (cue column + summary) | small RCTs (Frontiers 2025, doi:10.3389/fpsyg.2025.1697151; IISTE Nigeria RCT) | small, inconsistent | moderate–weak | the win comes from the cue/summary *activity*, not the layout | reading, discussion |
| **Handwriting vs laptop** | Mueller & Oppenheimer 2014 (corrected 2018); Morehead et al. 2019; Urry et al. 2021 (direct replication); Lau 2022 meta | the main effect **fails replication** (d≈0.15, not significant); what's left is an interaction with review | contested | the gap disappears when notes are reviewed | don't force handwriting; prompt review |
| **Drawing effect** | Wammes, Meade & Fernandes 2016 doi:10.1080/17470218.2015.1094494 | drawn single words recalled more than twice as often as written ones | strong **for single words in the lab only** | not shown for complex lecture concepts | definitions, vocabulary |
| **Annotating provided slides** | Coria & Higham (conference, secondary summary *(unverified)*); PMC1389604 | annotation ≈ passive viewing; guided notes gave fewer analysis errors | weak–moderate | removes the generative effort | prefer blanks over annotation |
| **SQ3R / reading strategies** | Okkinga et al. 2018 reading-strategy meta | d≈0.43–0.95 on researcher-made tests, **d≈0.17–0.19 on standardized tests** | contested / weak | effects shrink on standardized tests | reading prep; label it "promising" |
| **Accessibility** (ADHD, LD) | Larwin meta (no moderator effect of disability); Boyle & Weishaar 2001 doi:10.1111/0938-8982.00014 (CUES+ strategy); Gleason 2012 | guided notes help equally; **strategy prompts beat a bare outline**; passive supports (scribes, full handouts) can reduce active processing | moderate | full completed handouts, scribes | active supports by default |

**Not found:** a controlled test of worked-example or code-annotation notes as a note *format* (only the general worked-example literature, which is in the broader learning-science literature (retrieval, spacing, worked examples)); a dedicated SQ3R meta-analysis; a peer-reviewed version of Coria & Higham.

**Claims to keep out of the product and the video:**
- "Handwriting beats typing."
- "Drawing doubles memory" (for lecture concepts).
- "SQ3R is proven."
- "Cornell is the best method."
