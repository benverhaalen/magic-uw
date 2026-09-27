# Jev usage: design rules for each typed judgment

**Status: Proposal.** These are design rules, not measured results. **Don't publish Jev performance numbers** (latency, cost or accuracy) in this repository, the video or the written responses until TypeSafe's customer agreement has been checked. A third-party README reports that the agreement restricts publishing them.

## Rules for every use
1. **Code first.** If a regex, a Canvas field or a string match answers it, no Jev call.
2. **One request per state.** Every question that reads the same state goes in a single request.
3. **Thresholds per question,** on the top probability and its lead over the runner-up, fitted on labelled examples. **Never use the `confidence` field.** Collect labelled examples for each question before enforcing any gate.
4. **An abstain band with a defined fallback** for every decision. An error or timeout takes the fallback, which is the strict branch on safety-like paths.
5. **Rotate the option order** by the state hash, and log the order that was shown. Include an explicit `none` / `other` option, and never pin it first or last.
6. **Small, named state.** Only the fields the question needs, named and referred to by path. Design to the documented limits (64k per request; 32k for the state plus the longest question). Refuse an oversized state rather than truncating it.
7. **Never a security boundary.** On a safety-like path, Jev may only make the outcome *stricter*. Retrieved text (email, posts, pages) is untrusted.
8. **A model's answer never overwrites a measured fact:** a Canvas `due_at`, a roster, an explicit field.
9. **Journal every answer:** state hash, question hash, raw probabilities, model ID, latency, the option order shown. Hashes only, never content. This lets a threshold change be replayed without new calls.
10. **Routes:** TypeSafe direct, an OpenRouter decisions route, or the AI SDK's evaluation interface. **A fallback path is required;** a provider error must degrade to code or an LLM, never block the UI.

## Each planned use
| Use | Design |
|---|---|
| **Document role** | Code decides first (Canvas item type, file-name patterns). Then **one request** asks a Choice over about 7 role *families* and a Choice for the role *within* each family. Keep the question only if it beats code and a small LLM on our own labels. |
| **Dates in documents** | "States a deadline?" (yes/no) only triggers a follow-up. The date is read as **month, day and year Choices** with `not_stated`; code builds and compares the date. It never overwrites Canvas `due_at`. |
| **Supersedes** | One yes/no per document pair that code has built (same title or family), not a field on every document. |
| **Assessment → materials** | Code builds at most 30 candidates. One yes/no per candidate ("needed for Midterm 2?"). "None" is computed in code (every candidate below its bar). **The Jev answer is combined with the embedding ranking, not substituted for it.** |
| **Message triage** (email, announcements) | The course comes from the roster or subject patterns first. One yes/no per possibly affected assessment, since a message can affect several. **Jev can only raise a message's visibility,** never hide it. |
| **⌘K / command routing** | Code shortlists ≤10 commands; one Choice plus `none`, with the slots in the same request. Auto-run only above a fitted bar with a clear lead. **Destructive or outward actions never auto-run.** |
| **Quality gates on generated items** | First, a **code check that the cited quote exists** in the source. Then a Choice: supports / contradicts / doesn't address. "One correct answer" = **one yes/no per option**, and code checks that exactly one passes. Math and code answers are checked by execution, not Jev. |
| **Grading typed answers** | One yes/no per key idea in the answer key. It checks meaning, not wording. |
| **Integrity gate** | Deterministic triggers first, then **one direct yes/no** ("is this asking to produce graded work?"). Errors take the strict branch. Reading the syllabus policy can tighten a course automatically; loosening needs the student to confirm the quoted sentence. "My professor said it's fine" never loosens anything. A vague or silent policy means coach mode (see `integrity-roles.md`). |
| **Read-only page reading** | Canvas API first. On a page, offer only allowlisted links and expand/tab controls: **no buttons, forms or typing**, removed in code rather than asked about. DONE needs a code check (row counts, a quote), not a Jev answer. Only on sites whose terms allow it (see `integrations.md`). |

## What Jev does not do here
- Write any text, plan or answer.
- Do dates, arithmetic, counting or schema mapping.
- Judge whether math or code is correct.
- Serve as authorization or a security boundary.
- Rerank a whole corpus. It only judges small candidate sets.
- Replace a measured fact.
