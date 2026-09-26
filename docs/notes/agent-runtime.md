# Agent runtime: chat and agents on the student's own CLI

**Status: Proposal.** The facts were checked 2026-09-26 against docs, the CLIs' `--help`, and the providers' terms pages (quotes below). Local versions: Claude Code 2.1.283 and Codex CLI 0.156.1. Gemini CLI wasn't installed; its facts come from the repo docs.

## The idea
The student picks a client: **Claude Code, Codex, Gemini CLI, or Local.** The app drives that **unmodified CLI** headlessly. The student signs in **through the CLI's own login flow**, once, and the app never sees or stores their credentials. Usage counts against the student's own plan, and the UI never shows the routing.

## What the providers say (sourced)
| Client | What the terms or docs say | What it means for us |
|---|---|---|
| **Claude Code** | "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — **sign-in to a Claude account must complete through Anthropic's own flow**." "Each end user must authenticate with their own Anthropic API key, **Claude subscription plan credentials**, or 3P inference provider credential." Running Claude Code in a product "requires agreeing to our Commercial Terms of Service"; "the Claude Code binary must not be modified"; you "can't use the Claude Code or Anthropic names… as part of your own product… name" (code.claude.com/docs/en/legal-and-compliance) | ✅ This fits: the unmodified binary, the student's own sign-in through Anthropic's flow, the app never touching tokens. **The team accepts the Commercial Terms once.** We may say "runs Claude Code", but it can't be in our product's name. |
| **Codex CLI** | "`codex exec` reuses saved CLI authentication by default"; sign in with ChatGPT or an API key (developers.openai.com/codex/auth, /noninteractive). **There's no documented contract for third-party apps driving it with a ChatGPT sign-in;** openai/codex#36886 asks and is unanswered | ⚠️ It works, but it isn't formally sanctioned. Disclose this, and keep a fallback. |
| **Gemini CLI** | "Directly accessing the services powering Gemini CLI… using third-party software… (for example, using OpenClaw with Gemini CLI OAuth) is a violation… **grounds for suspension or termination of your account**." The headless guidance recommends a Gemini API key or Vertex (docs/resources/tos-privacy.md, docs/get-started/authentication.mdx) | ⚠️ Driving the unmodified binary isn't the same as reusing its OAuth "directly", but the account risk is explicit. **Default Gemini to its API key path** (it has a free tier) and say so, or leave Gemini out of the headless runtime. |
| **Local** | no provider terms | ✅ always available; the fallback |

## Setup: "choose your client"
1. **Pick a client.**
2. **The app, as plain code:**
   - detects the CLI and its version
   - if it's missing, shows the official install command for the OS
   - creates an **isolated workspace**, `userData/agents/<client>/`, and writes its config: our course-data MCP server, the tool allowlist, the settings
3. **Sign in, in the app's built-in terminal:**
   - The CLI runs with its home set to the isolated folder, and **the student completes the provider's own sign-in once**.
   - A new home means a new login:
     - Claude: "a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" (code.claude.com/docs/en/authentication)
     - Codex: `CODEX_HOME` holds `auth.json` or the keyring entry, and `codex login --device-auth` exists
     - Gemini: `GEMINI_CLI_HOME` "creates a `.gemini` folder inside the specified path"
4. **A test call → "Connected ✓".**
5. **Optional "fix my setup" helper:** a generated, human-readable prompt the student can paste into their own CLI session when something breaks, e.g. a PATH problem or an old version. It's a repair tool, not the main path. The main path is code, so it's the same every time.

**Never copy the global credential files into the isolated folder.** That's the "intermediate credentials" the Claude terms prohibit.

**A lighter option (to check before relying on it): reuse the student's existing login and isolate the config with flags only.**
- Claude: `--setting-sources project,local` + `--settings` + `--strict-mcp-config`.
- Codex: `--ignore-user-config` ("auth still uses `CODEX_HOME`") + `-c` overrides.
- This saves one sign-in, but the isolation is weaker. Whether the user's global memory file still loads in Claude is **not verified**. So the isolated home is the default.

## Runtime: headless and invisible
| Client | How the app drives it (sourced flags) |
|---|---|
| **Claude Code** | **one long-lived process per session:** `claude -p --input-format stream-json --output-format stream-json --session-id <uuid>`, with `--settings <file>` (permissions), `--setting-sources project,local`, `--mcp-config <file> --strict-mcp-config`, `--allowedTools` / `--disallowedTools`, `--permission-prompts none` (auto-deny anything that would prompt), `--append-system-prompt <course policy + integrity rules>`, `--model`. **Not `--bare`:** it reads only API keys, never the subscription login. |
| **Codex** | one `codex exec --json -C <workspace> -s read-only --skip-git-repo-check` per turn, continued with `codex exec resume <SESSION_ID>`; `--output-schema <file>` for typed results; MCP servers in the isolated `config.toml` (`[mcp_servers.<name>]`) |
| **Gemini CLI** | `gemini -p "<prompt>" --output-format stream-json --approval-mode default` with `GEMINI_CLI_HOME` set to the isolated folder; MCP in its `settings.json` `mcpServers` (API-key auth by default, per the terms above) |
| **Local** | the local model runtime through the same adapter interface |

**One adapter interface for all four:** `start(session) · send(message) · events() · stop()`. Each adapter maps its CLI's event stream (Claude's stream-json; Codex's `--json` JSONL; Gemini's `init / message / tool_use / tool_result / result` events) to one internal event type. The UI renders those events as answer cards, citations and agent steps.

## What the agent can touch
- **Our course-data MCP server is the only way into the student's courses.** Its tools are read-only; each passes the policy engine and the integrity gate (`integrity-roles.md`, `jev-usage.md`).
- **The allowlist:** our MCP tools, plus reading inside the isolated workspace. **No shell, no writes outside a scratch folder, no network tools** unless a feature needs them. Anything else is auto-denied (`--permission-prompts none` for Claude, `-s read-only` for Codex, approval mode `default` for Gemini).
- **The CS toolkit's terminal** (`major-toolkits.md`) is the student's own terminal, not the agent's. Code-running agent modes, if any, run inside a sandboxed workspace and follow the course policy.
- **Every session is logged** into the AI-use log (client, model, prompts, tools used), for the AI Usage Statement.

## Disclosures in onboarding
- "Uses your Claude / ChatGPT / Gemini plan's usage limits. We never see your sign-in."
- For each client, what it receives: the course excerpts and prompts our MCP tools return, and the student's messages.
- Provider data settings: link to each provider's official controls.
- Codex: "not formally documented for third-party apps". Gemini: "we use a Gemini API key; signing in with a Google account from third-party tools can breach Google's terms".
- **Local always works** without any provider.
