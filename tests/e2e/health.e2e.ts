/**
 * Tier 1: every client health state, in one fresh system.
 * Part A, onboarding: each state the client's own status reports (signed out, a free plan, an old
 * version, a version missing a flag, not installed) shows the right tile, notice and next step,
 * and never starts a sign-in. The step is re-entered (Back, then Skip) to re-check, as a student would.
 * Part B, at run time: states only a model call reveals (usage limit with a reset time, model
 * unavailable, offline, a free ChatGPT account) and states the pre-run gate refuses, through the
 * `pack` command (no UI runs it yet; see journey.e2e.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { CONSENT_DISCLOSURE_VERSION } from "../../packages/domain/src/index";
import { launchFreshSystem, type FreshSystem } from "./harness/fresh-system";
import { SCENARIOS, type Scenario } from "./harness/scenarios";
import { createSteps } from "./harness/steps";
import { agree, allowCourseText, button, connectInstant, execute, heading, passAppearanceAndConnections, skipUw, tiles } from "./harness/onboarding";
import { expectNoLogin } from "./harness/expect-calls";

interface Notice {
  state: string | null;
  title: string;
  next: string;
  code: string | null;
  actions: string[];
}
async function notice(page: Page): Promise<Notice | null> {
  const n = page.locator(".chn-modes [data-health-state]");
  if (!(await n.count())) return null;
  return n.evaluate((el) => ({
    state: el.getAttribute("data-health-state"),
    title: el.querySelector(".chn-title")?.textContent?.trim() ?? "",
    next: el.querySelector(".chn-next")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    code: el.querySelector("code.chn-command")?.textContent ?? null,
    actions: Array.from(el.querySelectorAll(".chn-actions button")).map((b) => b.textContent?.trim() ?? ""),
  }));
}

/** Re-enter "Your AI" so it checks the clients again. */
async function recheck(sys: FreshSystem, scenario: Scenario): Promise<string[]> {
  await sys.setScenario(scenario);
  await button(sys.page, "Back").click();
  await heading(sys.page, "Sign in to UW").waitFor();
  await button(sys.page, "Skip for now").click();
  return tiles(sys.page);
}
/** The pack result for a run-time usage limit, for the known-gap check below. */
let usageLimitResult: { message?: string } | null = null;

async function select(page: Page, name: RegExp) {
  await page.getByRole("radio", { name }).check();
}

