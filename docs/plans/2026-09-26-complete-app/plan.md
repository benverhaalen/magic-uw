# Complete app plan: Magic Canvas as a product

**Written** 2026-09-26 ~16:30 CDT, against `origin/main` `73ff7a6`. Public version; internal cost figures omitted.
**Scope:** the operator's direction: "forget just about demo features, we want the complete app realized". The learning-features plan (`../2026-09-26-learning-features/plan.md`) becomes Phase 0 inside this one.
**Status:** proposed. Items marked **Team** change accepted decisions or existing code, so the team decides them.

## The product in one paragraph
- **What it is:** a desktop app (Windows + macOS). The student signs in to UW once, and every course is harvested, understood and banked locally.
- **What they get:**
  - NotebookLM-grade course resources: grounded answers with checked quotes, study guides, FAQs, glossaries, timelines, mind maps, and what each exam covers
  - a Duolingo/Quizlet-style practice path with tracking
  - a ready-made note-taking folder tree in their own Word/OneDrive or Google Drive
- **Price:** a **one-time $5**, which covers the hosted Jev judgments and a service fee.
- **AI:** the thinking runs on **the student's own AI CLI** (Claude Code, Codex or Gemini CLI), detected automatically, or on the built-in local model. The app configures that CLI with its own isolated settings and drives it headlessly.

