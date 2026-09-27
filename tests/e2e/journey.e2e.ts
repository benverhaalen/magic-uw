/**
 * Tier 1: a fresh student's first run, driven through the real Electron UI with fake clients.
 * Agreement → UW sign-in (headless: refused, never automated) → Your AI (Codex, Advanced, then
 * Claude Code in instant mode) → Appearance → Connections → Open workspace → the sample course
 * from Home → a plain-language command → Data & AI (radio, select, switch) → cards from Claude
 * Code while the UI is used → Codex. Every step reads back the fields and text it set.
 *
 * The command bar and card generation have no UI on any branch yet (App.tsx renders a null
 * command-bar slot; no control runs the `pack` command), so those steps call the renderer's own
 * bridge (`window.magic.execute`): renderer → preload → main → worker → runner → the fake client,
 * the path a control would take.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { CONSENT_DISCLOSURE_VERSION } from "../../packages/domain/src/index";
import { launchFreshSystem, type FakeCall } from "./harness/fresh-system";
import { SCENARIOS, type Scenario } from "./harness/scenarios";
import { createSteps } from "./harness/steps";
import { diffHome, snapshotHome } from "./harness/home-snapshot";
import { agree, button, execute, heading, savedModes, skipUw, tiles } from "./harness/onboarding";
import { expectClaudeInstantArgv, expectCleanEnv, expectCodexInstantArgv, expectInstantCwd, expectNoLogin } from "./harness/expect-calls";

/** Codex tool features the fake lists that the app must disable (CODEX_TOOL_FEATURES ∩ the fake's list). */
const CODEX_LISTED_TOOLS = ["shell_tool", "unified_exec", "apps", "plugins", "memories", "multi_agent", "view_image", "image_generation"];
/** A UI action while a model call is in flight must finish within this. */
const RESPONSIVE_BUDGET_MS = 1500;

/** Every client call the journey made, for the checks below that are known to fail today. */
let journeyCalls: FakeCall[] | null = null;
/** The options of Data & AI's "Preferred AI" select, as rendered. */
let preferredOptions: string[] | null = null;

