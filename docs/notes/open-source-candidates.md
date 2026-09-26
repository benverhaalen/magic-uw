# Open-source candidates for the learning features

**Status: researched.** These are candidates, not dependencies. Adoption follows the gate in [tool evaluation](../tool-evaluation.md): pinned version, licence including model weights, data destinations, and an acceptance test on our material. Licences and dates were read via the GitHub API on 2026-09-26. Stars are a popularity signal, not quality.

| Need | Candidate | Licence | Latest release or push | What we'd take | Risk |
|---|---|---|---|---|---|
| PDF text by page | [unjs/unpdf](https://github.com/unjs/unpdf) | MIT | v1.8.1, 2026-08-13 | per-page `extractText` (a pdf.js wrapper) | pdf.js version drift |
| PDF text by page | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache-2.0 | v6.3.289, 2026-08-29 | `getPage(n).getTextContent()` with positions | worker setup in Electron |
| PPTX by slide, DOCX | [harshankur/officeParser](https://github.com/harshankur/officeParser) | MIT | v8.0.0, 2026-09-16 | an AST with slide boundaries | verify that slide indices map to slide numbers |
| DOCX → text/HTML | [mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js) | BSD-2-Clause | active pushes; last tagged 2016 | read-only previews | no page model (inherent to .docx) |
| PDF with layout | [run-llama/liteparse](https://github.com/run-llama/liteparse) | Apache-2.0 | node-v2.14.7, 2026-09-22 | spatial text with page grouping | a native Rust binary per platform |
| Spaced repetition | [open-spaced-repetition/ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) | MIT | v5.4.2, 2026-09-01 | FSRS scheduling and retrievability | none significant |
| Mind maps | [markmap/markmap](https://github.com/markmap/markmap) | MIT | v0.18.0; pushed 2026-09-12 | Markdown outline → interactive map | we author the outline |
| .docx notes | [dolanmiu/docx](https://github.com/dolanmiu/docx) | MIT | 9.7.2, 2026-09-23 | declarative headings, tables (Cornell layout), styles | none significant |
| .docx from templates | [guigrpa/docx-templates](https://github.com/guigrpa/docx-templates) | MIT | v4.15.0, 2025-12-03 | Word-authored templates | less active |
| .docx from templates | [docxtemplater](https://github.com/open-xml-templating/docxtemplater) | GitHub reports NOASSERTION; paid modules exist | pushed 2026-09-21 | — | **avoid unless the licence is read:** GPL option, paid tiers |
| NotebookLM-style features | [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook) | MIT | v1.14.0, 2026-07-21 | the transformation-prompt pattern and feature taxonomy; a benchmark competitor run locally with the same model | Python + SurrealDB backend; its prompts are seeded in the DB, not files |
| Canvas harvesting reference | [jasp-nerd/canvas-course-downloader](https://github.com/jasp-nerd/canvas-course-downloader) | MIT | v2.11.0, 2026-09-18 | session-authenticated module/file walking logic | a browser extension; port the logic only |
| Canvas harvesting reference | [KTH/canvas-api](https://github.com/KTH/canvas-api) | MIT | v4.2.0 (2022); pushed 2026-09-24 | `Link` header pagination | token auth by default |

## Not adopted, and why
- **Canvas LMS source (AGPL-3.0):** read-only reference for endpoint semantics; never copied.
- **Duolingo-clone repositories:** found only brand-new, unlicensed or zero-star projects. Treat them as interaction references only.
- **Three identical "cortex" NotebookLM-alternative repositories** created within days of each other with no history: treated as likely spam.
- **A pre-filled Google Doc without OAuth:** doesn't exist. `docs.new` takes no content, and the Drive API needs OAuth.
