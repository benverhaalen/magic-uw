# Plan: connect everything, map it right, build the notebook

**Tier: specification.** The interfaces change: storage schema v5 and v6 (`main` holds planning at v4), the agent API, prompt packs and the model runner. The blast radius covers the shared storage package.
**Outcome:** [spec.md](spec.md) §1. **Acceptance:** the spec's "Acceptance for the whole". **Tasks:** [tasks.md](tasks.md).
**Priority (operator):** the system-built method first: connect, store, map, the notebook and AI execution. The MCP course bank and remote access are secondary and never drive the app.
**Constraints in force:**
- The operator's words: "local for ownership of materials"; "app functions that require ai use are really just effective expertly written and configured prompts that invoke / commands and tools"; "terms of service and privacy policy should outline that data sent to the ai providers is dependent on their chosen client and jev".
- Changes to shared packages go through PRs to `main`, reviewed by the team.
- No Jev performance numbers in public docs.

## 1. Deciding facts (checked 2026-09-26)

| Fact | Value | Source |
|---|---|---|
| Sign-in exists | embedded window, `persist:uw`, profile check, no keep-alive | `apps/desktop/src/main.ts` (`magic:signin`) |
| Password storage | the standard applies to "applications or systems for UW-Madison business"; "Storing one's personal NetID and NetID password in a password management application is permitted" (re-read 2026-09-26) | UW NetID standard, kb.wisc.edu/itpolicy/page.php?id=59262 |
| Duo "Remember me" | **7 days**, per browser (was 12 hours) | it.wisc.edu, "extending the 'Remember Me' function from 12 hours to 7 days" (published 2025-06-02, corrected 2026-09-26); KB 85205; the student FAQ (modified 2026-07-17) still says 12 hours |
| Student Canvas tokens | request form only since 2025-11-14; ≤90 days | kb.wisc.edu/luwmad/156712 |
| Storage today | `node:sqlite`, schema v3: `resources`, `resource_versions`, `jobs` (leased), `judgments` (input hash + model + question version), `links` (reason, status), `attempts`, `receipts`, FTS5 `resource_search` | `packages/storage/src/index.ts` |
| Local agent databases | none beats SQLite at 1–5k documents on independent evidence. Turso Database (MIT, v0.7.2): native vectors and MVCC writes, the MVCC in beta. LadybugDB (the Kuzu fork): its Node binding dates from Feb 2026, v0.18–0.20 (corrected 2026-09-26). HelixDB is a server, **now with an embeddable in-process mode** (corrected 2026-09-26). SurrealDB is BSL 1.1 | today's research sweeps |
| Graph retrieval | graph-structured retrieval loses 5–10 F1 on simple QA (arXiv 2502.11371, corrected 2026-09-26). HippoRAG 2 indexing: 9M tokens, vs 115M for GraphRAG-style extraction on MuSiQue (arXiv 2502.14802, corrected 2026-09-26) | arXiv 2502.11371; arXiv 2502.14802 |
| Headless flags | Claude `--json-schema`, `--tools ""`, `--no-session-persistence`, `--strict-mcp-config`; `--bare` drops the subscription login. Codex `--output-schema`, `--ephemeral`, `-s read-only`, `--ignore-user-config`. Gemini `-o json`, no schema flag found | `--help` on this machine; vendor docs |
| Model prices and context | Sonnet 5 $2/$10 · Opus 5.5 $4/$20 (both 1M) · gpt-6-luna $0.10/$0.50 · gpt-6-sol $2/$10 (1.05M) · Gemini 3.5 Flash $1.50/$9 · 3.1 Pro preview $2/$12. All support structured outputs on OpenRouter. `typesafe/jev-router` is listed | OpenRouter `/api/v1/models`, 2026-09-26 |
| Outlook via Graph | delegated `Mail.ReadBasic`: "except body, previewBody, attachments…", admin consent No; `webLink` opens the message in Outlook on the web; delta query; 10,000 requests per 10 min, 4 concurrent. **Microsoft's default "Let Microsoft manage your consent settings" tenant policy excludes `Mail.ReadBasic` from user self-consent, so probe E1 is likely blocked without publisher verification (corrected 2026-09-26)** | learn.microsoft.com permissions reference, message resource, message-delta, throttling limits |
| UW tenant consent setting | not found (UW-specific; probe E1 stands). Microsoft's actual default tenant policy is the dynamic "Let Microsoft manage your consent settings," not a static verified-publisher/low-impact-only option (corrected 2026-09-26) | learn.microsoft.com manage-app-consent-policies; user-admin-consent-overview; **probe E1** |
| Campus feeds | `today.wisc.edu/events.ics` returns VCALENDAR; `badgerherald.com/feed/` is RSS; `news.wisc.edu` has WordPress REST. MyUW `Disallow: /`; Handshake and WIN restrict crawling | fetched 2026-09-26 |
| Competitors | Gemini Notebook (NotebookLM): manual sources, free plan 50 per notebook, no LMS integration in its help pages, compute-based limits since 2026-09-02. Open Notebook v1.14.0 (MIT): SurrealDB; "transformations" as prompt templates; per-source context levels; its own README lists citations as "Basic references (will improve)" | support.google.com/gemininotebook; github.com/lfnovo/open-notebook |
| Jev gateway today | one question (`assignment.kind.v1`); defaults of 20 calls a day per device, 5 an hour, 1 at a time, 100 a day in total | `apps/gateway/src/gateway.ts` `DEFAULT_LIMITS`; `docs/notes/jev-insights.md` §7 |
| Kaltura captions | exist only where the owner ordered them; UW says ~75% accurate; student-session access unknown | KB 92764; **probe K1** |

**Findings about stale inputs:**
- `docs/tool-evaluation.md` still calls `node:sqlite` experimental.
- An earlier retriever reported `typesafe/jev-router` as missing from OpenRouter. The model API lists it; the web page renders client-side.
- The same retriever inferred a 200k context for Opus 5.5. The API reports 1M.

## 2. Decisions

Each decision names the candidates it beat and the situation in which the chosen option would lose.

**D1. Storage: stay on `node:sqlite`, and add schema v5 (the course core) and v6 (learning and practice) in the same file, after planning's v4.**
- **Beat:**
  - Turso Database: its MVCC is beta, and a rewrite is a risk at launch.
  - PGlite + pgvector: a heavier engine, and a second store.
  - LadybugDB: its Node binding is very new.
  - "Do nothing": no passages, no graph.
- **It loses if** concurrent-writer contention appears, or if a vector scan misses its budget at 50k passages. Then Turso Database, which keeps the SQLite file format, is the planned upgrade path, re-checked at its next stable release.
- **Claims:** known (the research table); hypothesis (no contention at one writer).

**D2. The course graph is built by the compile, not by graph-RAG indexing.**
- **Beat:** LightRAG/HippoRAG-style extraction, which costs millions of tokens and hurts simple questions; rules alone, which fail on at least 2 of 5 real layouts.
- **It loses if** open questions that span many hops turn out common in chat. Then add a graph-walk tool over the same tables. No new engine is needed: recursive CTEs cover a graph of thousands of nodes (derived).

