# Sync and one-click actions: no model on the hot path

> **Superseded in part by the [course backend spec](../2026-09-26-course-backend/spec.md) (2026-09-26 late).**
> - **Outlook:** mail is now collected through Microsoft Graph (`Mail.ReadBasic`), not only a published ICS calendar (spec A3).
> - **Exam coverage:** now one quick model pass plus Jev, not rules alone (spec C3).
> - **Tiered sync:** it largely exists already in the refresh coordinator (spec A4).
> - **Codex tier:** the pass runs on GPT-6 Sol, not Luna.
>
> Still current: the sign-in facts (§2), the one-call pipeline and the reasons for rejecting `--dangerously-skip-permissions` and `--bare` (§4), and the storage stance (§5).

**Status: Design.** Written 2026-09-26 against the existing backend at `27782e9`.
**Labels:**
- **decided:** ours, with the evidence given.
- **measure-first:** adopted only if it meets numbers fixed before the run.
- **sourced / inferred:** as in the [agent data-layer proposal](../2026-09-26-agent-data-layer/proposal.md).

**Related:**
- [agent data-layer proposal](../2026-09-26-agent-data-layer/proposal.md)
- [agent runtime](../../notes/agent-runtime.md)
- [backend optimization plan](../2026-09-26-backend-optimization/plan.md)
- [notes targets](../../notes/notes-targets.md)

## 1. The answer in one table

| Path | Model needed? | What runs |
|---|---|---|
| Sign-in | none | the existing embedded UW sign-in window; the student does NetID and Duo |
| Sync (Canvas, calendars, Course Search & Enroll) | **none** | code: REST/GraphQL/ICS/JSON fetches, parsers, extractors |
| Categorising (course, module, type, dates, week) | **none** | code, from structure Canvas already provides |
| Exam coverage ("what's on Midterm 2") | none where the course states the scope or dates its material | a ladder of signals chosen per course, then Jev for leftovers, then the student confirms in one click ([accuracy.md](accuracy.md)) |
| Embeddings | a small local model, no LLM | measure-first (agent data-layer proposal, MF4–MF6) |
| Flashcards, quizzes, study guides | the student's own AI CLI, **one call** | the app assembles the passages in code; the CLI returns schema-checked JSON; code checks the quotes |
| Open-ended chat about a course | the student's AI CLI with our tools | the thin MCP server or the `magic` CLI (agent data-layer proposal §3.3) |

**The rule: code does everything that has one right answer.** Jev makes small typed judgments. The student's AI only writes and reasons.

## 2. Sign-in and session

- **Keep the current flow. decided** A window opens on canvas.wisc.edu. The student signs in with NetID, password and Duo, and the app keeps the session in its own persistent partition (`persist:uw`). It asks again only when a sync finds the session expired.
- **The app never stores the NetID password. decided** UW's NetID standard (sourced, kb.wisc.edu/itpolicy/page.php?id=59262):
  > "Computer systems and applications must not store the password that is associated with a NetID. Only the institutionally managed access control services may store that password. Storing one's personal NetID and NetID password in a password management application is permitted."

  Students can autofill from their own password manager inside the window.
- **Duo "Remember me" at UW is 12 hours.** It applies "if you sign in using the same browser" (sourced, it.wisc.edu Duo FAQ for students). The app's partition counts as one browser, so a returning student sees Duo at most about twice a day, and only when a sync needs a fresh session.
- **Never read the machine's browser cookies. decided** The existing `secrets.ts` already forbids it.
- **Canvas access tokens are an optional power-user route.** Since 2025-11-14, UW students can no longer create tokens themselves. They request one through a form, and it lasts at most 90 days (sourced, kb.wisc.edu/luwmad/156712).
- **Duo is never automated. decided** Only the student approves a Duo prompt.

## 3. Sync: fast, cheap, no model

### 3.1 Sources

