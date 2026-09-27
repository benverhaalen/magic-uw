# Backend handoff: where syllabi actually live, and how to read them

Updated: September 27, 2026, about 00:40 CT. Human owner: Ben. Agent: Claude Code (Opus 5.5). **Recipient: Nathaniel and his agent**, who own the sync, crawler, course-intelligence and runner code involved. Base: main `5865722`. Status: **investigation and plan only. Nothing is implemented.** Ben: "send all this to docs where nates agent can pick it up dont do anything."

## Why

The new course page (`feat/course-page`, [packet 10](../courses/10-course-page.md)) shows "No AI policy found" for every one of Ben's current courses. Ben asked why the app can't read syllabi and for a deep investigation. He authorized headless, read-only use of his Canvas session for this check.

## Method (evidence is private and local; only aggregates here)

- **Live Canvas:** GET-only API probes of Ben's 6 recent courses (5 this term plus 1 from spring). Headless Playwright was used for outside sites; no Canvas cookies were sent to non-Canvas hosts.
- **What we capture:** compared against a full pull through current `createIngestion` (before `0978df9`).
- **Code:** an independent read-only code map, whose findings agreed with the live results.
- Courses are labeled A–F here. The mapping, scripts and notes stay out of Git.

## Where each syllabus lives vs. what we got

| Course | Actual location | Reachable as a student? | Captured by our pull | Why no course facts |
|---|---|---|---|---|
| A | PDF module item; Files tab 403 | Yes: `GET /api/v1/courses/:id/files/:id` returns 200. About 15k characters of text; mentions AI, grading and exams | Title only, 0 chars | Only Files-tab files were downloaded. **Main `0978df9` now queues `moduleItem.contentId`**, but syllabus files are not prioritized (see gap 3) |
| B | Canvas syllabus tab (about 7k chars); its AI note is on the **front page** | Yes | Syllabus ✓; front page not read as such | Headings are "Grading breakdown" and "Exams". Literal extraction only accepts exact lines like "grade breakdown" and "examinations", so it produced 51 topic passages and no course-level grading or assessment claims |
| C | Public course website, `/fa26/syllabus.html` (about 18k chars) | Yes, no login | **0 pages** | The site's `robots.txt` returns **403** (bucket hosting). `external.ts` `allowed()` rethrows any non-404 error, so the whole site is marked inaccessible in about 300 ms |
| D | PDF module item; Files tab 403 | Yes (200); about 21k chars; mentions AI, grading and exams | Title only | Same as A |
| E | Canvas Page "Syllabus" → public **UW Box** `.docx` (about 18k chars, many AI mentions) | Yes: public shared link with a Download button, no login | Page ✓ (737 chars), docx ✗ | The Box viewer renders with JavaScript, so a plain fetch gets no text. The crawl also spent its 300-page budget off-course (Wikipedia 97 pages, government sites, blogs) |
| F (spring) | Course website (landing page has homework and grading policies) | Yes | ✓ 41 pages | `web` sources are never eligible for course facts |

**Root cause shared by all six:** course-level facts only come from the Canvas syllabus body. The `syllabus()` predicate in `packages/domain/src/course-intelligence.ts` (about l.94) requires a Canvas source, `externalId === "syllabus"` and scope `"syllabus"`. The local-model path adds the same restriction (`packages/core/src/index.ts` about l.340, `packages/ai/src/course-extraction.ts`). The semantic extractor is also Ollama-only, so on Ben's machine it reports "semantic unavailable".

## Gaps, ranked

1. **Syllabus selection (D34 / T24, blocked on H6).** Code should pick one syllabus per course and let the compiler accept that resource id. Candidate order:
   1. Canvas syllabus body with meaningful text.
   2. A Canvas Page, module item or file in the same course titled or linked as "syllabus". Prefer the current term and the newest version.
   3. A page on a course website that is linked from the course's own Canvas module or syllabus, with "syllabus" in its URL or title.
   - Keep evidence quotes and source links.
   - Suggested smallest H6 answer: revise course intelligence (pass a `syllabusResourceIds` set into the compile) rather than adding the `course_briefs` writer now. **Nathaniel decides.**
