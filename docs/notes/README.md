# Research notes

Deeper research and feature proposals behind the product docs. The status terms match `docs/README.md`: a note is a **Proposal** unless it says otherwise. Individual facts are labelled **sourced** (checked against the cited page or paper, i.e. Verified), **inferred** (our reasoning) or **not-found** (searched, absent). No private course data, credentials or captures are included.

| Note | What it covers |
|---|---|
| [where-we-differ.md](where-we-differ.md) | **Start here:** where the research suggests something different from the current plan and code, with evidence and the trigger for each change |
| [competitive-comparison.md](competitive-comparison.md) | Magic Canvas vs Gemini Notebook (NotebookLM), Quizlet and Duolingo: cost to the student, efficiency, capabilities, where they are ahead |
| [benchmark-catalog.md](benchmark-catalog.md) | Public datasets and metrics to measure against, licences checked: citations, long documents and slides, item quality, knowledge tracing, spaced repetition, speed and cost |
| [performance-plan.md](performance-plan.md) | Evidence-ranked choices for retrieval and citations, speed and cost, quiz and test intelligence, and evaluation (reviewed and corrected) |
| [benchmarking.md](benchmarking.md) | How to benchmark against NotebookLM and study tools without fooling ourselves: tasks, corpus, freezing gold, seeded errors, blind rating, statistics |
| [retrieval-research.md](retrieval-research.md) | What's reported to beat plain search (graph RAG, BM25S, SPLADE, ColBERT, ColPali, late chunking, long context), embeddings in Electron, agentic search vs vectors, and what we adopt |
| [local-db.md](local-db.md) | The local SQLite store as built, checked facts, and proposed additions (feature tables, passages, query form, embeddings only if measured) |
| [backend-map.md](backend-map.md) | What the current code gives learning features: store methods, commands, IPC, extension points, and what would need changes to the current packages |
| [business-model.md](business-model.md) | $5 a month (earlier: one-time $5), bring-your-own paid AI, who pays for Jev, payment and distribution options |
| [notes-targets.md](notes-targets.md) | Where generated .docx notes go: local first, detected OneDrive or Drive sync folders, opt-in Drive or Graph APIs |
| [open-source-candidates.md](open-source-candidates.md) | Licence-checked open-source candidates for extraction, spaced repetition, mind maps, .docx, and NotebookLM-style features |
| [jev-insights.md](jev-insights.md) | How each planned Jev judgment is designed: questions, state, thresholds, journal, browsing loop, fit with today's gateway (no performance numbers) |
| [ai-provider-access.md](ai-provider-access.md) | What provider terms allow for "use your own ChatGPT/Claude/Gemini account"; the supported connector and extension routes |
| [practice-engine.md](practice-engine.md) | Practice quizzes and exams from the best available source (fidelity tiers), result review, regenerate and tweak, preparedness, adaptive flashcards, study clocks |
| [practice-evidence.md](practice-evidence.md) | Evidence: study products, item generation, preparedness modelling, calibration, study-session timing |
| [notes.md](notes.md) | Note templates per session type (guided, matrix, worked-problem, Cornell, lab, reading prep, concept maps), the after-class retrieval loop, accessibility, and the evidence |
| [integrity-roles.md](integrity-roles.md) | The roles an academic tool can play without doing graded work; UW policy levels; citation verification; the feedback-vs-authoring line; the AI-use log |
| [project-coordinator.md](project-coordinator.md) | Per-project spaces, milestones, team features, linking email, Canvas, Ed and Piazza conversations, drafted messages the student sends |
| [integrations.md](integrations.md) | Canvas as the hub (LTI tools, sessionless launch), the in-tool deadline gap, each platform's terms on automated access, FERPA vs platform terms |
| [major-toolkits.md](major-toolkits.md) | Toolkits per major, with UW access routes (CS terminal/SSH/GitLab, MATLAB/CAE, Mathematica/Overleaf, LabArchives, library/Zotero…) |
| [calendar-life.md](calendar-life.md) | A layered academic calendar and a Life space (registrar dates, Starfish advising, WIN clubs, campus events, Outlook metadata signals) |
| [jev-usage.md](jev-usage.md) | Design rules for each typed judgment (no performance numbers) |
| [agent-runtime.md](agent-runtime.md) | Chat and agents on the student's own Claude Code / Codex / Gemini CLI or a local model: provider terms, choose-your-client setup, headless runtime, allowlist, disclosures |