| Source | Route | Auth after first capture | Label |
|---|---|---|---|
| Canvas content | REST today (the existing connector); GraphQL to batch per-course reads | the session | REST built; GraphQL measure-first (S2) |
| Canvas calendar feed | ICS URL captured once while signed in | **none** (the URL is a secret) | decided; the existing calendar parser exists |
| Outlook calendar | the student publishes an ICS link (UW KB "Publish a calendar") | none | decided for launch. Graph is later, because UW's consent policy isn't found. EWS is being retired in Exchange Online from 2026-10-01: don't build on it |
| Course Search & Enroll | the site's own JSON endpoints (`/api/search/v1/...`), called with plain fetch and cached per term | none observed | measure-first. Unofficial and undocumented, so it could change |
| GitLab, external sites | the existing connectors | session or token | built |

### 3.2 Tiers: what makes it feel instant

The UI always reads the local database, so it never waits on the network. Sync runs behind it in three tiers:

| Tier | Trigger | Work | Budget |
|---|---|---|---|
| **Hot** | every 5 min, and on app focus | ICS feeds (no auth); one Canvas change probe (`activity_stream/summary` or `todo`) | ≤2 requests; ≤1 s |
| **Warm** | the hot tier sees a change, or every 30 min | per-course assignments, modules and announcements for **changed courses only** | ≤1 request per changed course with GraphQL (S2) |
| **Cold** | idle, on power | files, page bodies and extraction, only when `updated_at` or the content hash changed (backend plan O5/O6) | off the hot path |

- **Signed-out behaviour:** the hot tier still works on ICS, so deadlines stay live. Content waits for the next sign-in, then only what changed syncs.
- **Throttling:** Canvas reports `X-Request-Cost` and `X-Rate-Limit-Remaining` on every request, and charges a pre-flight penalty on parallel requests (sourced, canvas-lms `doc/api/throttling.md`). The existing HTTP client already reads these. Concurrency adapts to the remaining quota (backend plan O11).

### 3.3 Categorising with no model

- **The structure already says** course, module, item type, due date, assignment group, points and file type. These are stored as fields, not inferred. **decided**
- **Exam coverage, by a ladder of signals per course. decided; accuracy measure-first**
  - The rungs, strongest first:
    1. the professor's stated scope
    2. a dated schedule table
    3. dated artifacts, including recording dates
    4. order and names
    5. Jev for the leftovers
    6. the student's one-click confirmation
  - Layouts vary too much between professors for one date rule. Rungs, metrics and adopt rules are in [accuracy.md](accuracy.md).
  - A confirmed set is truth, and later changes flag it for review.
- **Not used:** zero-shot embedding classification. A small model like MiniLM scores an average F1 of about 0.37 on a zero-shot benchmark (sourced, arXiv 2603.11991). That's too weak to decide what's on an exam.

### 3.4 Browser automation: only where no API exists

- **First choice:** capture the site's own JSON calls once, then call them with plain fetch in the same signed-in session. Course Search & Enroll already works this way. It costs no tokens.
- **AI browser agents are not in background sync.** That covers Stagehand, browser-use and Skyvern. Their "record once, replay" caching exists (sourced: Stagehand caching, browser-use workflow-use), but replay still breaks when a page changes, and Duo can't be automated anyway.
- **An AI-driven capture stays a developer tool** for adding a new source, never a runtime dependency. **decided**

## 4. One-click actions: one call, not an agent loop

**The problem with a tool loop for a button:** every tool call is another model turn. Anthropic's guidance: "For many applications, optimizing single LLM calls with retrieval and in-context examples is usually enough" (sourced, "Building effective agents").

For a button, the app already knows exactly what's needed. The exam set is a SQL query, not a search, so the model gets everything in one prompt.

### 4.1 The pipeline (for example, "Flashcards for CS 400 Midterm 2")

