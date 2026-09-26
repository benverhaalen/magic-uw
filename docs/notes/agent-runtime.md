# Agent runtime: chat and agents on the student's own AI CLI

**Status: Proposal (operator direction, pending Ben).** Checked 2026-09-26 against provider docs and terms, local probes (Claude Code 2.1.283, Codex CLI 0.156.1), and the Gemini CLI repository. Labels: **sourced** · **probed** (run once locally) · **inferred**.

## The idea
The student uses a **paid AI provider they already have**:
- Claude Code (Claude Pro or higher)
- Codex (a paid ChatGPT plan)
- Gemini CLI with a paid API key
- an OpenRouter API key, with Claude Code pointed at OpenRouter

The app finds the installed CLI, **reuses its existing sign-in** by running the CLI itself, gives it the app's own isolated configuration, and drives it headlessly. It never reads, stores or forwards the student's credentials. The CLI does its thinking through our own MCP server of course tools.

**Visible boundary** (fixing an earlier draft that said routing is hidden): the mechanics of the CLI process are hidden, but **the recipient is not.** Before any request leaves the device, the student sees which provider receives it and the exact context selected, the same preview pattern the app already uses ([AGENTS.md](../../AGENTS.md); [implementation status](../implementation-status.md)). Every request writes an egress receipt.

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
| **Codex** | `codex exec --ignore-user-config --ignore-rules --ephemeral -s read-only` plus `-c developer_instructions="<Magic Canvas role; user AGENTS.md is out of scope>"` plus our MCP server via `-c mcp_servers.<name>...` | **probed:** `--ignore-user-config` **still loads the global `~/.codex/AGENTS.md`**, and there's no documented switch to stop it. The developer instructions override it in behaviour: in a probe the model declined to follow or quote it. The file's text still enters the context. Full isolation needs a separate `CODEX_HOME`, which needs its own sign-in; copying credential files is not allowed |
| **Gemini** | an isolated `GEMINI_CLI_HOME` (it relocates `~/.gemini`; documented in the repo's enterprise guide and read in `packages/cli`) plus a system settings file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `--extensions` limited, `--approval-mode default` | sourced; not yet probed |

## Headless runtime
| Client | Invocation |
|---|---|
| Claude | one long-lived `claude -p --input-format stream-json --output-format stream-json` per session, with `--allowedTools`/`--disallowedTools` and `--permission-prompts none` |
| Codex | `codex exec --json` per turn, continued with `codex exec resume <id>`; `--output-schema` for typed results |
| Gemini | `gemini -p … --output-format stream-json` |

**One adapter interface:** `start · send · events · stop`. It maps each stream to one internal event type.

## What the agent can touch
- **Only our MCP server,** with coarse, read-only tools backed by code and Jev: course outline, passage search with offsets, artifact builders, practice, the notes tree, deadlines, policy. There's no shell and no network tools, and nothing writes to school systems. Every tool passes the course policy and integrity gates ([integrity roles](integrity-roles.md)).
- **Every session is logged** to the student's AI-use log.

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