test("Tier 1 journey: fresh system, fake clients, the real UI", { timeout: 150_000 }, async () => {
  const scenario: Scenario = structuredClone(SCENARIOS.signedIn);
  const sys = await launchFreshSystem({ name: "journey", scenario });
  const { page } = sys;
  const steps = createSteps("journey", { onFail: () => page.locator("body").innerText() });
  const before = await snapshotHome(sys.home);
  let courseId = "";
  try {
    await steps.step("Agreement: tick the one checkbox", () => agree(page));

    await steps.step("UW sign-in: refused headless, no window, skipped", async () => {
      await heading(page, "Sign in to UW").waitFor();
      await page.getByText("Sign-in requires your interaction; headless mode will not open a window.").waitFor();
      const windows = await sys.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
      assert.deepEqual(windows, ["My Magic UW"], "no UW sign-in window was opened");
      await skipUw(page);
    });

    await steps.step("Your AI: tiles show each client's real status", async () => {
      const t = await tiles(page);
      assert.equal(t.length, 3);
      assert.match(t[0], /^Claude Code Signed in · Max Version 2\.1\.283 Recommended/);
      assert.match(t[1], /^Codex Signed in Version 0\.156\.1/);
      assert.match(t[2], /^Gemini Uses your API key/);
      assert.equal(await page.getByRole("radio", { name: /Claude Code/ }).isChecked(), true, "the recommended client is preselected");
    });

    await steps.step("Your AI: select Codex, read its note, toggle Advanced", async () => {
      await page.getByRole("radio", { name: /Codex/ }).check();
      assert.equal(await page.getByRole("radio", { name: /Codex/ }).isChecked(), true);
      assert.equal(await page.getByRole("radio", { name: /Claude Code/ }).isChecked(), false);
      // The fake home has a personal ~/.codex/AGENTS.md: instant mode is offered with a note saying so.
      await page.getByText("Codex adds your personal AGENTS.md to each request. My Magic UW still checks every answer.").waitFor();
      const advanced = page.locator("details.chn-advanced");
      assert.equal(await advanced.evaluate((d) => (d as HTMLDetailsElement).open), false, "Advanced starts closed in instant mode");
      await advanced.locator("summary").click();
      const separate = page.getByLabel("Use a separate sign-in for My Magic UW");
      assert.equal(await separate.isChecked(), false, "instant mode is the default");
      await separate.check();
      assert.equal(await separate.isChecked(), true);
      await page.getByText("The app keeps its own Codex profile, apart from yours").waitFor();
      await separate.uncheck();
      assert.equal(await separate.isChecked(), false, "back to instant before continuing");
    });

    await steps.step("Your AI: connect Claude Code (instant, its own agreement)", async () => {
      await page.getByRole("radio", { name: /Claude Code/ }).check();
      assert.equal(await page.getByLabel("Use a separate sign-in for My Magic UW").isChecked(), false);
      await button(page, "Continue").click();
      await heading(page, "Connect Claude Code").waitFor();
      const facts = (await page.locator("dl.onb-facts").innerText()).replace(/\s+/g, " ");
      assert.match(facts, /Your settings The app runs your Claude Code with its own settings passed in and never changes yours\./);
      assert.match(facts, /Who pays Usage counts toward your own Claude plan\./);
      await button(page, "Agree and continue").click();
      await heading(page, "Connect your Claude Code").waitFor();
      await page.locator("p.chn-line").getByText("Signed in with Max.").waitFor({ timeout: 30_000 });
      assert.equal(await page.locator("[data-health-state]").count(), 0, "no problem notice for a healthy client");
      await button(page, "Continue").click();
    });

    await steps.step("Appearance: dark, then the blue accent", async () => {
      await heading(page, "Choose how it looks").waitFor();
      assert.equal(await page.getByRole("radio", { name: /Match this computer/ }).isChecked(), true, "system is the default");
      await page.getByRole("radio", { name: /^Dark/ }).check();
      await page.getByRole("radio", { name: /^Blue/ }).check();
      const root = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute("data-theme"),
        preference: document.documentElement.getAttribute("data-theme-preference"),
        accent: document.documentElement.getAttribute("data-accent"),
        saved: localStorage.getItem("magic.appearance.v1"),
      }));
      assert.deepEqual({ theme: root.theme, preference: root.preference, accent: root.accent }, { theme: "dark", preference: "dark", accent: "blue" });
      assert.deepEqual(JSON.parse(root.saved ?? "{}"), { theme: "dark", accent: "blue" });
      await button(page, "Continue").click();
    });

    await steps.step("Connections: both rows state their status; skipped", async () => {
      await heading(page, "Add other accounts").waitFor();
      await page.waitForFunction(() => !document.body.innerText.includes("Checking…"), undefined, { timeout: 15_000 });
      const rows = await page
        .getByRole("list", { name: "Optional connections" })
        .locator("li")
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
      assert.equal(rows.length, 2);
      assert.match(rows[0], /^Microsoft 365 /);
      assert.match(rows[1], /^Google Drive /);
      await button(page, "Skip for now").click();
    });

    await steps.step("Done: nothing read yet; open the workspace; the mode stayed instant", async () => {
      await heading(page, "Nothing connected yet").waitFor();
      await page.getByText("No source has been read yet. Sign in to UW, or look around with a sample course.").waitFor();
      await button(page, "Open workspace").click();
      await page.getByRole("button", { name: "Load sample course" }).first().waitFor({ timeout: 15_000 });
      assert.deepEqual(await savedModes(sys.userData), { claude: "instant" }, "the saved connection mode");
    });

    await steps.step("Home: load the sample course (fixture, no network)", async () => {
      await page.getByRole("button", { name: "Load sample course" }).first().click();
      await page.getByText("Synthetic sample").first().waitFor({ timeout: 30_000 });
      const snap = await execute(page, { type: "snapshot" });
      assert.equal(snap.snapshot.fixtureMode, true);
      assert.ok(snap.snapshot.resources.length > 0);
      courseId = snap.snapshot.resources.find((r: any) => r.kind === "assignment")?.courseId;
      assert.ok(courseId, "the sample course has an assignment");
      await page.getByRole("button", { name: "Courses", exact: true }).first().click();
      await page.getByText("Writing 101 · Sample").first().waitFor();
    });

    await steps.step("Command: a plain-language command resolves in code (0 tokens)", async () => {
      const runsBefore = (await sys.calls()).filter((c) => c.kind === "run" || c.kind === "ask").length;
      const result = await execute(page, { type: "command", value: { text: "what's due tomorrow", context: { courseId } } });
      assert.equal(result.command.path, "code", `path ${result.command.path}: ${JSON.stringify(result.command).slice(0, 300)}`);
      assert.deepEqual(result.command.tokens, { in: 0, cached: 0, out: 0 });
      const runsAfter = (await sys.calls()).filter((c) => c.kind === "run" || c.kind === "ask").length;
      assert.equal(runsAfter, runsBefore, "no model call for a code-resolved command");
    });

    await steps.step("Data & AI: share course text with Claude (radio, select, switch)", async () => {
      await page.getByRole("button", { name: "Data & AI", exact: true }).first().click();
      await heading(page, "Data & AI").waitFor();
      const badge = () => page.locator(".settings-page .badge").first().innerText();
      assert.equal(await badge(), "Cloud access off", "a fresh workspace keeps AI context local");
      // Controlled inputs: each change saves through the workspace, then the field reflects it.
      const selective = page.getByRole("radio", { name: /Choose what can be shared/ });
      await selective.click();
      await page.waitForFunction(() => document.querySelector(".settings-page .badge")?.textContent === "Selective cloud access");
      assert.equal(await selective.isChecked(), true);
      const preferred = page.getByLabel("Preferred AI");
      assert.equal(await preferred.isEnabled(), true, "the select opens once sharing is selective");
      preferredOptions = await preferred.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      await preferred.selectOption("claude");
      await page.waitForFunction(() => (document.getElementById("provider") as HTMLSelectElement | null)?.value === "claude");
      await page.waitForFunction(() => !document.body.innerText.includes("Working…"));
      const courseText = page.getByRole("switch", { name: /Course text/ });
      if (!(await courseText.isChecked())) await courseText.click();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll<HTMLInputElement>("input[role=switch]")).some((i) => i.closest("label")?.textContent?.startsWith("Course text") && i.checked),
      );
      const privacy = (await execute(page, { type: "snapshot" })).snapshot.privacy;
      assert.deepEqual(
        { mode: privacy.mode, hostedProvider: privacy.hostedProvider, shareCourseText: privacy.shareCourseText },
        { mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true },
        "what the student set is what the workspace saved",
      );
    });

    await steps.step("Cards with Claude Code: checked and stored; the UI stays responsive", async () => {
      // Hold the model's answer open and use the UI meanwhile.
      await sys.setScenario({ ...scenario, claude: { ...scenario.claude, delayMs: 2500 } });
      await page.evaluate((c) => {
        (window as any).__pack = (window as any).magic.execute(c);
      }, { type: "pack", pack: "cards", scope: { courseId } });
      await page.waitForTimeout(300);
      const started = performance.now();
      await page.getByRole("button", { name: "Courses", exact: true }).first().click();
      await page.getByText("Writing 101 · Sample").first().waitFor({ timeout: RESPONSIVE_BUDGET_MS * 4 });
      const uiMs = Math.round(performance.now() - started);
      const cards = (await page.evaluate(() => (window as any).__pack)).pack;
      await sys.setScenario(scenario);
      assert.ok(uiMs <= RESPONSIVE_BUDGET_MS, `a UI action during generation took ${uiMs} ms (budget ${RESPONSIVE_BUDGET_MS})`);
      assert.equal(cards.status, "done", `${cards.status}: ${cards.message}`);
      assert.ok(cards.counts.accepted > 0, `accepted ${cards.counts.accepted} of ${cards.counts.generated}`);
      assert.ok(cards.tokens.in > 0, "tokens reported by the client");
      console.log(`  cards: ${cards.counts.accepted}/${cards.counts.generated} accepted, ${cards.tokens.in} in / ${cards.tokens.out} out tokens; UI action during the run: ${uiMs} ms`);
    });

    await steps.step("Claude Code runs: instant-mode argv and the app's own folder", async () => {
      const calls = (await sys.calls()).filter((c) => c.client === "claude");
      const runs = calls.filter((c) => c.kind === "session" || c.kind === "run");
      assert.ok(runs.length >= 1, "Claude was run");
      for (const run of runs) expectClaudeInstantArgv(run.argv);
      expectInstantCwd(calls.filter((c) => c.kind !== "version"), sys.userData);
    });

    await steps.step("Codex: its agreement and choice; cards with instant-mode argv", async () => {
      await execute(page, { type: "consent", value: { action: "grant", recipient: "codex", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
      await page.evaluate(() => (window as any).magic.clients.choose("codex"));
      // The select has no Codex option (see the todo test below), so this goes through the bridge.
      await allowProvider(page, "codex");
      const cards = (await execute(page, { type: "pack", pack: "cards", scope: { courseId } })).pack;
      assert.equal(cards.status, "done", `${cards.status}: ${cards.message}`);
      assert.equal(cards.cached, false, "the cache is per route: Claude's answer isn't reused for Codex");
      const detail = JSON.stringify({ counts: cards.counts, tokens: cards.tokens });
      assert.ok(cards.counts.generated > 0 && cards.tokens.in > 0, detail);
      // The fake writes the same sentences for both clients: the course-wide duplicate check drops
      // what Claude's cards already cover instead of storing them twice.
      assert.equal(cards.counts.droppedBy.near_duplicate ?? 0, cards.counts.generated - cards.counts.accepted, detail);
      const calls = (await sys.calls()).filter((c) => c.client === "codex");
      const runs = calls.filter((c) => c.kind === "run");
      assert.equal(runs.length, 1, "one call");
      expectCodexInstantArgv(runs[0].argv, CODEX_LISTED_TOOLS);
      expectInstantCwd(calls.filter((c) => c.kind !== "version"), sys.userData);
    });

    await steps.step("Codex: the same request again is a cache hit (0 tokens, no call)", async () => {
      const before = (await sys.calls()).filter((c) => c.kind === "run").length;
      const cards = (await execute(page, { type: "pack", pack: "cards", scope: { courseId } })).pack;
      assert.equal(cards.status, "done");
      assert.equal(cards.cached, true);
      assert.deepEqual(cards.tokens, { in: 0, cached: 0, out: 0 });
      assert.equal((await sys.calls()).filter((c) => c.kind === "run").length, before, "a cache hit calls no client");
    });

    await steps.step("No client sign-in or interactive session was started", async () => {
      expectNoLogin(await sys.calls());
    });

    await steps.step("~/.claude, ~/.claude.json, ~/.codex: only the clients' own writes", async () => {
      const diff = diffHome(before, await snapshotHome(sys.home));
      const clientWrites = new Set((await sys.calls()).flatMap((c) => c.wrote ?? []).map((p) => p.slice(sys.home.length + 1)));
      assert.deepEqual([...diff.added, ...diff.changed].filter((p) => !clientWrites.has(p)), [], "files the app itself wrote in the student's client homes");
      assert.deepEqual(diff.removed, [], "files removed from the student's client homes");
    });
  } finally {
    journeyCalls = await sys.calls();
    const { trace, video } = await sys.close();
    await steps.report(sys.artifacts);
    console.log(`  trace: ${trace}\n  video: ${video ?? "(none)"}\n  calls: ${join(sys.artifacts, "calls.jsonl")}`);
  }
});