test("Tier 1 client health: each state's tile, notice and next step", { timeout: 180_000 }, async () => {
  const sys = await launchFreshSystem({ name: "health", scenario: SCENARIOS.signedOut });
  const { page } = sys;
  const steps = createSteps("health", { onFail: () => page.locator("body").innerText() });
  const continueDisabled = () => button(page, "Continue").isDisabled();
  let courseId = "";
  try {
    await steps.step("signed out: 'run claude / codex login, then Check again'", async () => {
      await agree(page);
      await skipUw(page);
      const t = await tiles(page);
      assert.match(t[0], /^Claude Code Not signed in Version 2\.1\.283 Recommended/);
      assert.match(t[1], /^Codex Not signed in Version 0\.156\.1/);
      assert.deepEqual(await notice(page), {
        state: "not_signed_in",
        title: "Claude Code isn't signed in on this computer",
        next: "Open a terminal and run claude, sign in, then click Check again.",
        code: "claude",
        actions: ["Check again"],
      });
      await select(page, /Codex/);
      const codex = await notice(page);
      assert.equal(codex?.title, "Codex isn't signed in on this computer");
      assert.equal(codex?.code, "codex login");
      // Check again re-runs the client's own status; still signed out, still no sign-in started.
      await page.locator(".chn-modes").getByRole("button", { name: "Check again" }).click();
      await page.getByRole("radiogroup", { name: "AI client" }).waitFor({ timeout: 90_000 });
      expectNoLogin(await sys.calls());
    });

    await steps.step("free plan (Claude): 'Your Claude plan can't run Claude Code'", async () => {
      const t = await recheck(sys, SCENARIOS.freePlan);
      assert.match(t[0], /^Claude Code Plan can't run it/);
      assert.match(t[1], /^Codex Signed in .*Recommended/, "a ready client is recommended over one that can't run");
      await select(page, /Claude Code/);
      const n = await notice(page);
      assert.equal(n?.state, "plan_insufficient");
      assert.equal(n?.title, "Your Claude plan can't run Claude Code");
      assert.equal(n?.next, "Upgrade your plan, or switch to Codex.");
      assert.deepEqual(n?.actions, ["Plans at claude.ai", "Choose another AI"]);
      await page.locator(".chn-modes").getByRole("button", { name: "Choose another AI" }).click();
      assert.equal(await page.getByRole("radio", { name: /Codex/ }).isChecked(), true, "'Choose another AI' selects the next ready client");
    });

    await steps.step("old version: 'Update Claude Code to use it here'; Continue disabled", async () => {
      const t = await recheck(sys, SCENARIOS.oldVersion);
      assert.match(t[0], /^Claude Code Needs an update Version 2\.0\.14/);
      assert.match(t[1], /^Codex Needs an update Version 0\.120\.0/);
      await select(page, /Claude Code/);
      const n = await notice(page);
      assert.equal(n?.state, "installed");
      assert.equal(n?.title, "Update Claude Code to use it here");
      assert.equal(n?.next, "Update Claude Code, then check again. Or choose another AI.");
      await page.getByText("Instant mode is checked from version 2.1.283; update Claude Code to use it.").waitFor();
      assert.equal(await continueDisabled(), true, "an unsafe version can't be connected in instant mode");
      await select(page, /Codex/);
      await page.getByText("Instant mode is checked from version 0.156.1; update Codex to use it.").waitFor();
    });

    await steps.step("newer version missing a flag: the --help check refuses", async () => {
      const t = await recheck(sys, SCENARIOS.missingFlag);
      assert.match(t[0], /^Claude Code Needs an update Version 2\.1\.300/);
      await select(page, /Claude Code/);
      await page.getByText("This version doesn't offer --safe-mode, so the app can't keep your own settings out of its runs.").waitFor();
      await select(page, /Codex/);
      await page.getByText("This version doesn't offer --ignore-rules, so the app can't keep your own settings out of its runs.").waitFor();
      assert.equal(await continueDisabled(), true);
    });

    await steps.step("not installed: tile disabled, 'How to install Codex'", async () => {
      const t = await recheck(sys, SCENARIOS.codexMissing);
      assert.match(t[1], /^Codex Not installed How to install/);
      assert.equal(await page.getByRole("radio", { name: /Codex/ }).isDisabled(), true);
      await page.getByRole("button", { name: "How to install Codex (opens in your browser)" }).waitFor();
      assert.match(t[0], /^Claude Code Signed in · Max/);
    });

    await steps.step("pro plan, newer version: 'Signed in · Pro'", async () => {
      const t = await recheck(sys, SCENARIOS.signedInPro);
      assert.match(t[0], /^Claude Code Signed in · Pro Version 2\.1\.290 Recommended/);
      assert.match(t[1], /^Codex Signed in Version 0\.157\.0/);
      assert.equal(await notice(page), null);
      expectNoLogin(await sys.calls());
    });

    await steps.step("finish onboarding with Claude Code; the sample course from Home", async () => {
      await sys.setScenario(SCENARIOS.signedIn);
      await connectInstant(page, "Claude Code", /Signed in with Max\./);
      await passAppearanceAndConnections(page);
      await heading(page, "Nothing connected yet").waitFor();
      await button(page, "Open workspace").click();
      await page.getByRole("button", { name: "Load sample course" }).first().click();
      await page.getByText("Synthetic sample").first().waitFor({ timeout: 30_000 });
      courseId = (await execute(page, { type: "snapshot" })).snapshot.resources.find((r: any) => r.kind === "assignment").courseId;
      await allowCourseText(page, "claude");
    });

    const runs = async () => (await sys.calls()).filter((c) => c.kind === "run" || c.kind === "ask").length;
    const cards = async () => (await execute(page, { type: "pack", pack: "cards", scope: { courseId } })).pack;
    const failsWith = async (scenario: Scenario, message: string, sent: boolean) => {
      await sys.setScenario(scenario);
      const before = await runs();
      const result = await cards();
      assert.equal(result.status, "failed", `${result.status}: ${result.message}`);
      assert.equal(result.message, message);
      assert.deepEqual(result.tokens, { in: 0, cached: 0, out: 0 });
      if (sent) assert.ok((await runs()) > before, "the client was asked");
      else assert.equal(await runs(), before, "refused before anything was sent");
      return result;
    };

    await steps.step("Claude at run time: usage limit, model unavailable, offline", async () => {
      usageLimitResult = await failsWith(SCENARIOS.usageLimit, "Your AI plan's usage limit was reached. Try again later; background work is paused.", true);
      await failsWith(SCENARIOS.modelUnavailable, "The model this task asked for isn't available on your AI plan.", true);
      await failsWith(SCENARIOS.offline, "Your AI service couldn't be reached. Check your internet connection.", true);
    });

    await steps.step("Claude before a run: signed out and a free plan are refused, nothing sent", async () => {
      await failsWith(SCENARIOS.signedOut, "Your AI client isn't signed in. Sign in with the provider's own flow, then try again.", false);
      await failsWith(SCENARIOS.freePlan, "Your AI plan can't run this client. Upgrade the plan, add an API key, or switch to another AI.", false);
    });

    await steps.step("Codex at run time: free account, usage limit, model unavailable, offline", async () => {
      await execute(page, { type: "consent", value: { action: "grant", recipient: "codex", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
      await page.evaluate(() => (window as any).magic.clients.choose("codex"));
      await allowCourseText(page, "codex");
      await failsWith(SCENARIOS.freePlan, "Your AI plan can't run this client. Upgrade the plan, add an API key, or switch to another AI.", true);
      usageLimitResult = await failsWith(SCENARIOS.usageLimit, "Your AI plan's usage limit was reached. Try again later; background work is paused.", true);
      await failsWith(SCENARIOS.modelUnavailable, "The model this task asked for isn't available on your AI plan.", true);
      await failsWith(SCENARIOS.offline, "Your AI service couldn't be reached. Check your internet connection.", true);
    });

    await steps.step("recovered: signed in again, the same request succeeds", async () => {
      await sys.setScenario(SCENARIOS.signedIn);
      const result = await cards();
      assert.equal(result.status, "done", `${result.status}: ${result.message}`);
      assert.ok(result.counts.accepted > 0);
      expectNoLogin(await sys.calls());
    });
  } finally {
    const { trace } = await sys.close();
    await steps.report(sys.artifacts);
    console.log(`  trace: ${trace}`);
  }
});

// Known gap: the runner keeps the reset time the client states (RunnerError.resetsAt, and the
// health notice can show it), but the pack result carries only the generic student message, and no
// screen shows run-time health, so the student isn't told when the limit resets. Drop `todo` once
// the reset time reaches the student.
test(
  "Run-time usage limit: the reset time Claude Code stated reaches the student",
  { todo: "known gap: PackRunResult carries only studentMessage; resetsAt ('3pm (America/Chicago)') is dropped" },
  () => {
    assert.ok(usageLimitResult, "the health run reached the usage-limit case");
    assert.match(JSON.stringify(usageLimitResult), /3pm/, "the stated reset time");
  },
);