2. **Robots 4xx means allow.** `packages/connectors/src/external.ts` `allowed()`: treat 4xx from `robots.txt` as "no rules". RFC 9309 §2.3.1.3 says a crawler may access any resource when robots.txt is unavailable (4xx); 5xx remains disallow. Fixes C.
3. **Syllabus files first.** In `apps/desktop/src/ingestion.ts`, the `jobs` ordering after `0978df9` puts urgent coursework ahead of everything else under the 120 s `fileBudgetMs`. Treat syllabus-titled files and links as urgent so they aren't `file_budget_deferred`. Fixes A and D in practice.
4. **Wider literal headings.** In `course-intelligence.ts`, accept `grading( breakdown| policy)?`, `grade breakdown`, `exams?`, `examinations`, `(ai|generative ai|llm)( use| policy)?`, `academic integrity`. Also add `llm`/`copilot` to the AI line test. Test against real syllabus shapes.
5. **Claude/Codex instead of Ollama for course facts** (Ben's direction: "use the nate built codex or claude type thing instead of an ollama").
   - Add a `courseExtractor` backed by the student's chosen client, the same way `apps/desktop/src/worker.ts` builds `generationRunner()` (isolated profile, `createClaudeBackend`/`createCodexBackend`).
   - Put every call through the **same egress path as `packages/core/src/pack-handler.ts`**:
     - `maySend` category grants;
     - `payloadScrubber` / `scrubText`, mapping quotes back with `toOriginalSpan`;
     - `egressFor(store).check`: receipt, and a blocking preview the first time a new category is shared.
   - Keep the existing contract: the model returns quotes, and the compiler keeps only verbatim `text.slice(start,end) === quote`.
   - Raise the 6,000-character cap to about 40k; these syllabi are 15–21k.
   - Run once per course when the syllabus content hash changes, under the background budget.
   - Needs a method label other than `local_model` (for example `client_model`, rendered as "Found by Claude/Codex").
6. **Later (after BuildFest):**
   - Public Box/Drive shared-file download. `space-hosts.ts` marks them link-only, which is a policy decision.
   - Read the front page via `default_view` and `/front_page`; this needs the `canvas-http.ts` allowlist.
   - Keep the crawl on course-owned hosts and follow "syllabus" links first. This would stop the off-course budget burn.

**Projection, not measured:** gaps 1–4 let the syllabus be found for about 5 of 6 of Ben's courses (all but the Box course). Gap 5 turns more of that text into facts. Estimates: gaps 1–4 about half a day; gap 5 about half a day.

## Risks Ben raised or accepted for review

- **Timing and ownership:** most of this code is Nathaniel's and was just rewritten (`0978df9`). Changing it before judging risks sync regressions.
- **Egress:** gap 5 sends syllabi to Anthropic or OpenAI under the student's account. It must use the consent, receipt and preview flow in [decisions](../../../../docs/decisions.md#pricing-and-ai-access-resolution--september-26). Ben has **not** yet confirmed consent for his own syllabi.
- **Wrong-document risk:** a wider syllabus choice could pick last year's syllabus or an unrelated page. Mitigate with strict, code-ranked selection and a visible source.
- **Interpretation:** a verified quote proves the text exists, not what it means. Never collapse it into "AI allowed".
- **Cost:** each client call uses the student's quota and takes roughly 20–60 s. Run once per syllabus change.

## Next action

**Nathaniel:**
- Accept or adjust the H6 answer and the selection order.
- Decide which gaps to take before 11 AM. Gaps 2 and 3 are small and independent.
- Say whether Claude Code should also stop editing this code.

Ben said not to implement anything from this packet in this session.
