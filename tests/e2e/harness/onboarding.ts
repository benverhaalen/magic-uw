/** Onboarding steps a student takes, shared by the Tier 1 and Tier 2 flows. Each reads back what it set. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { name, level: 1 });
export const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });

/** The renderer's own bridge: renderer → preload → main → worker, as a control would call it. */
export async function execute<T = any>(page: Page, command: unknown): Promise<T> {
  return page.evaluate((c) => (window as any).magic.execute(c), command) as Promise<T>;
}

export async function agree(page: Page): Promise<void> {
  const box = page.getByLabel(/I agree: My Magic UW may read UW/);
  await box.waitFor({ timeout: 30_000 });
  assert.equal(await box.isChecked(), false, "unticked on a fresh system");
  assert.equal(await button(page, "Continue to UW sign-in").isDisabled(), true, "Continue waits for the checkbox");
  await box.check();
  assert.equal(await box.isChecked(), true);
  await button(page, "Continue to UW sign-in").click();
}

/** Headless: the app refuses to open UW's page (Duo is never automated) and says so; the student skips. */
export async function skipUw(page: Page): Promise<void> {
  await heading(page, "Sign in to UW").waitFor();
  await page.getByText("Sign-in requires your interaction; headless mode will not open a window.").waitFor();
  await button(page, "Skip for now").click();
}

export async function tiles(page: Page): Promise<string[]> {
  await heading(page, "Choose your AI").waitFor();
  // Each client check runs the client several times; allow for a busy machine.
  await page.getByRole("radiogroup", { name: "AI client" }).waitFor({ timeout: 90_000 });
  return page.locator(".onb-tile").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
}

/** From "Choose your AI": the named client, instant mode, its provider agreement, ready. */
export async function connectInstant(page: Page, name: "Claude Code" | "Codex", expectReady: RegExp): Promise<void> {
  await page.getByRole("radio", { name: new RegExp(name) }).check();
  assert.equal(await page.getByLabel("Use a separate sign-in for My Magic UW").isChecked(), false, "instant mode");
  await button(page, "Continue").click();
  await heading(page, `Connect ${name}`).waitFor();
  await button(page, "Agree and continue").click();
  await heading(page, `Connect your ${name}`).waitFor();
  await page.locator("p.chn-line").getByText(expectReady).waitFor({ timeout: 30_000 });
  await button(page, "Continue").click();
}

export async function passAppearanceAndConnections(page: Page): Promise<void> {
  await heading(page, "Choose how it looks").waitFor();
  await button(page, "Continue").click();
  await heading(page, "Add other accounts").waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("Checking…"), undefined, { timeout: 15_000 });
  await button(page, "Skip for now").click();
}

/** The saved connection mode per client (the app's own file in its user data). */
export async function savedModes(userData: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(userData, "client-modes.json"), "utf8")).modes ?? {};
  } catch {
    return {};
  }
}

/** Selective sharing of course text with a provider, through the bridge (the journey drives the same fields in the UI). */
export async function allowCourseText(page: Page, provider: "claude" | "codex"): Promise<void> {
  const privacy = (await execute(page, { type: "snapshot" })).snapshot.privacy;
  await execute(page, { type: "privacy", value: { ...privacy, mode: "selective_cloud", hostedProvider: provider, shareCourseText: true } });
}
