# Ingestion and agent-task benchmark: ours against Claude Code and Codex

Built and dry-run only. No live run has happened. Metrics and pass criteria are in
[preregistration.md](preregistration.md).

## What each side gets

| | Ours | Baseline (Claude Code, Codex) |
|---|---|---|
| Canvas access | the operator's signed-in bench browser, through the read-only proxy | the same browser and proxy, through Playwright MCP 0.0.82 (Apache-2.0) attached over CDP |
| Code | the app's ingestion (`createIngestion`, the Canvas connector, document extraction in worker threads, core's job drain) run in-process (`ours.ts`) | a clean install of the client plus the browser tools, Node 24, Python with pip |
| Task text | none | `prompts.ts`: the exact schema, the scope, the scorer's definitions, and explicit permission to use the REST API from the signed-in page |
| Output | our store, projected onto the target schema (`exportOurs`) | the target schema, pre-created empty in a fresh working folder |
| Scoring | `score.ts` against the same gold | same |

## Fairness rules and the reasons for each choice

- **Clean client, with a browser.** Claude Code's `--safe-mode` drops `--mcp-config` servers (checked with zero
  spend on 2.1.283: `mcp_servers: []`), so it cannot drive a browser. The baseline instead runs with
  `--setting-sources local --strict-mcp-config --disable-slash-commands` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: the init message then showed only built-in tools, agents and plugins, no
  skills, and Playwright connected (25 tools). `pnpm bench:base preflight` repeats that check at zero spend.
- **Codex.** `codex exec --ignore-user-config --ignore-rules --ephemeral`, workspace-write sandbox with network on
  (Claude's shell has network), approvals never, the same Playwright MCP. Its own `browser_use`, `computer_use` and
  in-app browser are off so both clients drive the same signed-in browser, and Codex can't control the desktop.
  Codex always reads `$CODEX_HOME/AGENTS.md`; pass `--codex-home <clean home>` to remove it.
- **Same session, same network path.** One Duo sign-in in the bench browser (`session`); ours, the gold and every
  baseline run read through it. Each run starts with a cleared HTTP cache and one blank tab.
- **One browser run at a time.** Playwright MCP over CDP adopts the first page of the shared browser, so two
  agents would drive the same tab, and cloning the session into a second browser would mean reading cookie values
  (the live-trial rule forbids that). The second lane (Part B's MCP condition) needs no browser and runs alongside.
- **Read-only, enforced.** `proxy.ts` intercepts TLS for the bench browser only (the bench's own temporary
  profile trusts the proxy certificate by SPKI pin). While signing in, writes go to sign-in hosts only. After the
  dashboard loads it passes GET/HEAD only (plus Canvas GraphQL queries with no `mutation`). LTI launches, quiz take
  and logout are blocked in every phase, and so are other hosts except static assets. Blocked attempts are logged
  (method, host, path). Playwright's `browser_run_code_unsafe` is disabled: its request context would send
  requests from Node, outside the proxy.
- **Enough room.** 40 minutes and a USD cap per run, and one retry of the prompt if an attempt stops early
  with core tables empty.
- **Out of scope for both:** public web pages linked from Canvas (ours' public-site crawl is refused in the bench).

## Privacy

Live outputs (gold, databases, logs, results) go to `<main checkout>/research/bench/live-<date>/`. The CLI
refuses a folder git would track. The report holds counts, rates, timings, tokens and cost only. The browser
profile lives in the OS temp folder and is deleted when the session ends. No code here reads a cookie value.

## How to run (operator present for `session` only)

```sh
pnpm bench:base setup                       # pinned Playwright MCP into research/bench/.tools
pnpm bench:base preflight --client claude   # zero spend
pnpm bench:base session                     # terminal 1: sign in once (NetID + Duo); keep it open
pnpm bench:base gold                        # terminal 2
pnpm bench:base ours --runs 3 --repeat
pnpm bench:base baseline --client claude --model claude-opus-5-5 --runs 3 --budget 25 --timeout 40 --repeat
pnpm bench:base baseline --client claude --model claude-sonnet-5 --runs 3 --budget 10 --timeout 40 --repeat
pnpm bench:base baseline --client codex  --model gpt-6-astra     --runs 3 --budget 25 --timeout 40 --repeat
pnpm bench:base baseline --client codex  --model gpt-6-sol       --runs 3 --budget 10 --timeout 40 --repeat
pnpm bench:base tasks --trials 10 --budget-per-trial 3 --timeout-per-trial 10
pnpm bench:base report
pnpm bench:base dry-run [--scale full] [--with-ours]   # synthetic replica + fake CLI, zero spend
```

`ours --mode app` runs the shipped Electron app instead (`pnpm build` first; its own sign-in window and
`MAGIC_TRIAL_LOG`, one run per sign-in).

## Public variant

`replica-*.ts` is a deterministic Canvas replica (REST API + HTML UI, cookie session, hidden Files tabs,
restricted past courses, PDF/DOCX/PPTX with text). `buildAccount({ ocwDir })` takes page text and PDFs from a
local OCW corpus at run time. Nothing from the corpus is committed.