1. **Select:** SQL over the confirmed exam set, returning passages with IDs and offsets, capped by token budget and ordered by module. No model.
2. **Cache check:** the key is (the set of passage `text_hash` values, the prompt version, the card count). A hit returns instantly.
3. **Generate:** one non-interactive call to the student's CLI, with the passages on stdin and a JSON Schema for the cards. Each card carries `pid` and a verbatim quote span.
4. **Check in code:**
   - schema validation (zod)
   - every quote found verbatim in its passage
   - duplicates removed
   - item-flaw rules (learning-features plan)

   A card that fails is dropped or regenerated once.
5. **Optional Jev check:** a per-card answer-key check, "does this passage support this answer: yes or no". **measure-first.**
6. **Store:** save the cards, then schedule them with ts-fsrs.

**Big sets:** split by module and run 2–3 calls at once (map), then dedupe in code (reduce). Each call stays small, so the first cards appear early.

**Precompute:** when the ICS feed shows an exam within 10 days, the app generates when idle, so the button is instant. The student's AI usage is spent only with their consent (agent runtime: consent once per provider).

### 4.2 The exact calls

**Flags are confirmed by probe before code, per client.** Versions seen 2026-09-26: Claude Code 2.1.283, Codex CLI 0.156.1, Gemini CLI 0.61.0 (npm).

| Client | Call (prompt on stdin, in a working directory the app owns) | Structured output |
|---|---|---|
| Claude Code | `claude -p --output-format json --json-schema <schema> --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources project,local --no-session-persistence --model <pinned>` | `--json-schema` (sourced, `claude --help`, headless docs) |
| Codex | `codex exec - --json --output-schema <file> --ephemeral -s read-only --ignore-user-config -c developer_instructions=<ours>` | `--output-schema` (sourced, `codex exec --help`) |
| Gemini CLI | `gemini -p <prompt> -o json`, with `GEMINI_SYSTEM_MD` pointing to our prompt file | **no schema flag found.** Validate with zod and retry once |

**Why not `--dangerously-skip-permissions`. decided**
- The docs describe it as equivalent to `bypassPermissions` and say: "Only use this mode in isolated environments like containers or VMs where Claude Code can't cause damage" (sourced, permissions docs).
- Course text is untrusted input, and this flag would give it a shell and write access as the student.
- It's also unnecessary. With `--tools ""` there is nothing to approve, so the call never prompts.
- Codex's `--dangerously-bypass-approvals-and-sandbox` is flagged "EXTREMELY DANGEROUS" in its own help, for the same reason.

**Why not `--bare`:**
- It starts faster, but "bare mode doesn't use your subscription login" (sourced, headless docs).
- It fits only the OpenRouter-key route.
- The docs also say `--bare` "will become the default for `-p` in a future release". **Risk:** a probe in CI checks on every Claude Code update that our flags still reuse the login.

