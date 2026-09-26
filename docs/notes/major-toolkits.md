# Major toolkits: the same workspace, specialized per degree

Checked 2026-09-26. **Status: ideation grounded in sourced UW access facts.** The tools and access routes are sourced; the features are proposals.

## How a toolkit turns on
- **Detection:** the subject codes of the student's enrolled courses (COMP SCI, ECE, MATH, CHEM, NURSING, ENGL…), plus their declared major where available. The student can confirm or change it.
- **What a toolkit adds:**
  - launchers
  - note templates suited to the subject (see `notes.md`)
  - tutor behaviour matched to the discipline (e.g. hints on code, never code for graded work)
  - resource links
- **Integrity:** every toolkit follows `integrity-roles.md`. Tools help the student do the work; they never do graded work.

## Computer science
| Tool | UW access (sourced) | In the workspace |
|---|---|---|
| **CS instructional Linux machines** | `ssh netid@best-linux.cs.wisc.edu`, plus the instructional lab hosts (csl.cs.wisc.edu remote-access docs) | **An integrated terminal** (xterm.js + node-pty) with ready SSH profiles and a key-setup helper |
| DoIT GitLab | `git.doit.wisc.edu`, free for students (kb.wisc.edu/132910) | **Repos linked to assignments** (the URL in the spec, or GitHub Classroom); status and last commit on the project space |
| GitHub Student Developer Pack | education.github.com/pack | onboarding checklist |
| Gradescope autograder | used across CS courses (kb.wisc.edu/153876) | tab; the autograder result links to the assignment; nothing scraped (its terms forbid it) |
| Office-hour queues | per course (e.g. cs320 help page) | the queue link on the course space; "join queue" opens it |
| Jupyter | a UW-Madison JupyterHub page wasn't found (not-found) | a local Jupyter launcher for course notebooks |

**Ideas:**
- **"Run the tests":** a button in a project space that runs the course's public test script in the terminal.
- **Error explainer:** paste a compiler error to get a *hint* and the relevant lecture slide, not a fix, when graded.
- **Big-O and concept cards** made from lecture code.

## Engineering
| Tool | UW access (sourced) | In the workspace |
|---|---|---|
| MATLAB / Simulink | campus-wide licence, including **MATLAB Online** (kb.wisc.edu/82710, 157627) | a MATLAB Online launcher; .m files in the assignment's folder |
| SolidWorks, LabVIEW, Maple… | CAE labs and **Citrix remote** at `remote.engr.wisc.edu` (kb.wisc.edu/cae/110906) | a remote-desktop launcher from the course space |

**Ideas:** a unit-consistency checker (the answer comes from code, not an LLM); lab-report templates; design-review checklists taken from rubrics.

## Math, statistics, physics
| Tool | UW access (sourced) | In the workspace |
|---|---|---|
| Mathematica / Wolfram\|Alpha Pro | free to enrolled students (kb.wisc.edu/helpdesk/157626) | launcher; worked-problem notes |
| Overleaf | institution sign-in (overleaf.com/edu/wisc); premium through some departments | "Open in Overleaf" from a note; LaTeX note templates |
| R / RStudio, Python | open source | local launchers; stats templates |
| Campus Software Library | `software.wisc.edu` (kb.wisc.edu/65064) | one "get your course software" list per course |

**Ideas:** worked-problem notes with "why this step" lines; a **symbolic check of practice answers by code** (a solver, or running code), never by Jev.

## Life, chemistry and health sciences
| Tool | UW access (sourced) | In the workspace |
|---|---|---|
| **LabArchives** (campus notebook) | free site licence for researchers (eln.wisc.edu) | a link per lab course; lab-notebook note template |
| Benchling | lab by lab (benchling.com/uw-madison) | link |
| Exxat (nursing clinicals) | used by the School of Nursing (students.nursing.wisc.edu) | a clinical-hours reminder on the calendar; link |

**Ideas:** a pre-lab checklist from the lab manual (cited); a protocol step-through view; flashcards for reagents and safety.

## Humanities and social sciences
| Tool | UW access (sourced) | In the workspace |
|---|---|---|
| **UW Libraries search** | search.library.wisc.edu; a list of licensed databases with APIs (library.wisc.edu data services) | **external researcher** (`integrity-roles.md`), library-first, every citation verified |
| **Zotero** | library-supported; UW full-text link resolver `https://resolver.library.wisconsin.edu/uwmad?` | "save to Zotero" (Zotero's local connector or web API; inferred); full-text links through the resolver |
| Writing Center | appointments (ctrw.wisc.edu) | "book a Writing Center visit" on essay projects |
| Perusall / Hypothesis | per course | tab; annotations stay in the tool |

**Ideas:** reading-prep notes (questions first); an argument map (claim → evidence) as a *student-built* concept map; proofreader feedback only (`integrity-roles.md`).

## Business
| Tool | UW access | In the workspace |
|---|---|---|
| Microsoft 365 (Excel etc.) | free to students (kb.wisc.edu/73430; sourced) | "open in Excel" templates |
| Bloomberg Terminal | at the Wisconsin School of Business (testimonials only; official page not-found) | lab info link |
| Harvard Business Publishing cases | per course | case-prep template: facts · decision · options · recommendation |

## Arts, design, music
- **Adobe Creative Cloud** comes only through qualifying courses or jobs; otherwise students get Adobe Express (kb.wisc.edu/instructional-resources/105550; sourced).
- **Ideas:** a portfolio tracker per course, a practice log for music (study-clock sessions), critique-note templates.

## Every major
| Resource | UW (sourced) | In the workspace |
|---|---|---|
| GUTS tutoring | guts.wisc.edu | "get a tutor" on a course when preparedness is shaky |
| Learning Support directory | learningsupport.wisc.edu | the course's help resources on one card |
| McBurney Connect (accommodations) | mcburney.wisc.edu/mcburneyconnect | accommodation reminders on exam dossiers (e.g. "book extended-time exam by…"), with the student's consent |
| Campus Software Library | software.wisc.edu | course software checklist |
| Microsoft 365 | free | Word-first notes (see `notes.md`) |
