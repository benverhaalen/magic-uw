# End-to-end harness: a fresh student's setup, driven through the real app

Three tiers (plan D53). Tier 1 runs anywhere, costs nothing and is the one CI runs. Tier 2 uses the operator's own signed-in clients and runs only on request. Tier 3 is the UW sign-in, which needs a person.

| Tier | Command | Cost | Where |
| --- | --- | --- | --- |
| 1: fresh system, fake clients | `pnpm test:e2e` | none | Windows and Linux, CI (`.github/workflows/e2e.yml`) |
| 2: the operator's real Claude Code and Codex | `pnpm test:e2e:real` | capped, see below | the operator's machine, on request |
| 3: real UW sign-in | checklist below | none | the operator present |

Each run writes a Playwright trace (`trace.zip`, open with `npx playwright show-trace`), a video (`.webm`), the clients' call log (`calls.jsonl` or `guard.jsonl`) and `steps.json` (timings, and the page text if a step failed) to `$MAGIC_E2E_ARTIFACTS/<time>-<name>/`. The default is `<os tmp>/magic-e2e-artifacts`. Set `MAGIC_E2E_KEEP=1` to keep the temporary system folder too.

## Tier 1: what "fresh system" means

`harness/fresh-system.ts` starts the real Electron app (`apps/desktop`, built by `scripts/build.ts`) with:

- a new temporary `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `MAGIC_USER_DATA`;
- a `PATH` of system folders plus one folder of fake clients, and only OS facts (`SystemRoot`, `PATHEXT` and similar) from the host environment. No user variable, no Node and no real client leaks in;
- `MAGIC_HEADLESS=1` (hidden window; UW sign-in refuses to open);
- Chromium's resolver mapped to nothing except loopback (`--host-resolver-rules`), so the renderer and the app's sessions can't reach the network;
- canary `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_BASE_URL` values, which must never reach a client.

The fake home holds a student's usual client files (`~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.claude.json`, `~/.codex/config.toml`, `~/.codex/AGENTS.md`), so "unchanged" is a real check.

### The fake clients (`fake-cli/fake.mjs`)

These are `claude` and `codex` as npm-style `.cmd` shims on Windows (the app's own `resolveCli` resolves them to the `node.exe` beside them) and as shell scripts elsewhere. They implement what the app calls: `--version`, `--help` / `exec --help` (listing the flags instant mode requires), `codex features list`, `claude auth status --json` / `codex login status`, Claude one-shot JSON, Claude stream-json warm sessions, and `codex exec --json`. Model output is schema-valid. Cards are grounded in the prompt's own passages (a verbatim sentence, cloze on its longest word), so they pass the app's code checks.

A scenario (`harness/scenarios.ts`, written to `<fake-bin>/scenario.json`; tests swap it mid-run) sets each client's version, sign-in, plan and run outcome:

- signed in (Max / Plus, or Pro)
- signed out
- free plan
- usage limit with a stated reset time
- model unavailable
- offline
- an old version missing a flag
- a newer version whose `--help` dropped a flag
- not installed

Messages are the clients' own, as listed in `apps/desktop/src/clients/health.ts` `HEALTH_EVIDENCE`. A sign-in lives in the client's home: the app's own profile (a different `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) starts signed out, as it does with the real clients. Every call is recorded with its argv, environment variable names only, working folder and the files the fake itself wrote.

### The flows

| File | What it drives and checks |
| --- | --- |
| `journey.e2e.ts` | Agreement checkbox, then UW sign-in (refused headless, no window), then the tiles (real status and version), selecting Codex (its AGENTS.md note), Advanced and the separate sign-in toggle, connecting Claude Code in instant mode with its own agreement, appearance (dark, blue; checks `data-theme`, `data-accent` and the saved value), connections, Open workspace, the sample course from Home, a plain-language command (code path, 0 tokens, no model call), then Data & AI (the "Your AI" radio and the Course materials switch; the saved values read back, and "Your AI" offers Codex). Next, Workspace tools → Practice (the course select), **Generate flashcards** with Claude Code while the Agenda tab loads through the worker (timed, 1.5 s budget); the result line is read back, and a second click is a cache hit. Last, Codex's cards (its "done … tokens" line, then a cache hit: 0 tokens, no call). It then checks both clients' argv, the app's working folders, that no sign-in was started, and that the home's `.claude`, `.claude.json` and `.codex` hold only the clients' own writes. |
| `health.e2e.ts` | Each onboarding health state: tile text, notice (`data-health-state`, title, next step, the command shown, actions), Continue enabled or disabled, "Choose another AI". Run-time states (usage limit, model unavailable, offline, a free ChatGPT account) go through a pack call. States the pre-run gate refuses (signed out, free Claude plan) are checked to send nothing. Recovery closes the file. |
| `onboarding-sample.e2e.ts` | "Load sample course" on onboarding's last step (known bug, below). |
| `notes.e2e.ts` | Session notes, read in Workspace tools → Notes: a scaffold for every lecture and discussion in the rolling window ("Class sessions", then "Open note"; titles and first blocks read from the DOM). A student edit survives a schedule change, and an untouched note is rebuilt (revision 2, the new title on screen). The synthetic schedule is dated from today (`harness/schedule.ts`) and imported as its own source. Each check waits for the worker's 30 s notes tick. |

A few steps have no control yet, so they call the renderer's own bridge (`window.magic.execute`): renderer, then preload, main, worker, runner and the fake client, which is the path a control would take. They should move to DOM steps when the controls land:

- the command bar (WorkspaceTools and App.tsx mount null stubs);
- the note edit (the Notes preview has no editor);
- choosing Codex after onboarding, with its agreement and sharing;
- in `health.e2e.ts`, the run-time failures, which read the pack result.

### Known failures, stated as `todo` tests

Each `todo` test asserts the correct behaviour. It reports its failure without failing the run and passes once the product is fixed; remove `todo` then.

| Test | Cause |
| --- | --- |
| journey: no `ANTHROPIC_*` / `OPENAI_*` in a client's environment | `cliEnvironment(options.env)` (packages/runner/src/process.ts) spreads the worker's whole `process.env` under the instant-mode allowlist, and the worker is forked with main's full env. The canaries reach Claude Code's session. |
| onboarding-sample: stays on the last step / mode stays instant | `loadSample()` (Onboarding.tsx) always calls `setStep("client")`. Back on "Your AI", ConnectClient's `mode ?? "isolated"` fallback saves isolated mode for a student who chose instant; runs then use the app's own profile without `--safe-mode`. |
| health: the usage-limit reset time reaches the student | `RunnerError.resetsAt` is dropped: the pack result carries only the generic message, and no screen shows run-time health. |

### Not covered, and what it needs

- **Notes sync to Word and Google Docs, "Open in Word/Docs", and a remote-versus-local conflict** need fake Microsoft and Google remotes. The app has no seam to point them at: Google needs `MAGIC_GOOGLE_CLIENT_ID` plus main's OAuth and Drive calls (`apps/desktop/src/notes-google.ts`), and Microsoft needs an MSAL grant of `Files.ReadWrite.AppFolder` plus main's Graph proxy. A test transport in main (for example a local fake endpoint enabled only by a test variable) would make both testable.
- **Offline at onboarding** is reached only when the client's status is unreadable and a DNS lookup of the provider fails. The fake can't make the app's own DNS fail, so offline is tested at run time.

## Tier 2: the operator's real clients (`pnpm test:e2e:real`)

**Run it only on request.** It spends plan usage. It never runs in CI (it isn't matched by `tests/e2e/*.e2e.ts`).

The app runs on the same fresh system as Tier 1. The client folder on its PATH holds the **cost guard** (`real/guard.mjs`) instead of the fakes. The guard forwards to the operator's real `claude` and `codex` (found with the app's own `resolveCli` before launch). It gives them the operator's own home, app data and PATH (paths only), so they run signed in. The app doesn't get the real home directly because, on Windows, its `resolveCli` finds `~/.local/bin/claude.exe` and any `codex.exe` on PATH before a `.cmd`, which would bypass the guard. The one visible difference is that Codex's personal-AGENTS.md note reflects the fresh home.

The guard's limits:

- **Model:** the cheapest tier is passed explicitly: Claude `--model haiku` (override with `MAGIC_E2E_CLAUDE_MODEL`), and Codex at `model_reasoning_effort="low"` on its default model (name one with `MAGIC_E2E_CODEX_MODEL`).
- **Calls:** at most **2 generation calls per client**. The journey makes 1 each; the second leaves room for the pack runner's one retry. Its escalation to the strong model is refused.
- **Input:** at most **48,000 characters of prompt per call** (about 12k tokens). A larger call is refused before it is sent.
- **Sign-in:** never forwarded.

The course is synthetic, about 2k tokens of text. Expected spend is one cards call per client, about 3–4k input tokens and under 1.5k output tokens each. The hard ceiling is 2 calls × 12k input tokens per client, plus each call's output. On a Claude or ChatGPT subscription this is plan usage, not a charge.

It prints, per client: calls, refusals, tokens as the client reported them (input, cache read and write, output), the model and latency. It also prints the app's result (status, cards accepted and dropped by the code checks) and the before/after list of `~/.claude`, `~/.claude.json` and `~/.codex` entries by name, size and modification time. No file there is opened.

## Tier 3: the UW sign-in (the operator present; Duo is never automated)

The harness can't and won't sign in to UW: headless mode refuses to open the window, and Duo is never automated. With the operator at the machine:

1. `pnpm build`, then start the app with a fresh profile (not headless): `MAGIC_USER_DATA=<new empty folder> pnpm exec electron apps/desktop` in bash, or `$env:MAGIC_USER_DATA="<new empty folder>"; pnpm exec electron apps/desktop` in PowerShell.
2. Tick the agreement and click **Continue to UW sign-in**. Expected: UW's own page opens in the app's window titled `UW sign in · canvas.wisc.edu`.
3. The operator types their NetID and password and approves Duo. Nothing is typed by a script.
4. Expected: the window closes by itself, the step shows "Signed in. Reading your courses now." with **Continue**, and Canvas reading starts. Closing the window instead shows "The sign-in window was closed before UW confirmed it. Nothing was read." and **Sign in again**.
5. From here the Tier 1 steps apply unchanged: Your AI, Appearance, Connections, then the workspace, which should say "Reading your courses" and then list the real sources.
6. Afterwards, **Data & AI → Delete local data…** (type `DELETE LOCAL DATA`) removes the coursework, and the folder from step 1 can be deleted with the session inside it.

What the harness automates around it: everything before step 2 and after step 4 in Tier 1 form. The typed sign-in outcome (`magic:signin` returns `confirmed`, `cancelled` or `failed`) is covered by `tests/sign-in-outcome.test.ts`.