**D3. Typed lookups first, search second, vectors last.**
- **Beat:** vector-first RAG. Most app functions know their scope, so a search adds nothing.
- **It loses if** chat questions dominate and BM25 misses paraphrases. MF4 in the [agent data-layer proposal](../2026-09-26-agent-data-layer/proposal.md) decides.

**D4. Prompt packs are data, and one runner executes them.** A pack is a versioned file under `packages/packs/` with inputs, budget, schema, checks, gates, tier and cache key. A `ModelRunner` interface has adapters for claude, codex, gemini, openrouter and jev.
- **Beat:** hand-written calls per feature, which drift and have no cache or ledger; a general agent loop per feature, with more turns and tokens (Anthropic, "Building effective agents").
- **It loses if** a function needs several dependent model steps. Then a pack may chain two calls, each checked.

**D5. The model never gets tools inside the app.**
- Known-scope packs make one call with tools off.
- Explain and chat use retrieval the app runs itself: the model asks for more through a typed `need` field, and the app runs the lookup (spec D4).
- The MCP course bank is a separate, optional extra for the student's own clients. It never drives app features.
- **Beat:** `--dangerously-skip-permissions`, which the docs limit to containers or VMs, while course text is untrusted input; and `--bare`, which drops the subscription login.
- **It loses if** a client removes schema output. Then zod validation and one retry, which is already the Gemini path.

**D6. Routing by tier, with escalation on a failed code check.**
- **Beat:** always using the strongest model, which costs about 2× on Claude (price table); always using the cheapest, which is unchecked.
- **Evidence:** FrugalGPT-style cascades report matching the best model at up to 98% lower cost (arXiv 2305.05176).
- **It loses if** fast-tier failures run so high that the double calls cost more than going strong directly. The ledger shows the escalation rate, and a pack whose escalation rate exceeds 40% moves up a tier by default.

**D7. Jev for every typed judgment; the student's AI only for writing and reasoning.**
- **Beat:** routing item cards through the student's AI. That's hundreds of calls per course against their quota, where Jev is cheaper and faster by design.
- **It loses if** Jev is unavailable. Then item cards queue, and the compile still runs on structure alone.