async function allowProvider(page: import("playwright").Page, hostedProvider: string) {
  const privacy = (await execute(page, { type: "snapshot" })).snapshot.privacy;
  await execute(page, { type: "privacy", value: { ...privacy, hostedProvider } });
}

// Known failing today: a Codex run is sent to the "codex" recipient (packages/core/src/jobs/pack.ts
// recipientOf), which maySend() allows only when privacy.hostedProvider is "codex"; the select in
// Data & AI (App.tsx) offers none, chatgpt, claude and gemini, so a student who chose Codex can't
// allow it from the UI. Drop `todo` once the select offers the chosen client.
test(
  "Data & AI: 'Preferred AI' offers Codex, the client a student can choose in onboarding",
  { todo: "known gap: App.tsx Preferred AI select has no 'codex' option; Codex runs are blocked for UI users" },
  () => {
    assert.ok(preferredOptions, "the journey reached Data & AI");
    assert.ok(preferredOptions!.includes("codex"), `options: ${preferredOptions!.join(", ")}`);
  },
);

// Known failing today: the runner builds a client's environment as `cliEnvironment(options.env)`
// (packages/runner/src/process.ts), which spreads the worker's whole process.env under the
// instant-mode allowlist, and the worker is forked with main's full env. The canary
// ANTHROPIC_API_KEY / OPENAI_API_KEY set in the app's environment reach Claude Code's session.
// Drop `todo` once the runner passes only the allowlist.
test(
  "Every client call: no ANTHROPIC_* / OPENAI_* / app variables in the client's environment",
  { todo: "known bug: cliEnvironment() merges the worker's full env into instant-mode runs (packages/runner/src/process.ts)" },
  () => {
    assert.ok(journeyCalls?.length, "the journey ran clients");
    expectCleanEnv(journeyCalls!);
  },
);
