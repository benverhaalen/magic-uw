/**
 * Tier 1, known failing: "Load sample course" on onboarding's last step.
 *
 * Found by the journey (2026-09-27): `loadSample()` in Onboarding.tsx always calls
 * setStep("client"), right for the Agreement and UW steps but not for the last one. Back on "Your
 * AI", ClientStep remounts with `mode` null, and ConnectClient's fallback (`mode ?? "isolated"`)
 * can save the separate-profile mode for a student who chose instant. Runs then use the app's own
 * profile without --safe-mode, and with a real client that profile is signed out, so the app opens
 * its own sign-in terminal. The first test records what happens (it must pass); each `todo` test
 * states one correct behaviour and reports its failure without failing the run. Drop `todo` once
 * Onboarding.tsx is fixed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchFreshSystem, type FakeCall } from "./harness/fresh-system";
import { SCENARIOS } from "./harness/scenarios";
import { createSteps } from "./harness/steps";
import { agree, button, connectInstant, heading, passAppearanceAndConnections, savedModes, skipUw, tiles } from "./harness/onboarding";
import { expectNoLogin } from "./harness/expect-calls";

let observed: { stayed: boolean; modes: Record<string, string>; calls: FakeCall[] } | null = null;

test("Onboarding, last step: load the sample course and record what happens", { timeout: 150_000 }, async () => {
  const sys = await launchFreshSystem({ name: "onboarding-sample", scenario: SCENARIOS.signedIn });
  const { page } = sys;
  const steps = createSteps("onboarding-sample", { onFail: () => page.locator("body").innerText() });
  try {
    await steps.step("onboarding to the last step with Claude Code in instant mode", async () => {
      await agree(page);
      await skipUw(page);
      await tiles(page);
      await connectInstant(page, "Claude Code", /Signed in with Max\./);
      await passAppearanceAndConnections(page);
      await heading(page, "Nothing connected yet").waitFor();
      assert.deepEqual(await savedModes(sys.userData), { claude: "instant" });
    });
    await steps.step("'Load sample course' on the last step; let it settle", async () => {
      await button(page, "Load sample course").click();
      await page.locator(".onb-bar .onb-preview-flag", { hasText: "Synthetic sample" }).waitFor({ timeout: 30_000 });
      // Let the step, the client check and any saved mode settle before reading them.
      await page.waitForTimeout(4000);
      observed = {
        stayed: await heading(page, /Your workspace is (ready|partly ready)|Reading your courses/).isVisible(),
        modes: await savedModes(sys.userData),
        calls: await sys.calls(),
      };
      console.log(`  observed: stayed on the last step: ${observed.stayed}; saved modes: ${JSON.stringify(observed.modes)}`);
    });
  } finally {
    await sys.close();
    await steps.report(sys.artifacts);
  }
});

const todo = "known bug: Onboarding.tsx loadSample() returns to 'Your AI' from the last step";
test("…the student stays on the last step", { todo }, () => {
  assert.equal(observed?.stayed, true, "sent back to 'Your AI'");
});
test("…the saved connection mode stays instant", { todo: `${todo}; ConnectClient's \`mode ?? "isolated"\` fallback can save isolated` }, () => {
  assert.deepEqual(observed?.modes, { claude: "instant" });
});
test("…no client sign-in is started", () => {
  assert.ok(observed, "the first test ran");
  expectNoLogin(observed!.calls);
});
