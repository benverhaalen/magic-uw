# Agent runtime: chat and agents on the student's own AI CLI

**Status: Decision (ours).** It differs from recorded team decisions; see [where we differ](where-we-differ.md). Changes to shared packages go to `main` as PRs, reviewed by the team. Checked 2026-09-26 against provider docs and terms, local probes (Claude Code 2.1.283, Codex CLI 0.156.1), and the Gemini CLI repository. Labels: **sourced** · **probed** (run once locally) · **inferred**.

## The idea
The student uses a **paid AI provider they already have**:
- Claude Code (Claude Pro or higher)
- Codex (a paid ChatGPT plan)
- Gemini CLI with a paid API key
- an OpenRouter API key, with Claude Code pointed at OpenRouter

The app finds the installed CLI, **reuses its existing sign-in** by running the CLI itself, gives it the app's own isolated configuration, and drives it headlessly. It never reads, stores or forwards the student's credentials. The CLI does its thinking through our own MCP server of course tools.

**Disclosure without friction** (our decision; it differs from the engineering principle of a blocking preview before every hosted request):
- **Consent once per provider,** at connection: who receives requests (the student's own provider), which data categories, and a link to that provider's data settings.
- **Every request after that is visible but not blocking:** a context chip lists the sources used, and an egress receipt goes to the AI-use log. The student can open the exact payload at any time.
- **A blocking preview appears only when a new sensitive category would leave for the first time:** the student's own drafts or answers, messages, or anything with classmates' content. It also appears when the student turns on "always preview".
- **Why:** a click on every message to a provider the student chose and pays for adds friction with no new information. Receipts and chips keep the boundary inspectable.

## Routes
| Route | What the student needs | How the app runs it | Who pays for Jev |
|---|---|---|---|
| **Claude** | Claude Pro, Max, Team or Enterprise. "The free claude.ai plan does not include Claude Code access" (code.claude.com/docs/en/setup, sourced) | `claude -p` headless, existing login reused | the app's gateway |
| **Codex** | a paid ChatGPT plan | `codex exec`, existing login reused | the app's gateway |
| **Gemini** | a **paid** Gemini API key. On unpaid keys, Google may use content to improve its products, and human reviewers may read it (ai.google.dev/gemini-api/terms, sourced) | Gemini CLI with an isolated `GEMINI_CLI_HOME` and `GEMINI_API_KEY`, stored in the OS keychain | the app's gateway |
| **OpenRouter** | the student's own OpenRouter API key, in the OS keychain | **Claude Code pointed at OpenRouter:** `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_API_KEY=""`. Pin Anthropic as the top provider; OpenRouter says the setup "is only guaranteed to work with the Anthropic first-party provider" (openrouter.ai docs, sourced) | **the student's own key,** through OpenRouter's Jev route |

**Candidate router:** OpenRouter lists `typesafe/jev-router` (added 2026-09-25): "picks the best model and reasoning effort for each request". Evaluate it against a fixed model before using it by default ([benchmarking](benchmarking.md)).

## Detecting a client and its sign-in
1. **Find the binary.**
   - Check PATH plus the official install locations, because an app launched from the macOS Dock doesn't inherit the shell PATH (inferred). Claude Code's native launcher is `~/.local/bin/claude`; Homebrew, WinGet and npm installs also exist; Codex installs via script, npm or Homebrew; Gemini CLI via npm, Homebrew or MacPorts (install docs, sourced).
   - Then run `--version`.
2. **Read the sign-in state from the CLI itself.**

| Client | Command | Result |
|---|---|---|
| Claude | `claude auth status --json` (probed) | returns `loggedIn`, `authMethod`, `subscriptionType`. The app keeps only these three fields and discards email and organization fields |
| Codex | `codex login status` (probed) | prints e.g. "Logged in using ChatGPT" |
| Gemini | no status command exists (sourced) | the state is "a key is present in the keychain and a one-token test call succeeds" |

3. **Not installed:** a styled console panel shows the provider's **official** install command. It runs only after the student clicks Install.
4. **Not signed in:** the same panel runs the provider's **own** login:

| Client | Login flow |
|---|---|
| Claude | `claude auth login` opens Anthropic's own sign-in page in the browser. The panel then polls `auth status`. This follows "sign-in… must complete through Anthropic's own flow" (sourced) |
| Codex | `codex login`, or `codex login --device-auth` (a code and a URL, with no terminal needed) |
| Gemini | the student pastes a paid API key. Google-account OAuth isn't offered: Gemini CLI's terms call third-party use of its OAuth "a violation of applicable terms" and "grounds for suspension or termination of your account" (sourced) |

**To verify before relying on it:** whether `claude auth login` works when spawned without a terminal (TTY). If it doesn't, use a pseudo-terminal module or open the OS terminal.

## Isolation: the app's configuration, not the student's
| Client | How | Result |
|---|---|---|
| **Claude** | `--setting-sources project,local --strict-mcp-config --mcp-config <our server>` plus `--settings <ours>` and `--append-system-prompt <course policy>` | **probed:** the existing login was reused, and no user CLAUDE.md, skills or MCP servers loaded. Not `--bare`, which accepts only API-key auth |
| **Codex** | `codex exec --ignore-user-config --ignore-rules --ephemeral -s read-only` plus `-c developer_instructions="<My Magic UW role; user AGENTS.md is out of scope>"` plus our MCP server via `-c mcp_servers.<name>...` | **probed:** `--ignore-user-config` **still loads the global `~/.codex/AGENTS.md`**, and there's no documented switch to stop it. The developer instructions override it in behaviour: in a probe the model declined to follow or quote it. The file's text still enters the context. Full isolation needs a separate `CODEX_HOME`, which needs its own sign-in; copying credential files is not allowed |
| **Gemini** | an isolated `GEMINI_CLI_HOME` (it relocates `~/.gemini`; documented in the repo's enterprise guide and read in `packages/cli`) plus a system settings file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `--extensions` limited, `--approval-mode default` | sourced; not yet probed |

## Headless runtime (decided 2026-09-26; see the [course backend spec](../plans/2026-09-26-course-backend/spec.md) Part E)
**App features run as one-call prompt packs with tools off.** Code assembles the context, the student's CLI returns schema-checked JSON, and code checks every quote, ID and date. Chat uses retrieval the app runs itself: the model may ask for up to 3 typed lookups through a `need` field, for at most 2 rounds. It's never given tools, MCP or a shell.

| Client (version seen 2026-09-26) | Call | Structured output |
|---|---|---|
| Claude Code 2.1.283 | `claude -p --output-format json --json-schema <schema> --tools "" --strict-mcp-config --setting-sources project,local --no-session-persistence`, with the prompt on stdin | `--json-schema` → `structured_output` |
| Codex CLI 0.156.1 | `codex exec - --json --output-schema <file> --ephemeral -s read-only --ignore-user-config` | `--output-schema` |
| Gemini CLI 0.61.0 (npm; not installed on the test machine) | `gemini -p … -o json`, with the system prompt through `GEMINI_SYSTEM_MD` | no schema flag found: zod validation and one retry |

**Checked facts (vendor docs and `--help`, 2026-09-26):**
- **`--dangerously-skip-permissions`** equals `bypassPermissions`: the current `claude --help` text reads "Recommended only for sandboxes with no internet access" (corrected 2026-09-26). Never used; `--tools ""` needs no approval anyway.
- **Codex:** `--dangerously-bypass-approvals-and-sandbox` is "EXTREMELY DANGEROUS"; `--full-auto` is deprecated.
- **`--bare`:** "bare mode doesn't use your subscription login", and it "will become the default for `-p` in a future release". A CI probe checks each Claude Code update.
- **Claude Agent SDK:** "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." That's why we spawn the student's own CLI rather than embedding the SDK.
- **`@openai/codex-sdk`** wraps the CLI and reuses `codex login`. Gemini CLI has ACP (`--acp`, corrected 2026-09-26) for warm sessions.
- **Agent Skills (`SKILL.md`)** are read natively by all three clients. The loading routes:
  - Claude plugins: `--plugin-dir`
  - Codex: `.agents/skills`
  - Gemini: `gemini-extension.json` extensions
- **Process start on the team laptop** (no model call): `claude --version` 0.60 s, `codex --version` 2.41 s. Warm sessions are measure-first:
  - Claude `--input-format stream-json`
  - Codex app-server
  - Gemini ACP
- **Prompt caching:**
  - Claude Code documents cache reuse within a resumed session.
  - Codex reports `cached_input_tokens`.
  - Gemini CLI caching is "not available for OAuth users".

## What the student's own agent can touch (optional course bank)
- **Only if the student registers the MCP course bank** in their own client. It's read-only, capped, grant-checked and receipted, and it **never drives app features.**
- **The app's features never go through MCP.** See the spec, Part F.

## Terms, as they stand
- **Anthropic (sourced):**
  - The binary is unmodified.
  - "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf." The app's one-time price covers Jev and the service, **never model usage.**
  - Running Claude Code in a product requires the team to accept the Commercial Terms.
  - "Claude Code" can't be part of the product's name.
  - Whether OpenRouter counts as a "3P inference provider credential" isn't stated (inferred open).
- **OpenAI (sourced):** Codex is included in ChatGPT plans. There's no documented arrangement for third-party apps (openai/codex#36886 is open and unanswered), so disclose this to students.
- **Google (sourced):** API-key auth only; no Gemini CLI OAuth.

## Disclosures in onboarding
- "Uses your own provider plan or key. We never see your sign-in."
- The provider that receives each request, and the exact context, shown before sending.
- Codex: "not formally documented for third-party apps."
- Gemini: paid keys only.