## Deciding facts (research of 2026-09-26; labels in the research notes)
| Fact | Source | Consequence |
|---|---|---|
| `claude auth status --json` returns `loggedIn`, `authMethod`, `subscriptionType` (plus email and orgId, which we discard) | local probe | auto-detect with no credential files read |
| `claude -p --setting-sources project,local --strict-mcp-config --mcp-config <ours>` **reused the existing login and loaded no user CLAUDE.md, skills or MCP** | local probe, 1 run | **Claude: auto-reuse + isolation works** (re-test in CI) |
| `codex login status` → "Logged in using ChatGPT". `codex exec --ignore-user-config` **still loaded the global `~/.codex/AGENTS.md`**; no documented switch stops it | local probe; developers.openai.com | Codex: reuse the login and accept the user's AGENTS.md (with our instructions taking precedence), **or** use an isolated `CODEX_HOME` with a one-time sign-in |
| Gemini CLI has **no auth-status command**. `GEMINI_CLI_HOME` relocates `~/.gemini` (enterprise.md; `packages/cli/index.ts`). The global GEMINI.md loads by default; `context.fileName` renames it | gemini-cli repo docs and source | Gemini: isolated `GEMINI_CLI_HOME` + an API key in the environment. Status = the key is present and a test call succeeds |
| **Claude Code needs Pro, Max, Team, Enterprise or Console.** "The free claude.ai plan does not include Claude Code access" | code.claude.com/docs/en/setup | the free path is **not** Claude |
| **Codex is "included across ChatGPT plans, including Free and Go"** (limited usage) | help.openai.com 11369540 | **a free path exists via Codex** (not used: the operator requires paid providers). Third-party use is undocumented (openai/codex#36886 open, unanswered) |
| Gemini CLI: 1,000 requests a day with a personal Google sign-in, but **"using third-party software… with Gemini CLI OAuth is a violation… suspension"**. An unpaid API key gets 250 a day, Flash only, and **Google may train on the content, with human review** | gemini-cli tos-privacy.md, quota-and-pricing.md; ai.google.dev/gemini-api/terms | Gemini free = an API key **with a clear data-use disclosure;** not recommended for classmates' data |
| Anthropic: an unmodified binary; "may not pay for, resell, or intermediate Claude usage on their end users' behalf"; running Claude Code in a product **requires the Commercial Terms**; the naming rule | code.claude.com/docs/en/legal-and-compliance | our $5 must **not** include or resell model usage (it doesn't: it covers Jev + service). Accept the Commercial Terms. Never "Claude Code" in our name |
| **The Jev key must never ship to clients.** The existing gateway enrolls devices and holds the key server-side | the existing gateway code | "a Jev key assigned on download" = **a licence → a device credential** (no per-student Jev budget; the gateway keeps a global abuse cap) |
| $5 nets **$4.25** at Lemon Squeezy, Polar and Paddle (all merchant of record; **Paddle asks under-$10 products to contact them**), $4.00 at Gumroad, ~$4.53 at Stripe (not merchant of record) | pricing pages | Lemon Squeezy or Polar first. The Lemon Squeezy licence API has activate/validate/deactivate |
| Apple Developer Program $99 a year. A sandboxed Mac App Store build likely can't launch user-installed CLIs (inferred from forums). Windows: Artifact Signing builds SmartScreen reputation over time; EV no longer recommended | Apple and Microsoft docs | direct signed and notarized downloads; no stores |
| Google Drive for desktop syncs at `~/Library/CloudStorage/…` (macOS, fixed) and `G:` by default (Windows); registry `HKCU\Software\Google\DriveFS`. OneDrive: `%OneDrive%`, `%OneDriveCommercial%`, and `HKCU\Software\Microsoft\OneDrive\Accounts\*\UserFolder` (community-sourced) | support.google.com; community sources | **Notes to Word or Drive with no OAuth:** write .docx into the detected sync folder |
| Drive API `drive.file` is **non-sensitive**, so no security assessment; desktop OAuth via loopback | Google docs | optional upgrade: native Google Docs conversion |
| UW's KB urges caution with M365/Google OAuth grants and prefers "campus vetted" apps | kb.wisc.edu 139025 | Graph and Drive OAuth are opt-in upgrades, not the default |
| MIT and Apache building blocks: `unpdf`/`pdfjs-dist` (PDF by page), `officeParser` (PPTX by slide, DOCX), `ts-fsrs`, `docx` (dolanmiu), `markmap` | GitHub licences via `gh api` | adopt as candidates per `docs/tool-evaluation.md` |

## Architecture (what talks to what)
```
UW sign-in (existing) ─► Canvas harvest (existing: +modules/pages/files) ─► extraction (pages/slides, offsets)
      └─► local store (existing: node:sqlite in worker; +v3 feature tables, passages)
                 ├─► course compiler: code → Jev (device credential; global abuse cap) → CLI model
                 ├─► Magic tools MCP server (ours, bundled, stdio)  ◄── the student's CLI, driven headlessly
                 │      coarse tools: course.outline · materials.search · artifacts.build · practice.* ·
                 │      notes.build_course_tree · deadlines · policy · judge.* (Jev)
                 ├─► artifacts (study guide, FAQ, glossary, timeline, mind map, exam coverage, grounded chat)
                 ├─► practice (path, lessons, XP/streak, Learn mode, flashcards via FSRS, practice exams)
                 └─► notes: .docx tree → OneDrive/Drive sync folder (default) | Drive API | Graph (opt-in)
Settings ▸ "Connect": detect CLIs + status → built-in isolated config → install the Magic tools MCP into it
Licence: $5 via merchant of record → licence key → gateway device credential with a Jev budget
```

**Why the coarse tools instead of generic Drive or Word MCP servers:**
- **Cost:** a generic server makes the model plan every file operation and read every result. Our tools do the bulk work in code, use Jev for the typed choices, and hand the model only compact results.
- **Portability:** the same tools work identically from all three CLIs.
- **Option kept:** third-party MCP servers (Google's Workspace remote server; Microsoft's catalog) stay an opt-in for power users.

## Components, owners and phases
Owners are proposals. The team assigns ownership (docs: no ownership assignments yet).

| # | Component | Builds on | Phase | Proposed owner | Needs the team? |
|---|---|---|---|---|---|
| 1 | **Canvas coverage:** modules → items → pages and files, announcements; download with the app session | canvas.ts patterns (bounded GETs, partial states) | 0 | connector owner | **yes** |
| 2 | **Extraction:** PDF by page (unpdf/pdf.js), PPTX by slide and DOCX (officeParser), `parts` offsets | tool-evaluation adoption gate | 0 | us, with team review | contract field |
| 3 | **Storage v3:** items, responses, reviews, passages (+FTS); purge-covered | storage migrations | 0 | backend owner, or us with review | **yes** |
| 4 | **AI runtime:** detection (PATH + known install paths; Dock apps lack a shell PATH), status, eligibility, built-in isolated configs, headless adapters (Claude stream-json; Codex exec JSON + resume; Gemini `-p` stream-json), one adapter interface, local-model fallback | the existing local AI | 0: Claude, 1: Codex and Gemini | us | new IPC + commands: **yes** |
| 5 | **Magic tools MCP server** (stdio, bundled; read-only to school systems; policy and integrity gates; receipts) | contracts, store | 0: outline, search, notes tree; 1: the rest | us | no (new package) |
| 6 | **Artifacts:** study guide, FAQ, glossary, timeline, mind map (markmap), exam coverage, grounded chat with checked quotes; cached, rebuilt when sources change | the learning package | 0: chat + study guide; 1: the rest | us | job kinds: **yes** |
| 7 | **Practice:** course path from modules, lessons, XP/streak/progress, Learn mode (MC → typed), flashcards (ts-fsrs), practice exams (tiers T1–T4), checked-item pipeline, mistakes queue, tracking | the learning package + v3 tables | 0: lesson + tracking; 1: full path, FSRS, exams | us | commands: **yes** |
| 8 | **Notes:** per-course folder tree + .docx per session type (Cornell, guided, worked-problem, lab…); Jev picks the template; the model pre-fills the outline. **Assume no cloud storage or OneDrive is set up** (operator, 16:40); the targets below are tried in order | docx (MIT); detection | 0: local tree + open; 1: sync-folder detection; 2: Drive/Graph APIs | us | no |
| 9 | **Settings ▸ Connect:** AI client, notes target, integrations button (installs our MCP into the chosen CLI's isolated config; optional third-party servers) | #4 #5 #8 | 0 minimal; 1 full | us + UI owner | renderer: **yes** |
| 10 | **Licence and payments:** Lemon Squeezy or Polar checkout, licence activate/validate, gateway enrollment bound to the licence, the global abuse cap, offline grace, refunds | the existing gateway | 1–2 | gateway owner + us | **yes** |
| 11 | **Distribution:** signed and notarized builds, auto-update, website download | the existing build | 2 | build owner | **yes** |
| 12 | **Evaluation and CI:** harness, frozen gold, seeded errors, blind bench vs NotebookLM | learning plan T0/T7 | 0–1 | us | CI: **yes** |

**Phase 0 = now → Sunday 10:00 CT,** an in-app demo that isn't the final UI:
- one real course harvested with files
- Claude Code detected, configured and running the Magic tools
- a grounded answer with checked quotes
- a study guide
- one practice lesson with tracking
- the notes tree written to the local default folder and opened in the default `.docx` app; OneDrive only if it's detected
- a signed-out Claude Code taken through `claude auth login` in the styled panel

**Phase 1** (the next week): Codex and Gemini adapters, all artifacts, the full practice path, FSRS, licence plumbing.
**Phase 2:** payments live, signed distribution, Drive/Graph APIs, polish.

## Connecting an AI client: when it's missing or signed out
Operator direction (16:40): *"they need to be authenticated; if they aren't, the terminal-driven but stylized chat input opens a Claude login page that then authorizes."*

**1. Detect.** Check PATH plus the known install paths (a Dock-launched app lacks the shell PATH), then run `--version`.

**2. Status.**

| Client | How the app checks status |
|---|---|
| Claude | `claude auth status --json` → `loggedIn`, `authMethod`, `subscriptionType`. Everything else is discarded, never stored or logged |
| Codex | `codex login status` |
| Gemini | the API key is present in the app's keychain entry, and a one-token test call succeeds |

**3. Not installed.** The same styled console panel offers the **official** installer command (for example Claude's native installer). It runs only after the student clicks Install and sees the exact command.

**4. Not signed in.** A styled chat-like console runs the provider's **own** login, and the app never sees a token:

| Client | Login flow |
|---|---|
| Claude | `claude auth login` (default: Claude subscription) opens **Anthropic's own sign-in page** in the browser. The panel shows the progress text and the URL fallback, then polls `auth status` until `loggedIn`. This complies with "sign-in… through Anthropic's own flow" |
| Codex | `codex login` (browser), or **`--device-auth`**: a code + URL shown in the panel, which works without a terminal |
| Gemini | the student pastes their own API key, stored with Electron `safeStorage` (OS keychain) and passed only as `GEMINI_API_KEY` to the Gemini process. The data-use disclosure for unpaid keys is shown first. Google-account OAuth isn't offered, because of the third-party OAuth terms |

**5. A paid provider is required** (operator decision, ~16:50). The four routes:

| Route | What the student needs | How the app runs it | Who pays for Jev |
|---|---|---|---|
| **Claude** | Claude Pro, Max, Team or Enterprise (free doesn't include Claude Code) | Claude Code, existing login reused, isolated flags | our gateway, from the $5 licence budget |
| **Codex** | a paid ChatGPT plan | `codex exec`, existing login reused. Third-party terms are undocumented (openai/codex#36886), so disclose | our gateway |
| **Gemini** | a **paid** Gemini API key (paid terms: no training on content) | Gemini CLI with an isolated `GEMINI_CLI_HOME` + `GEMINI_API_KEY` from the OS keychain. No Google-account OAuth (third-party terms) | our gateway |
| **OpenRouter key** | the student's own OpenRouter API key, stored with `safeStorage` | **Claude Code pointed at OpenRouter:** `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_API_KEY=""`; pin Anthropic as the top provider (OpenRouter: "only guaranteed to work with the Anthropic first-party provider"). Needs Claude Code installed, not a Claude plan | **the student's own key,** through OpenRouter's Jev decisions route, so no gateway spend |

**Candidate:** OpenRouter's `typesafe/jev-router` (listed 2026-09-25; "picks the best model and reasoning effort for each request"). Test it against a fixed model on our eval before using it by default. Claude Code with non-Anthropic providers "may be subject to compatibility limitations".

**Decision:** the free and local routes are out of the default product. A paid provider is required. The local model can remain an optional offline fallback in the code already built, but the product doesn't depend on it.

**Terms, inferred:** Anthropic lists "3P inference provider credential" among the allowed end-user credentials. Whether OpenRouter counts is unconfirmed. OpenRouter documents the Claude Code setup itself.

**6. Probe before building:** does `claude auth login` work with piped stdio (no TTY)?
- If yes: plain `child_process` + a styled panel.
- If no: a pseudo-terminal (`node-pty`, a native module; weigh its packaging cost), or launch the login in the OS terminal and poll status.
- The probe opens a real sign-in tab, so it runs with the operator present.

## Notes targets when nothing is set up
Tried in order. The student can change the target in Settings.
1. **Local folder, the default,** always available: `Documents/Magic Canvas/<Term>/<Course>/{Lectures, Assignments, Exams, Readings}/…`. Files use plain `.docx`, so they open in Word, Pages, LibreOffice or Google Docs.
2. **A detected sync folder** (OneDrive or Google Drive for desktop), only when present, and offered, never assumed. The same tree is written there so it syncs.
3. **Opt-in cloud APIs,** for a student with no sync client who wants cloud notes:
   - Google Drive `drive.file` (non-sensitive, loopback OAuth), converting to native Google Docs
   - Microsoft Graph (UW tenant consent unverified; UW KB urges caution with OAuth grants)

**Opening a note:**
- the default app for `.docx`
- if none is registered, a read-only in-app preview, plus the options "Get Microsoft 365 (UW provides it to students; *inferred, verify on kb.wisc.edu*)" or "Open in Google Docs" (step 3)

**Sync-back:** the app records each note's path and hash only. It never needs cloud access to find the student's own notes later.

## Our decisions that differ from the recorded direction (code changes via PRs to `main`)
1. **"Any account with ChatGPT, Claude or Gemini; no paid-plan prerequisite"** becomes "the student's own CLI":
   - Claude needs Pro or higher.
   - ChatGPT Free works via Codex, with limits and without documented third-party terms.
   - Gemini works via a free API key, but that key permits training on the content; or via a paid key.
   - The local model remains the no-account path.
2. **Pricing:** a $5 one-time licence, not free. "No separate account" still holds, because a licence key isn't an account. The repo is MIT, and "closed distribution needs a deliberate licensing decision" (decisions.md). This is that decision.
3. **Jev:** one owner key stays server-side. **No per-student Jev budget** (the operator expects a small worst-case cost per student); keep the gateway's global abuse cap. OpenRouter-key users pay their own Jev.
4. **Anthropic's Commercial Terms** must be accepted by the team. The naming rule applies.
5. **Notes live in Word/OneDrive or Google Drive,** not an in-app editor. The sync-folder path needs no OAuth. The OAuth APIs are opt-in (UW KB caution).
6. **Seam changes:** storage v3, new commands and IPC for the AI runtime, practice, notes and artifacts, job kinds, and Canvas coverage. These are listed in `where-we-differ.md`, now pushed in PR #1.

## Operator answers (2026-09-26 ~17:00)
- **Codex:** reuse the login. Isolate it behaviourally with `-c developer_instructions` (probed: the model declined to follow the global AGENTS.md), plus `--ignore-user-config --ignore-rules --ephemeral -s read-only` and our MCP server only.
- **Payments:** not chosen yet.
- **Jev budget:** none per student; a global abuse cap only.
- **Publishing:** a public version of the research and plans is pushed (internal cost figures omitted).
- **Next:** the professional spec for the notebook and study tracking, in `docs/plans/2026-09-26-notebook-and-study-tracking/`.

## Still open
1. **For the team:** the paid-provider requirement; the $5 licence and repo licensing; Anthropic's Commercial Terms; and the Phase 0 seams (Canvas files, storage v3, commands). Draft them as PRs once the team reacts.
2. **Probe with the operator present:** `claude auth login` without a TTY.

**Plan gate:** not yet attacked by an independent reader. That runs once 1–6 are answered, since the answers change the tasks.