**D8. Sync keeps the no-keep-alive rule and refines the tiers the refresh coordinator already has.**
- **Beat:** keep-alive pings (against the sign-in code's stated rule); storing the password without the student's opt-in (D39).
- **It loses if** sessions expire so often that content lags badly. Then the student is offered UW's token request as an optional route.

**D9. The agent API is one handler layer behind a read-only reader process.** This is the [agent data-layer proposal](../2026-09-26-agent-data-layer/proposal.md) §3.3–3.4, unchanged. It settles N26 in favour of the bridge, as a PR to `main`.
- **Amended (spec F1):** when the app is closed, the MCP entry point starts the read-only reader itself and serves the last-synced data with freshness stamps. This replaces the proposal's "exit and ask to open the app". Receipts go to an append-only log that the worker imports, so the one-writer rule holds.
- **Registration:** the course bank is registered in each detected client with its own `mcp add` command, run with consent.
- **Shared pack text:** the course bank also exposes the pack instructions as MCP prompts, a convenience in the student's own client. The app runs packs through its own runner and never through MCP.

**D10. The Terms, Privacy Policy and in-app data notice are written last,** from legal research and expert application, on top of `docs/ai-and-privacy.md`, with a destination table per client (spec G2).

**D11. Life beyond courses: Outlook is collected by code as a gist and a link, plus public feeds. No site scraping, no background computer use.**
- **Email:** Microsoft Graph delegated `Mail.ReadBasic` (admin consent "No"; no bodies), delta sync, and `webLink` to open the message.
- **Public feeds:** today.wisc.edu ICS, the Badger Herald and UW News feeds.
- **Beat:**
  - scripted reading of Outlook on the web: undocumented, and its terms weren't found
  - computer use in background sync: tokens and time on every run, and it breaks on UI changes
  - scraping Handshake or WIN: their `robots.txt` restricts it. My UW is read only through the planning adapters on `main`
- **It loses if** UW's tenant blocks user consent. Then an on-demand code read of the rendered inbox list in the app's own Outlook window (spec A3; Microsoft's terms checked before it ships), or the student's AI with a browser, is the fallback, and publisher verification plus a UW app request is the fix.
- **Probe E1:** do `bodyPreview` and `webLink` come back under `Mail.ReadBasic` on a UW account?

**D12. Web and phone access goes through our outbound relay, not tunnels.**
- **Spec F2.** The relay is pass-through only, OAuth 2.1, and off by default.
- **Beat:** Cloudflare quick tunnels (dev-only by their own terms, no SSE), Tailscale Funnel (beta, needs an account), ngrok free (an interstitial page and a 1 GB cap).
- **It loses if** students need access while the laptop is asleep. A cached snapshot at the relay would fix that, but it breaks "local ownership". Not proposed; it'd be the student's explicit choice if ever added.

**D13. The one quick pass runs on Sonnet 5, GPT-6 Sol or Gemini 3.5 Flash, whichever the student has, and escalates on a failed check.**
- **Why a pass at all:** it's used only where code and Jev can't read the language. Examples: scope statements, schedules in PDFs or external sites, and ranking materials into tiers.
- **Beat:**
  - rules alone: they fail on at least 2 of 5 real course layouts
  - gpt-5.6-terra: older, and $2.50/$15 against Sol's $2/$10
  - GPT-6 Luna for the pass: cheapest, but "for easier tasks"; it's kept only for typed classification when Jev is unavailable
  - Opus 5.5 first: 2× Sonnet's price, so it's kept for escalation
- **It loses if** Sonnet or Sol fail the checks on more than 40% of courses (from the ledger). Then that client starts at the strong tier.

**D14. The notebook is the course page, and the assessment dossier is a scoped notebook with capped tiers.**
- **Caps:** Core ≤8, Also useful ≤6, Practice ≤5; assignment work view ≤5; Study & Learn ≤3.
- **Beat:**
  - NotebookLM's manual notebook: sources uploaded by hand, 50 per notebook on the free plan, and no LMS awareness
  - Open Notebook's model: manual sources and "basic" citations
  - showing everything in scope: the Home direction says to avoid filler and repetition, and "not too much, not too little" is the operator's bar
- **It loses if** students routinely expand "All in scope" or move items between tiers. The ledger tracks both and adjusts the caps.

**D15. Notebook features are prompt packs over the mapped scope** (Open Notebook's transformations, made course-aware). Context levels are set per source by tier (full, summary or off). Every citation is checked by code.
- **Beat:** free-form chat over all sources, which spends more tokens and isn't anchored to exams.
- **It loses if** a student wants a cross-course synthesis. Then the scope is the union of the chosen courses, under the same caps.

**D16. Jev item cards need a gateway change: batched, versioned question endpoints, and limits sized to the operator's budget.**
- The default limit of 20 calls a day per device can't cover hundreds of items per course.
- **Volume per course, first sync (inferred from a real 5-course term, 158 assignments plus modules and files):**
  - about 150–300 items that code can't fully classify → one batched card request each
  - plus about 3 upcoming assessments × ≤30 link candidates → about 90 Nouls in batched requests
- **Volume after that:** about 5–15 requests a day per course, for changes only.
- **The global cap** must be set against students × that. A gateway deploy is public, so it needs the operator's say.
- **Beat:**
  - sending item cards to the student's AI: it spends their quota on typed questions
  - skipping item cards: the pass would then have no per-item roles or topics
- **Mitigations until it lands:**
  - code classifies first (Jev rule G1: "If a regex, a Canvas field or a string match answers it, no call")
  - one request per item carries all of its questions
  - a priority queue, with upcoming assessments first
- **It loses if** the operator's budget can't carry per-item cards at scale. Then cards run only for items that are candidates for upcoming assessments.
- **Owner:** the gateway owner, through a PR to `main`.

**D17. One data model and one migration path for course, learning and practice data.**
- The learning spec's §7.2 tables and the practice addendum's §6 tables become the schema v6 migration in `packages/storage`, owned there with `user_version`.
- **Replaced:** `learning_passages` and `learning_passage_search` by `passages` and `passage_fts`; `learning_jobs` by the extended `jobs`; `course_topics` by `learning_concepts`; `pack_results` by `learning_artifacts`, which gains pack and pack_version.
- `learning_coverage` keys to `assessments.id`.
- **Beat:** two stores for passages, concepts, jobs and artifacts; the extension hook (B02), a second versioning scheme beside `user_version`.
- **It loses if** the learning tables need to ship independently of the storage package. They don't: it's one app.

**D18. "Quiz me on…" resolves topics code-first, then Jev, then a small pack, and the student confirms the chips before starting.**
- **Beat:**
  - sending every request to the student's AI: slow, spends quota, and the quotes are harder to check
  - free-text search over items: misses paraphrases, and ignores ranges like "lectures 10–12"
- **It loses if** the concept labels are too coarse for students' phrasing. Then the pack's proposals are saved as student aliases, so the next match is code-only.

**D19. One build, ordered backend first; nothing is scheduled "after".**
- **The operator's priority:** "prioritize the backend being fully finalized and optimized with the research and expertise in infrastructure we've established. Then move on to perfecting the system driven and needed llm token used features. The open notebook, quizlet like system."
- **Phases,** each starting when its dependencies are done:
  1. the backend: every source, the full schema, the in-app handler layer, the measured optimizations O1–O11 and M1–M5 on the MT1 harness
  2. the LLM-token features: the runner and packs, course pass, mapping, items, cards, quizzes, guides, chat
  3. the study system: the notebook, Quizlet-like modes, understanding and mastery, topic selection
  4. secondary (course bank, relay), then legal
- **Conditions, not dates, gate:** E1, K1, the operator's say for public deploys, and legal last.
- **Beat:**
  - a hackathon cut with a later bucket (rejected: "we are not scheduling work after")
  - a practice-first track (rejected: the backend comes first)
- **It loses if** the 11:00 submission needs a visible study feature. Then the demo shows the backend, the course map and whatever phase 2 or 3 has finished, labelled. The operator chose this order knowingly.

**D20. A study tool, not a game.** There's no XP, no streaks or freezes, no Duolingo path, no Match, no notifications, and no leaderboards.
- **What's kept:** everything that serves understanding: modes, topics per question, sectioned assessment quizzes, levels, the mastery bar, error patterns, the coverage map.
- **Beat:** the practice addendum's engagement loop (PI-1–PI-8, PI-13).
- **It loses if** usage data later shows students don't return between exams. Then engagement comes back as its own spec.

**D21. The mastery bar is defined only by stated evidence rules.**
- **The topic bar** is `min(0.99, min(c/8,1)·min(p̂/0.75,1))`, where `c` is unassisted correct answers and `p̂` is the point estimate. It's 1 only at Solid ("Mastered"). A right answer raises it and a wrong one lowers it, and a change marker shows after each answer. The final review showed the earlier `n`/`p_low` form could rise after a wrong answer.
- **The assessment bar** is the coverage-weighted average, labelled with counts and "not a grade prediction".
- **Beat:**
  - a predicted score or pass probability: unvalidated, and a false promise
  - showing bands only: the operator asked for a progress bar
- **It loses if** the offline evaluation (P18–P21) shows the thresholds are badly calibrated. Then the configuration changes, and the bars recompute by replay.
- **Team conflict to raise:** `docs/product.md` says "No invented mastery, readiness score, or completion claim".

**D22. The backend is "measured" only when it beats or matches public tools on fixed targets** (spec B6).
- **Phase 1 ends with:**
  - the MT1 baseline
  - the optimizations, reported before and after
  - the head-to-head backend rows (MT7a)
- **MT7b adds** the answer, quiz, course-map and token rows once phase 2 produces them.
- **Claims come only from the comparative rows in spec B6.** Internal rows (local p95, precomputed, our own ablation) are never claimed against other tools.
- **The targets are written in the spec before any run.** A missed target is published as missed, and its claim isn't made.
- **Beat:**
  - self-referential speed numbers (they prove nothing to a student or a judge)
  - a head-to-head only at the end (the operator: the measured backend comes first)
- **It loses if** a public tool can't be timed fairly by hand. Then that row is marked "not measured", never estimated.

**D23. Phase order is dispatch priority; nobody idles.**
- A later-phase task starts only when **no earlier-phase task is ready or in progress without an owner.**
- With four builders, independent pure-logic tasks (the knowledge model, FSRS, grading) may start on spare capacity while backend tasks are all claimed.
- **Beat:** strict phase barriers, which waste builders on a 24-hour clock.
- **It loses if** spare-capacity work collides with a phase-1 interface. The one-writer rule and T05's seams prevent that.

**D24. Licence activation, signed installers and accessibility are in the build** (spec Part I).
- **The payment provider is the operator's decision** (Lemon Squeezy, Polar, Paddle or Stripe; researched in the business model).
- **Accounts:** Apple and Windows signing need the operator's accounts.
- **Beat:** shipping unsigned builds (Gatekeeper and SmartScreen block or warn on them).

**D25. The open framework is a first-class deliverable** (spec F3): the typed academic data layer, the `magic` CLI and examples, MIT-licensed, with a boundary test.
- **Beat:** an app-only codebase. The operator's vision is a platform other developers build on.

**D26. The AI boundary is decided before building, function by function** (spec §2), and the operator signs it off (gate T02) before phase 2.
- **The principle:** AI writes, code decides. Tokens are spent when content is created (cached and checked), never during study: quizzes, reviews, grading, levels, the mastery bar and the prep list are all code.
- **Four measure-first rows (MB1–MB4)** can only move work from AI toward code.
- **Beat:**
  - deciding feature by feature while building (the boundary drifts toward "just call the model")
  - AI at study time (it costs tokens on every question, adds latency, and makes results nondeterministic)
- **It loses if** code-only organisation misfiles often. The student's corrections and the ledger show that. Then that row moves to Jev, never straight to the student's AI.

**D27. One checkbox at setup, then only the approvals other companies require** (spec G1; T06 in phase 1, before any automatic egress).
- **The checkbox** covers where data goes (Jev and the chosen AI) and the Canvas page-view disclosure. The UW sign-in follows, and Canvas connects automatically.
- **Later prompts:**
  - a new provider's own consent (the list again)
  - **one blocking preview the first time a new sensitive category (student work, grades, comments, communications) would be sent to a recipient, or every time with "always preview"** (Ben's accepted flow; corrected in the P1 review)
  - the providers' own screens, only when used: the AI key, Microsoft's accept screen for Outlook, and Google or Microsoft consent for cloud notes
- **Beat:**
  - consent per destination (more clicks, no extra protection; switching provider re-shows the list anyway)
  - writing consent with the legal work at the end (phase 1 already sends to Jev)

**D28. Generation is Jev + the model, assisted by code** (spec §2 "Generation, assisted by the system"): content analyzers, a planner, code-first cards and outlines, verifiers (including sandboxed code execution), and reuse before generation.
- **Beat:**
  - a model call that reads whole sources and writes everything (NotebookLM-style)
  - code-only generation, which can't write good questions or guides
- **It loses if** the analyzers' extractions are noisy enough that the planner starves the model of context. MT4 and MT6 show that, and the planner falls back to the full scoped passages.

**D29. The notes system is built and kept current by code** (spec D7), with a local folder by default. Detected sync folders need no approval; Drive or Office APIs are opt-in.
- **Beat:** notes as an AI-managed MCP tool (`notes.build_course_tree` in the earlier notes design); code builds the tree without spending tokens.

**D30. Price and benchmark framing:**
- **Price:** open source and free with the student's own keys; $5 lifetime for our hosted Jev service.
- **Benchmark:** NotebookLM first, then whatever can be measured when built. NotebookLM's own token use is unobservable, so token efficiency is compared against a NotebookLM-style long-context baseline and Open Notebook, both on the same model.
- **Beat:** a "free tier" (not the operator's model), and token claims against NotebookLM itself (unmeasurable).

**D31. Reconciled with `main` at `9302865`** (`docs/research.md`, "Research-branch refresh against current main"):
- **Our migrations** are v5 and v6; planning keeps v4.
- **Course Search & Enroll and My UW** come from the planning integration; our T37 is superseded.
- **Planning data** stays local, with no AI, Jev or MCP path.
- **Consent** follows the accepted flow: one checkbox at setup for the chosen provider and Jev, receipts per request, and a one-time preview per new sensitive category.
- **Pricing and Jev billing:** the decisions log records "$5 license + the student's own paid AI". The gateway pays Jev for Claude, Codex and Gemini users; OpenRouter users pay Jev through their own key.
- **Primary navigation** is Home / Courses / My UW / Calendar (Calendar added by Ben at `13ddc3e`: week and month views, the current week by default, suggestions on request); Ben deferred Email as its own surface. Our mail gist and link lands on the Briefing and course pages, not a new tab.
- **Beat:** building beside `main` as if the planning work didn't exist.

**D32. Every course is inventoried by code first; each space found is then read by the cheapest route that works** (the operator, 2026-09-26 about 20:40 CT; spec A5). The mechanism is proven in P3's feasibility pass before anything is built.
- **The operator's direction, in their words:** course formats "will likely need a combined model and jev ultrafast browser driven retrieval, extremely cost effective and faster than public systems"; "all canvas courses are in the same place, all modules are placed as modules, there are ways to drive and collect everything semantic wise, inventory spaces, and retrieve the caught spaces more accurately now that we know what we're looking for."
- **1. Inventory (code, 0 tokens).** Per course, every place content lives:
  - the navigation tabs, including external tools
  - module items by type (Page, File, Assignment, Quiz, Discussion, ExternalUrl, ExternalTool, SubHeader)
  - the syllabus
  - links found in page, assignment, announcement and syllabus bodies

  Each becomes a space: its kind, host, where it was found, its access route (public, UW session, Canvas session, its own login, LTI launch) and its read state.
- **2. Classify (code, then Jev):** a host table covers the known platforms. Jev picks a kind from a closed set only for hosts code doesn't know.
- **3. Read by the cheapest route:**
  - the API where one exists (Canvas REST, GitLab, ICS)
  - a public fetch (the external-site connector)
  - otherwise a **browser-driven read** in a hidden window in the app's own session: rendered text and links, navigation by GET only
- **4. Unfamiliar layouts:** one model pass writes an extraction recipe for the layout. Code validates it against the page and caches it per host and layout, so later reads of that layout are code only. The model runs once per layout, never once per page.
- **5. Coverage is shown, not assumed:** each course lists spaces found, read, needing the student's sign-in, and blocked. A failed read keeps the previous coursework.
- **Guards:**
  - **external tools (LTI) are inventoried and tracked automatically, but the app never performs the launch.** No student input is asked for:
    - what Canvas holds about a tool is read automatically: its tab, its assignments, due dates, points and passed-back grades
    - reading a tool on its own host, where the student already uses it (so no enrolment happens), is evaluated per tool in P3
    - the launch itself is an enrolment, and AGENTS.md gives school access no "submit/enroll/post" capability. Opening one can enrol the student or create an account: Top Hat ("Rosters sync automatically when a student clicks on any Top Hat link"), Piazza and Gradescope
    - Honorlock starts webcam, microphone and screen recording on launch
    - sources: UW KB 65466 "Canvas - Enabled Application Configurations" and the vendors' docs, fetched 2026-09-26 (`research/piece-P3/brief-uw-tools.md`)
  - Kaltura is read on its own host (`mediaspace.wisc.edu`, UW sign-in), not through the LTI launch
  - no click that submits or starts an attempt (whether opening a New Quizzes quiz creates one isn't knowable from Canvas's open source, so the app never opens one)
  - page content is untrusted data
  - third-party logins are the student's own, and never stored
- **Measured:**
  - spaces found against a hand-labelled inventory of the operator's courses (recall)
  - read success per kind
  - time and tokens per course
  - MT7a's setup-and-ingest rows against NotebookLM, which needs manual uploads

  The operator expects this to outperform public systems. It's claimed publicly once MT7a measures it.
- **Beat:**
  - a fixed list of Canvas endpoints, which misses external tools and linked platforms
  - an agent that browses every page with a model: tokens on every page, slow and nondeterministic
- **It loses if** recipes break often as layouts change. The recipe hit rate shows it, and those spaces fall back to plain rendered text.

**D33. No required student input after setup** (the operator, 2026-09-26 about 21:20 CT: "The student shouldnt require additional input … everything is instantly understood and managed for you").
- **Setup stays at two steps:** the one checkbox, then the UW sign-in, where NetID and Duo are the student's own by policy.
- **After that, the system decides.** Every decision (a scope, a material's role, a date, a topic) is made by code, then Jev, then one model pass, and is checked by code. The student is never asked to confirm.
- **Each decision shows its evidence** (the quote and the source) and can be corrected in one click. A correction wins and is never rewritten silently.
- **This replaces "the student confirms each assessment's scope"** (spec C) with "the system settles each scope; the student may correct it". "Confirmed scope" reads as "settled scope" throughout.
- **Kept:**
  - "Quiz me on…" chips: the student's own request, not a confirmation
  - conflicting claims stay visible (for example, a TA email moving a date that Canvas still shows)
- **Measured:** MB1's precision against the operator's labels. The labels exist for measurement, not as a product step. Below MB1's threshold, a scope shows as "provisional" with its quote, and still blocks nothing.

**D34. The syllabus is found by code and becomes the course's checked brief** (the operator, 2026-09-26: the syllabus is "found and understood, acting as almost a system prompt checked document whenever the system needs understanding").
- **Found:**
  - Canvas `syllabus_body` first
  - otherwise the D32 inventory's candidates: files, pages and module items titled or linked as the syllabus, and a linked course site
  - code rules pick one, and Jev chooses among the candidates only when code can't
- **Understood once:** the course pass (T21) turns it into typed fields:
  - the schedule
  - assessments, with dates, weights and scope statements
  - grading
  - policies, including AI use and collaboration
  - texts
  - staff and office hours

  Every field carries a verbatim quote that code checks against the syllabus text.
- **Used everywhere:**
  - the checked brief is the byte-stable first block of every prompt pack for that course (the stable-prefix pattern, O8)
  - code reads its typed fields for rules
  - dates stay in code, and Canvas's own date fields win on a conflict, which is shown
- **Re-derived only when the syllabus's text hash changes.**
- **Beat:**
  - re-reading the whole syllabus in every call (tokens every time)
  - no brief at all (every pack guesses the course's rules)

**D35. The app is an academic layer on the student's own AI client** (the operator, 2026-09-26 about 21:40 CT: "every material should be architected for the database to be perfectly structured, dynamically inventoried, and optimized in collection, storage, retrieval, and utilization by the users choice of cc, gemini, or codex thats automatically detected"; "We offer an infrastructure that layers onto their client. A new and innovative way of serving a user an ai desktop tool").
- **Already in spec E:**
  - detection of the installed CLIs
  - headless calls with per-call flags, in a working folder the app owns
  - the student's own settings never edited
  - tiers, the ledger and the background budget
- **Added:**
  1. **Every material becomes a structured record,** not only the syllabus (D34):
     - its item card (role, session, topics, exam relevance; T20)
     - the analyzers' findings (terms, definitions, formulas, examples, code; T57)
     - passages with offsets (T11)
     - its place in the inventory (D32)

     Collection, storage, retrieval and use all run on the same keys, and a record is rebuilt only when its text hash changes.
  2. **Subject profiles.** Code classifies each course's subject family from its UW subject code and the syllabus brief:
     - quantitative
     - computing
     - languages
     - humanities and social sciences
     - lab and life sciences

     The profile picks the generation pack's variant, the item-type mix and the verifiers:
     - languages: vocabulary cards in both directions, conjugation and cloze, audio in local voices
     - quantitative: numeric items recomputed by code, and worked steps
     - computing: output tracing run in the WASM sandbox
     - humanities: concept, argument, source and date cards, with short answers graded by key ideas

     T58's content-type router runs inside the profile.
  3. **The client is chosen automatically** (D33):
     - the installed, signed-in client is used
     - with several, the order is **Claude Code, then Codex, then Gemini** (the operator, 2026-09-26). Once MT7b measures quality and cost per client, the default becomes the measured best, still automatic
     - the choice is shown in settings and can be changed; it's never a prompt
  4. **Background only:**
     - CLI runs are headless and queued by the job drain, within the background budget
     - the app's UI is the only surface the student sees
  5. **Per-course working folders:**
     - each run's working folder is an app-owned folder per course, holding the context file each client reads on its own (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) with the course brief and the pack instructions, plus the chosen sources
     - the student's global settings, credentials and skills are never read or edited
- **Open facts, checked before any claim or build** (P9's feasibility pass; AGENTS.md forbids promising provider subscription integration before verifying it):
  - each provider's terms on a third-party app invoking the student's own subscription CLI
  - auth-status commands that don't read credential files
  - per-call model and effort flags
  - whether each client reads its context file from the working folder under the flags we use
- **Finding, 2026-09-26, corrected the same evening.** A first retrieval quoted Anthropic's prohibition without its carve-out. The page bytes were re-read by the lead from `code.claude.com/docs/en/legal-and-compliance.md` (also `research/ARCHITECTURE-REVIEW-2026-09-26.md` §7).
  - **Anthropic permits our route, on conditions:**
    - The section "Can customers offer Claude Code in their products?" says: "preinstalling or running Claude Code in your products or services … requires agreeing to our Commercial Terms of Service and complying with the conditions below". The conditions: "The Claude Code binary must not be modified", and "Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential".
    - Also: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
    - What's prohibited is the developer's part: offering Claude.ai login, routing requests through plan credentials, or collecting, storing or intermediating credentials. "Advertised usage limits for Pro and Max plans assume ordinary, individual usage."
  - **Google** (gemini-cli `docs/resources/tos-privacy.md`): "Directly accessing the services powering Gemini CLI … using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies."
  - **OpenAI:** no rule found either way; `codex exec` automation is documented.
  - **Unaffected:** the student driving their own client with our course bank (Part F) is the student's own use.
- **Beat:**
  - an in-app chat on an API key we pay for (the student's plan goes unused)
  - a generic tutor prompt that ignores the subject

**D36. The engine is the student's own CLI, signed in by the student; a stored key is the alternative for key holders** (revised the same evening after the terms correction in D35; the operator: "we can prohibit the system using the cli, through a persistent key being stored as the config", and, in the parallel review, "We really want to get the cli subscription paid way of operating this system working").
- **Claude Code:**
  - the unmodified binary, signed in by the student through Anthropic's own flow (`claude auth login`), with a subscription or their own key
  - the app never reads, stores or routes credentials
  - **before any public release, the team accepts Anthropic's Commercial Terms** (the operator's say), and "Claude Code" isn't used in our product's name
- **Codex:** the student's ChatGPT plan, with no documented arrangement for third-party apps (openai/codex#36886, open). Disclosed in onboarding; the student's own OpenAI key is the alternative.
- **Gemini:** **API key only.** Its CLI terms prohibit third-party use of its sign-in.
- **A stored key:**
  - the student's own OpenRouter, Anthropic, OpenAI or Google key; one OpenRouter key covers every model
  - stored encrypted by the app (`safeStorage`) and passed only to the process the runner spawns, as its environment
  - never written into the student's CLI configuration
- **The grey zone is volume.** "Ordinary, individual usage" applies to background runs the student didn't start, so the background lane:
  - is a visible setting
  - runs within the background budget
  - lands in the ledger, run by run
  - stays at student scale (about 540 calls a term; `research/ARCHITECTURE-REVIEW-2026-09-26.md` §4)
- **The order of clients is unchanged** (D35): Claude Code, then Codex, then Gemini.
- **Also the student's own use:** the course bank and a skills pack inside their own Claude Code or Codex ("a mod").
- **Setup:**
  - with a signed-in Claude Code or Codex detected, setup stays at two steps (D33)
  - otherwise a third step asks for one key
  - without either, study (0 tokens), mapping by code and Jev all still work, and generation waits
- **P9 measures, then chooses:** the CLI run with the key against a direct API call with the same key, on latency, tokens, the cache-hit rate and the Batch API discount (M7). The choice follows the numbers.
- **Open facts for P9:**
  - the flag or environment each CLI uses to prefer an API key over its stored login
  - whether `--bare` (no stored login, no user settings) becomes the right mode once a key is used; the current rule "never `--bare`" was written for subscriptions, and changing it is the operator's call
- **Never:**
  - a subscription login used by an app-initiated run
  - the key in plain text, a log or git
  - the key sent anywhere except its provider

**D37. Undated course materials are detected by a per-course content probe** (proposed from `research/ARCHITECTURE-REVIEW-2026-09-26.md` F1, verified in code 2026-09-26; settled in the P3 review).
- **The gap (code):**
  - a background run reads Canvas in full only when the feeds or the activity-summary signature change (`packages/core/src/refresh.ts:108-121`)
  - the probe is `/users/self/activity_stream/summary` (`packages/connectors/src/canvas.ts:138`), which counts stream items, not files, pages or module items
  - so a file added to a module without an announcement isn't picked up until a manual refresh
- **Proposed:**
  - keep the ≤2-request hot tick for dated items (`todo`, `upcoming_events`, both carrying `context_code`)
  - add a per-course content probe every 15 minutes and on app focus: the course's own activity summary, a hash of its module items, and, where the student can list them, the newest file and page by `sort=updated_at&order=desc&per_page=1`
  - warm-read only the courses whose probe moved
  - freshness becomes ≤5 min for dated items and ≤15 min for undated materials; that N2 change is the operator's decision
- **Measured by** spike S3 in P3: requests per probe, and a new module file detected within 15 min on the operator's course.

**D38. The model runtime is a pool of warm CLI sessions** (the operator's design in the parallel review, `research/ARCHITECTURE-REVIEW-2026-09-26.md` F4 and §10; proposed, confirmed by P9's spikes).
- **Measured on this laptop, 2026-09-26, by the parallel session:**
  - a new `claude -p` per call took 5.8–7.4 s and carried 2.8k–11.3k fixed tokens
  - one warm session (`--input-format stream-json`, our `--system-prompt-file`, tools off, a JSON schema) answered follow-ups in 1.7–2.2 s, with the course prefix read from cache at 0.1×
- **Lanes:**
  - an interactive lane per open course, which keeps its conversation
  - one background lane, rotated per task batch
  - an escalation lane, started on demand
- **Each ask** carries a one-line metadata header plus the passages code assembled; the model still gets no tools.
- **Our system prompt replaces Claude Code's default** (11.3k → 2.8k fixed tokens, measured; F3).
- **One-shot calls** (`claude -p`, `codex exec`) remain the fallback.
- **Open, for the P9 spikes:**
  - S1: context files versus `--system-prompt-file`
  - S2 and S9: Codex caching and app-server base instructions
  - S7: history growth and rotation
  - S8: the memory of idle sessions
  - S10: Gemini ACP with a key

**D39. "Remember my sign-in": opt-in, encrypted, only on UW's login page** (the operator in the parallel review, 2026-09-26: "make it as easy as possible to return. It seems perfectly ok to save both login details with user consent, and duo key if possible for as long as possible … Only of course if the user chooses to remember sign in"; `research/ARCHITECTURE-REVIEW-2026-09-26.md` §12).
- **Why it's allowed** (KB 59262, re-read from the page bytes 2026-09-26):
  - the standard applies to "those who are configuring applications or systems for UW-Madison business"
  - "Storing one's personal NetID and NetID password in a password management application is permitted"
  - the earlier "the app never stores the NetID password" quoted only the rule sentence
  - **if UW licenses the app (phase 2), it becomes UW business**, so the feature has a switch that turns it off
- **For the student:**
  - a checkbox at the UW sign-in, "Remember my sign-in on this computer", off by default
  - Duo's own "Yes, this is my device"; Duo decides how long it lasts
  - on an expiry found by a sync while the student is present (P1-D2), the app fills and submits the saved sign-in on UW's login page. Duo remembered: nothing is shown. Duo expired: only the Duo prompt appears, and the student approves it
- **Built narrow:**
  - capture and fill only in the sign-in window, only on UW's exact NetID login origin, only with the box ticked
  - stored by `safeStorage` (DPAPI, or the macOS Keychain) in the app's data folder
  - never in SQLite, logs, receipts, the ledger, git, prompts, Jev, MCP or any export
- **Safety:**
  - one failed automatic sign-in clears the saved password and shows the normal sign-in; there's no retry loop, so the account can't be locked
  - never as a keep-alive
  - **Duo is never automated**
- **Removal:** Settings ▸ Forget my sign-in, Sign out, purge and uninstall each delete it.
- **Cookies:** the `EnableCookieEncryption` fuse is turned on in the same release. It's one-way; until then, the UW, Canvas and Duo cookies sit readable in `Partitions/uw/Network/Cookies` (measured, §11 of the review).
- **Team boundary:** AGENTS.md says "Never automate Duo or bypass expiry". A saved sign-in re-authenticates after an expiry rather than bypassing it, and Duo still decides. This reading goes to Ben.

**D40. One drivable workspace over one database, driven by the student's own CLI session; content that has text is stored, everything else opens in the browser** (the operator, 2026-09-26 about 22:00 CT: "Establishes optimized seemless connection and an intelligently built and architected database with a terminal driven app interface that unifies all of the stored content into a drivable workspace, of course also with intelligent choices about what to store and what to embed as click to open in default browser pages"; "ollama is an additional feature in the settings menu or available on systems with no client found").
- **Terminal-driven:**
  - the app's asks run through the warm CLI session pool (D38) on the student's own client, in the order Claude Code, Codex, Gemini by key
  - **Ollama is an optional setting, and the fallback when no client is found**
  - a command bar drives the workspace: open a source, "quiz me on …", make cards for a scope, explain, what's due. Code resolves the command first, and the session takes what needs language
  - a live activity line shows the session working
- **What's stored:** text-bearing course content becomes passages with offsets (D35.1), plus the course brief (D34) and the map (D33): pages, files, the syllabus, assignments, announcements, discussions and captions.
- **What's linked, not stored:**
  - tools and platforms: Top Hat, Gradescope, Piazza, publishers, proctoring, Kaltura video pages, Box, Drive and other sites that need their own login
  - each becomes a link card with its title, host, due dates and points from Canvas, and opens in the default browser (`shell.openExternal`, https only)
  - the app never launches an LTI tool itself (D32)
- **Better than main where our evidence says so:**
  - the course brief comes from our course pass on the student's client
  - Ben's compiler (schema v5) and its local extractor stay as the fully local path, and its quote anchoring is reused

**D41. A per-course access check, stored and shown as an indicator** (the operator, 2026-09-26 about 22:15 CT: "an onboarding to ensure all needed systems are authed for that course, like a little thing that we know what we have to access but can't and we can store that to be used as an indicator somewhere in the app").
- **After the course connects,** code checks every space the D32 inventory found with one plain GET, never a launch, and stores its **access state**:
  - `readable`
  - `needs-uw-signin`: the read redirected to `login.wisc.edu` or Canvas `/login`
  - `needs-own-login`: the host table says the platform has its own account, for example Gradescope, Piazza or Top Hat
  - `link-only`: LTI tools and platforms the app never launches (D32, D40)
  - `blocked`: an error, with its reason
  
  Each state is stored with when it was last checked.
- **The indicator:** each course shows a chip such as "2 sources need a sign-in". A short, optional "Connect this course" step lists them:
  - UW single-sign-on hosts (Kaltura MediaSpace, UW GitLab): one click, done in the app's own window; the student does NetID and Duo, and it's usually silent while the UW session is alive
  - own-login and link-only spaces: "Open in browser"
  
  It never blocks study, and never asks again for what's already connected (D33).
- **Rechecked** on the content probe (D37) and after any sign-in.
- **Kaltura:** its first visit needs that one navigation in the app's window, because a background read can't complete a SAML sign-in. Whether a student's session can read captions is probe K1.

**What stays fixed:**
- The connectors, document extraction, refresh coordinator and receipts.
- The `jobs`, `judgments` and `links` tables, extended rather than replaced.
- The learning-features spec for practice and FSRS.

## 3. Interfaces

1. **Schema v5 and v6** (a PR to `packages/storage`, the only owner of `user_version`; v4 is planning's, and is never reused).
   - **Keys:** every table is keyed to `sources(id) ON DELETE CASCADE`, directly or through `resources`. There's no `courses` table.
   - **Purge:** `purge()` adds explicit deletes for `passage_fts`, `ledger` and `ui_events`.

   | Table | Holds |
   |---|---|
   | `passages` | pid, resource_id, version, text_hash, ord, start, end, page, slide, t_start, t_end, heading, tok_est, redacted |
   | `passage_fts` | FTS5 over `ctx` and `body` |
   | `course_sessions` | source_id, course_id, date, ordinal, title, topic_ids, origin |
   | `assessments` | **own id**, source_id, course_id, optional resource_id, kind, date, weight, format |
   | `assessment_scope` | assessment, stated, quote, source_pid, window, status (proposed / confirmed / flagged), confirmed_at |
   | `map_links` | from (assessment, assignment or session), to (resource), kind, tier (core / supporting / practice), reason, rung (code / jev / pass / student), status. **Jev links live here; `links` doesn't gain `covers`** |
   | `life_items` | source_id, area, course_id?, sender or publisher, title, date, labels, link, `duplicate_of`, gist |
   | `compile_runs` | course, pack_version, model, tier, input_hash, tokens, latency, check failures, escalated, created_at |
   | `ledger` | pack, version, tier, model, tokens (in, cached, out), latency, check failures, escalated |
   | `ui_events` | kind (expand_all, move_tier, open, confirm), subject, created_at |
   | `jobs` (extended) | + subject_kind, subject_id, nullable resource_id; `lease(kinds[])`; a staleness rule per kind |
   | `resource_changes` (extended) | + a monotonic `seq` for cursors |
   | learning and practice tables (T10L) | the learning spec §7.2 and practice addendum §6 tables, as the v6 migration (D17); `learning_concepts` replaces `course_topics`, `learning_artifacts` replaces `pack_results` |

2. **`ModelRunner`:**
   ```
   run({pack, tier, input, schema}) → {output, usage: {in, cached, out}, model, latencyMs}
   ```
   It has adapters for claude, codex, gemini, openrouter and jev, and `probe()` → the served models per tier.
3. **Prompt pack:**
   ```
   {id, version, tier, inputs: GraphQuery, budget, system, template, schema, checks: CheckId[], gates: JevQuestion[], cacheKey}
   ```
4. **Agent API verbs:** `packages/agent-api`. The app calls them in-process in the worker. The optional course bank (spec F1) and the developer CLI are thin adapters over the same zod schemas.

## 4. How it runs in this codebase

What exists today (read in the code at `27782e9`):

```
renderer ──preload──► main (Electron) ──utilityProcess──► worker
                        │ owns the persist:uw session       │ owns the Store (node:sqlite, WAL)
                        │ answers the worker's source-fetch │ runs ingestion, refresh, the job drain
                        │ (only main touches the session)   │ asks main to call Jev (main holds the device credential)
                        │
student's CLI ──stdio──► mcp-server.cjs (ELECTRON_RUN_AS_NODE) ── opens the same database file
```

- **Sign-in:** `magic:signin` in `apps/desktop/src/main.ts` opens the window and verifies `/api/v1/users/self/profile`.
- **The worker reads Canvas through main:** `ingestion.ts` asks main for each authenticated fetch.
- **Refresh already has hot and warm tiers.** `core/refresh.ts` ticks every 30 s. Every 10 min ±20%, outside quiet hours, it runs:
  1. the calendar feeds
  2. the activity-summary probe
  3. a full Canvas read **only if the summary or feeds changed**
  4. documents
  5. external sites (a 6-hour TTL)
- **Jobs today:** storage ingest queues `enrich.resource` for every saved or changed item (`storage/index.ts:736`), and the explicit `enrich` command can re-queue one.
  - The drain in `packages/core/src/index.ts` runs only with a gateway configured and `maySend(privacy, "jev")` allowed. It leases every kind, skips non-assignments, and finishes unknown kinds as "Unsupported job kind".
  - Jev calls go through main (`evaluate`), which holds the device credential.
  - **What changes:** T05b extends the existing ingest enqueue to our registered kinds (passages, cards, compile). T10 adds job subjects and `lease(kinds[])`, so each drain takes only its own kinds.

**What this plan adds, piece by piece, where it plugs in:**

| Step | Where it runs | Built on |
|---|---|---|
| Passages with offsets | worker, after document extraction | the extractor's `parts` (page, slide, section), plus the missing `start`/`end`; the schema v4 `passages` and `passage_fts` tables |
| Kaltura links and dates; captions if probe K1 passes | worker, through main's `source-fetch` like Canvas | module items with `external_tool` / embed URLs, which are already captured |
| Outlook mail (gist + link) | sign-in in main: Microsoft's own sign-in page in an app window (MSAL public client, auth code with PKCE), with the token kept in the OS-encrypted vault the app already uses for feed secrets. **Main proxies Graph calls for the worker**, the same way it proxies `source-fetch`; the token never leaves main. A delta sync runs every 5 min on the scheduler T05 adds | a new `packages/connectors/src/outlook.ts`; rows in `life_items`; filing rules plus Jev area questions in the drain |
| Public campus feeds | worker, hourly | the calendar connector for `today.wisc.edu/events.ics`; a small RSS/Atom connector for the news feeds; rows in `life_items` |
| The notebook UI | renderer: the course page (Sources, Notes, Studio), the assessment dossier, the assignment work view | the existing `App.tsx` shell and the Home direction's sidebar and Courses; new commands for dossier reads, confirm, and running a pack |
| Warm tier per course | `ingestion.ts` | today a changed summary triggers a full read of every course. Reading only the courses whose summary entries changed is the refinement |
| Jev item cards | the existing drain | new job kind `card.resource` beside `enrich.resource`; same `judgments` cache; `lease` gains a kind filter (backend plan O7) |
| Course compile | worker, as a job `compile.course` | the new `ModelRunner` spawns the student's CLI (flags in [design.md](../2026-09-26-sync-and-actions/design.md) §4.2); results land in `course_sessions`, `learning_concepts`, `assessments`, `assessment_scope`, `map_links`, `compile_runs` |
| Jev links | the drain, job `link.assessment` | `map_links` rows with `rung = jev` |
| Confirm scope | renderer → a new `Command` variant → core | the same command path the app uses today |
| Prompt packs (flashcards and others) | worker jobs `pack.<id>`; on demand, a command | `ModelRunner`; results in `learning_artifacts`; cards, items and reviews in the learning tables (T10L) |
| App features | the worker calls `packages/agent-api` handlers **in-process**, with no socket, MCP or CLI | the existing Store; the handlers are extracted from the current MCP tool code |
| Optional course bank (student's own clients) | a read-only reader process; `mcp-server.cjs` and the developer `magic` CLI connect to it over a local socket | the existing MCP tool handlers move into `packages/agent-api`; the MCP server stops opening the database |

**Ordering of a first sign-in:**
1. The profile check passes.
2. Refresh runs manually: courses, syllabus, assignments, modules and pages first, then files.
3. Each saved item queues a card job. Each course with its syllabus and assessments in hand queues `compile.course`.
4. The compile's output, checked by code, becomes the settled scopes and the syllabus brief (D33, D34).
5. The course pages show them with their quotes; a correction by the student is optional and wins.
6. Settling queues the precompute packs for anything due within 14 days.

## 5. What we test, and what each test proves

"Testing" here means extending the repo's own automated suite. `pnpm test` runs `tsx --test tests/*.test.ts`: fourteen files today. They use a temporary database, the recorded Canvas fixture (`canvas-fixture.ts`) and, for MCP, a real SDK stdio client. `pnpm test:desktop` builds and smoke-runs the app headless.

These tests protect the code as it's written. The design itself is settled by the architecture above.

| New test (file) | Proves | The failure it catches |
|---|---|---|
| `tests/passages.test.ts` | passages rebuilt from the fixture's PDF and slide parts carry offsets that slice back to the exact text | an offset off by the `"\n\n"` join, which would make every citation quote wrong |
| `tests/storage-v5.test.ts` | v4 → v5 → v6 keeps every planning and course row; purge leaves **zero** rows in every table | a derived table that survives "Delete local data" |
| `tests/outlook.test.ts` | a recorded Graph delta page files a Canvas notification as `duplicate_of`, a TA's email to its course, and a Handshake email to careers. The stored row has no body text, and keeps `webLink`. A second delta page adds only new messages | a message body stored locally; a professor's email filed nowhere; a full re-download every tick |
| `tests/mapping.test.ts` | on the fixture course, the dossier for an assessment respects the caps (Core ≤8, Also useful ≤6, Practice ≤5). Each item has a reason. A new announcement stating a narrower scope produces a flagged change on a confirmed scope, not a rewrite | an overwhelming dossier; a confirmed scope silently changed |
| `tests/compile.test.ts` | a recorded compile output passes the checks. The same output with one invented quote, one unknown ID and one out-of-term date is rejected, retried once, then escalated | an invented quote reaching the student |
| `tests/packs.test.ts` | the flashcard pack assembles context from fixture passages within its token budget, parses a recorded response, keeps only cards whose quotes verify, and hits the cache on a second run | a pack spending tokens on a cache hit, or keeping an unverified card |
| `tests/runner.test.ts` | each CLI adapter builds its exact argument list: Claude `--tools ""`, `--json-schema`, `--no-session-persistence`, and no `--dangerously-skip-permissions` or `--bare`; Codex `--output-schema`, `-s read-only`, `--ephemeral`. A spawned fake binary records what it received | a flag drift that opens a shell to course text, or that drops the subscription login |
| `tests/agent-api.test.ts` | every verb respects its token cap. The CLI and MCP routes return byte-identical output. A revoked grant is refused on the next call. Every call writes a receipt | an oversized result, or a route that skips the grant check |
| `tests/mcp.test.ts` (extended) | the MCP server works through the reader, and the database path appears nowhere in its connection file or environment | an agent process that can open the database file |
| `tests/mcp.test.ts` (course bank) | with the app closed, `courses`, `assessment` and `materials` answer from the last sync with freshness stamps. A receipt lands in the log and is imported at the next start. The MCP prompt `flashcards` carries the same pack text as the app's pack file. No app feature opens an MCP or CLI connection: asserted by a spy on the socket in the worker tests | an agent reading stale data as current; a receipt lost while the app was closed |
| `tests/refresh.test.ts` (extended) | a summary change in one course reads only that course | a full re-read on every change |

**Only a live run on a real account can show three things.** They're one session with the operator signed in:
1. **The quality of the compile** on real, varied courses: the edits needed at confirmation, per model.
2. **Probe K1:** whether the student's session can read Kaltura captions, and the timestamp link format.
3. **Which models each plan actually serves.**

## 6. Scope posture: hold the complete app, ordered backend first (D19, D23)

[tasks.md](tasks.md) runs four phases in priority order:
1. **Backend finalized, optimized and benchmarked:**
   - the probes; T05 seams
   - schema v5 and v6 with every course, learning and practice table (planning's v4 preserved)
   - passages; every source connector; the Jev client
   - the in-app handler layer (agent-api)
   - the MT1 baseline → O1, O2, O3, O5 and O6 → M1–M5, M8 and M9, each before and after
   - **the head-to-head benchmark against public tools on latency, cost and setup (B6)**
2. **LLM-token features:**
   - the runner, packs and ledger (with O8 stable prefixes and warm sessions measured); onboarding
   - the course pass and mapping
   - the items, flashcards, study guide and practice exam packs; the assessment quiz builder
   - chat; rescope and digest; the audio overview
   - measurement: grounded Q&A (MT3), item quality (MT4), cost ablation (MT6)
3. **The study system:**
   - the knowledge model and FSRS
   - Learn, Write, Test, stars and own cards
   - understanding levels, the mastery bar and the prep list; topic selection
   - error patterns and the coverage map
   - the notebook and Practice screens
   - offline validation (P18–P21; supersedes MT5)
4. **Secondary and close:**
   - the course bank MCP and CLI, the relay, and the open framework
   - licence activation and signed installers
   - legal
   - acceptance

## 7. Planned Codex moments

- **verify:** one cross-family review of the course-pass pack (T21) and the items pack (T45): their schemas and checks, before the acceptance run. They decide what reaches the student.
- **No others.**

## 8. Legal phase, last (operator decision, 2026-09-26)

The Terms of Service, Privacy Policy and in-app data notice are written at the end of the build.
1. Focused legal research covers:
   - consumer software terms, lifetime-deal and fair-use clauses
   - the student-data framing: FERPA, and UW rules for NetID, Canvas and recordings
   - each provider's terms for the routes we use
   - the Jev vendor agreement
2. Drafting from `docs/ai-and-privacy.md`, with a destination table per AI client and for Jev (spec G2).
3. An expert-application pass that checks each clause against the built data flows and the receipts.

The notice is built as an app feature: one consent per destination, shown before the first send.

## 9. Open, for the operator

0a. **Sign off the AI boundary (spec §2, gate T02)** before phase 2 starts.
0. **Pushing and the team's release gate (G0):** work starts now from the local base. Nothing is pushed until the team's release cleanup is done. Then a fresh branch from the rewritten `main` receives our non-merge commits by cherry-pick, and only that branch is pushed.

2. **The word "mastery" (D21):** `docs/product.md` rules out "invented mastery". Our bar is evidence-defined, but the team should agree on the wording.
1. **Schema v5/v6 and the agent-API move:** both change shared packages. Open them as PRs to `main` as soon as G0 clears, or hold them until the team reviews the plan together?
