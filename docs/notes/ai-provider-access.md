# Using the student's own AI account: what provider terms allow

**Status: Verified findings, with an open implication for the decided sign-in experience.** Checked 2026-09-25/26. Each item cites its source.

## Findings
| Provider | Finding | Source |
|---|---|---|
| **Anthropic (Claude)** | "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." Also: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens." | code.claude.com/docs/en/legal-and-compliance (page bytes read); the same rule appears on code.claude.com/docs/en/agent-sdk/overview |
| **OpenAI (ChatGPT)** | "Sign in with ChatGPT" is for OpenAI's own clients (Codex). A third-party app has **no documented, supported arrangement** for using a ChatGPT subscription against the API. | developers.openai.com/codex/auth; github.com/openai/codex/issues/36886 |
| **Google (Gemini)** | No custom-connector (MCP) support was found for the consumer Gemini app; Gemini CLI supports MCP. Whether a third-party app may use a student's Gemini sign-in was **not verified**. | github.com/google-gemini/gemini-cli docs; open |
| **Gemini API free tier** | The pricing table lists free-tier data as "used to improve our products: Yes". | ai.google.dev/gemini-api/docs/pricing |

## What *is* supported: bringing course context into the student's own AI
| Route | What works | Source |
|---|---|---|
| **Claude custom connectors (remote MCP)** | "available on… Free, Pro, Max, Team, and Enterprise plans. Free users are limited to one custom connector." OAuth; Streamable HTTP; reached **from Anthropic's cloud**, so a laptop-only server needs a public endpoint | claude.com/docs/connectors/custom/remote-mcp; support.claude.com/en/articles/11175166 |
| **Claude Desktop extensions** (`.mcpb`, local stdio) | one-click install, runs on the laptop, no OAuth | anthropic.com/engineering/desktop-extensions; github.com/modelcontextprotocol/mcpb |
| **ChatGPT developer mode** | Plus/Pro: MCP connectors with read/fetch permissions; Business/Enterprise/Edu: full MCP (beta) | help.openai.com/en/articles/12584461 |
| **MCP Apps (interactive widgets in chat)** | a ratified extension; `ui://` resources rendered in Claude and ChatGPT | github.com/modelcontextprotocol/ext-apps; developers.openai.com/apps-sdk/mcp-apps-in-chatgpt |

## Implication (open for the team)
The decided experience says students use their own ChatGPT, Claude or Gemini account with no API keys. The terms support that **in one direction**:
- **The student's own AI app gets their course context.** A Claude Desktop extension or custom connector, or ChatGPT developer mode, lets the student keep their normal account and plan.
- **In-app chat through their subscription** is prohibited for Claude and unsupported for ChatGPT. For in-app hosted answers, the options are:
  - API access (a key the student supplies, which the decided experience rules out as the default)
  - team-hosted inference, disclosed as another processing boundary
  - the local model
- **The local model path needs no provider account,** which matches the decided direction.

**Recommendation:** make the connector and extension route the "use your own account" path, and treat in-app hosted chat as local-first, with team-hosted inference as a clearly disclosed option.

**Update (2026-09-26):** the in-app route is now the student's own **CLI** (Claude Code / Codex / Gemini CLI) driven headlessly, or a local model. The Claude Code terms explicitly allow end users to authenticate with their own subscription credentials when the unmodified binary is used and sign-in completes through Anthropic's flow. See [agent-runtime.md](agent-runtime.md).