**There is no `--magic-uw` flag. The same effect, per client:**
- **One skills bundle:** Claude Code, Codex and Gemini CLI all read `SKILL.md` natively today (sourced, each client's docs).
- **Loading it:**
  - Claude Code: a plugin loaded with `--plugin-dir`.
  - Codex: skills in `.agents/skills` within the app-owned working directory.
  - Gemini CLI: an extension (`gemini-extension.json`).
- **Scope:** the bundle is for chat and interactive sessions. One-click actions don't need it, because the prompt carries everything.

### 4.3 Latency: what we know and what we measure

- **Floor on the team laptop** (2026-09-26, no model call): `claude --version` 0.60 s, `codex --version` 2.41 s. **inferred:** process start alone is noticeable, so warm processes are worth testing.
- **Warm options:**
  - Claude Code: `--input-format stream-json` as a long-lived session
  - Codex: `app-server`
  - Gemini CLI: ACP mode

  **measure-first (S5):** adopted if the median time to the first card falls ≥30% with no loss of isolation.
- **Prompt caching:**
  - **Claude:** cache reads bill at 0.1× the input price (sourced, Anthropic prompt-caching docs). Claude Code documents cache reuse within a resumed session, not across unrelated `-p` calls. A warm session is also what makes our fixed instructions cache.
  - **Gemini CLI:** caches for API-key users only, "not available for OAuth users" (sourced, gemini-cli token-caching docs).

## 5. Storage for these paths: database, vectors or folders

- **The database is the source of truth. decided** One-click actions query it directly, and no retrieval model is involved.
- **Search for chat:** FTS5 passages first. Vectors only if they win on our gold set (agent data-layer proposal MF4). The evidence is mixed:
  - The Claude Code team dropped a vector index because "agentic search generally works better", citing staleness, security and reliability (sourced, Boris Cherny on X).
  - Cursor measured that semantic search adds 0.3% to agent code retention, and 2.6% on large codebases (sourced, cursor.com/blog/semsearch, a vendor).
  - Neither is about course documents, so our benchmark decides.
- **A folder mirror is an output, not a store. decided**
  - The notes export already writes a course folder tree (notes targets). The same generator can write a read-only Markdown mirror, one file per module with frontmatter IDs.
  - It's for interactive agent sessions that prefer to grep files.
  - It holds only included courses, and it's rebuilt from the database, never read back.

## 6. Measure-first items

| # | Item | Adopt if |
|---|---|---|
| S1 | Tiered sync vs today's refresh | median sync requests per hour −70% and new-deadline latency ≤5 min |
| S2 | Canvas GraphQL per-course reads | total `X-Request-Cost` per warm sync −40% at identical stored rows |
| S3 | ETag / `If-None-Match` on Canvas REST | any endpoint returns 304 on an unchanged repeat (not confirmed in Instructure's docs) |
| S4 | Rungs 1–4 for exam coverage | precision ≥95% overall and ≥85% in every layout ([accuracy.md](accuracy.md) §4.3) |
| S5 | Warm CLI sessions | median time to first card −30% |
| S6 | One call vs a tool loop for flashcards | ≥40% fewer input tokens and lower median wall time at equal card validity |
| S7 | Jev answer-key check | catches ≥50% of seeded wrong keys with ≤5% false drops |

## 7. Sources

All checked 2026-09-26.
- UW NetID Appropriate Use Standards: https://kb.wisc.edu/itpolicy/page.php?id=59262
- UW Duo FAQ for students: https://it.wisc.edu/learn/getting-started-multi-factor-authentication-students/mfa-duo-faqs-students/
- UW Canvas student access tokens: https://kb.wisc.edu/luwmad/156712
- Canvas throttling: https://github.com/instructure/canvas-lms/blob/master/doc/api/throttling.md
- Canvas GraphQL: https://github.com/instructure/canvas-lms/blob/master/doc/api/graphql.md
- Course Search & Enroll endpoints as observed by a student project: https://github.com/StevenHuang0314/uw-schedule-planner
- Claude Code headless docs (bare mode, `--json-schema`): https://code.claude.com/docs/en/headless.md
- Claude Code permissions docs: https://code.claude.com/docs/en/permissions.md
- Claude Agent SDK overview (third-party login rule): https://code.claude.com/docs/en/agent-sdk/overview.md
- Codex non-interactive mode and skills: https://developers.openai.com/codex/noninteractive, https://developers.openai.com/codex/skills
- Gemini CLI reference, headless, skills and token caching: https://github.com/google-gemini/gemini-cli/tree/main/docs/cli
- Anthropic, "Building effective agents": https://www.anthropic.com/engineering/building-effective-agents
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Cursor semantic search: https://cursor.com/blog/semsearch
- Zero-shot classification benchmark (BTZSC): https://arxiv.org/abs/2603.11991
- Stagehand caching: https://www.browserbase.com/blog/stagehand-caching · browser-use workflow-use: https://github.com/Zalos-io/workflow-use
- EWS retirement in Exchange Online: https://techcommunity.microsoft.com/blog/exchange/retirement-of-exchange-web-services-in-exchange-online/3924440
