// Still frames of the real app on the synthetic sample courses, for the product video.
// Launches the built Electron app headless (no window is shown and no sign-in window can open) with a
// throwaway user-data folder, loads "Load sample course", marks setup done, and saves 1920×1080 PNGs
// through webContents.capturePage.
//
// Frames 5 and 7 need stored study items. Between two launches this script writes the sample's own
// synthetic practice quiz and cards into the throwaway workspace through the real study-prep pipeline
// (quote checks, item store, links), answered by the repo's fake CLI with fixed synthetic output
// labelled model "synthetic-sample". They are sample items, not live model output; the product's
// live path is unchanged. The flashcard set is then completed through the real review UI.
//
// Run after `pnpm build`: pnpm exec tsx scripts/capture-frames.ts [outDir]
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electronPath from "electron";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { captureBatchSchema, studyPrepPackName } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "../packages/domain/src/index";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import sample from "../fixtures/sample-courses.json";

const REPO = resolve(import.meta.dirname, "..");
const OUT = resolve(process.argv[2] ?? join(REPO, ".data", "frames")); // .data is gitignored
const W = 1920, H = 1080;
const root = await mkdtemp(join(tmpdir(), "magic-frames-"));
const data = join(root, "user-data");
await mkdir(data, { recursive: true });
await mkdir(OUT, { recursive: true });

async function execute<T = any>(page: Page, command: unknown): Promise<T> {
  return page.evaluate((c) => (window as any).magic.execute(c), command) as Promise<T>;
}
async function capture(app: ElectronApplication, name: string, settleMs = 1500): Promise<void> {
  await new Promise((r) => setTimeout(r, settleMs)); // let entrance motion finish
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())!;
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  });
  await writeFile(join(OUT, name), Buffer.from(png, "base64"));
  console.log(`saved ${join(OUT, name)}`);
}
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [join(REPO, "apps", "desktop")],
    cwd: REPO,
    env: { ...process.env, MAGIC_HEADLESS: "1", MAGIC_USER_DATA: data, MAGIC_GATEWAY_URL: "" } as Record<string, string>,
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.W, size.H), { W, H });
  await page.setViewportSize({ width: W, height: H }).catch(() => undefined);
  await page.waitForFunction(() => Boolean((window as any).magic?.execute), undefined, { timeout: 30_000 });
  return { app, page };
}
async function openStudyItem(page: Page, title: string): Promise<void> {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Study & Learn", exact: true }).click();
  const row = page.locator("[data-study-row]", { hasText: title }).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await page.getByRole("toolbar", { name: "Study actions" }).waitFor({ timeout: 20_000 });
}
const action = (page: Page, label: RegExp) => page.getByRole("toolbar", { name: "Study actions" }).getByRole("button", { name: label });

// ---- Launch 1: setup, Home and the assignment ----
{
  const { app, page } = await launch();
  try {
    await execute(page, { type: "consent", value: { action: "grant", recipient: "uw", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
    await execute(page, { type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
    const loaded = await execute(page, { type: "fixture" });
    console.log(`sample loaded: ${loaded.snapshot.resources.length} records, fixtureMode ${loaded.snapshot.fixtureMode}`);
    await execute(page, { type: "privacy", value: { ...loaded.snapshot.privacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true } });
    await page.evaluate(() => localStorage.setItem("magic.onboarding.v2", JSON.stringify({
      started: true, uw: "skipped", client: "claude", clientConnected: true, coursesDone: true, appearanceDone: true, connectionsDone: true, done: true,
    })));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Frame 2: Home with the Daily Brief.
    await page.getByRole("heading", { name: "Daily Brief" }).waitFor({ timeout: 30_000 });
    const open = page.getByRole("button", { name: /Open assignment/ }).first();
    await open.waitFor({ timeout: 15_000 });
    await capture(app, "frame2-home.png", 2500);

    // Frame 4: one click on the brief's assignment opens it with its linked sources.
    await open.click();
    await page.getByText("Lecture 7 slides: Mathematical induction").first().waitFor({ timeout: 15_000 });
    await capture(app, "frame4-assignment.png", 2500);
  } catch (error) {
    await capture(app, "failure-launch1.png", 0).catch(() => undefined);
    throw error;
  } finally {
    await app.close().catch(() => undefined);
  }
}

// ---- Between launches: the sample's own synthetic quiz and cards, through the real pipeline ----
{
  const store = createStore(join(data, "workspace.sqlite"));
  try {
    const bin = join(root, "fake-cli");
    await mkdir(join(bin, "work"), { recursive: true });
    const byExt = (e: string) => store.resources().find((r) => r.externalId === e && !r.deleted)!;
    /** The stored passage that holds this exact quote, as the pack's source id. */
    const at = (ext: string, quote: string) => {
      const r = byExt(ext);
      for (const p of store.passages(r.id)) if (store.passage(p.pid)?.text.includes(quote)) return `p${p.pid}`;
      throw new Error(`no passage in ${ext} holds: ${quote}`);
    };
    const L5 = "Lecture 5: Propositional logic", L6 = "Lecture 6: Predicates and quantifiers", L7 = "Lecture 7: Mathematical induction", R4 = "Reading 4: Strong induction and well-ordering";
    const q = (kind: "mc" | "tf", stem: string, options: [string, boolean][], statementIsTrue: boolean | null, explanation: string, topic: string, section: string, ext: string, quote: string) =>
      ({ kind, stem, options: options.map(([text, correct]) => ({ text, correct })), statementIsTrue, numeric: null, explanation, topics: [topic], section, bloom: "understand", sourceId: at(ext, quote), quote });
    const quiz = { items: [
      q("mc", "Which statement is logically equivalent to $p \\to q$?", [["$\\neg q \\to \\neg p$", true], ["$q \\to p$", false], ["$\\neg p \\to \\neg q$", false], ["$p \\wedge \\neg q$", false]], null,
        "The contrapositive $\\neg q \\to \\neg p$ is equivalent to $p \\to q$; the converse and the inverse are not.", "Contrapositive", L5, "math240-l5",
        "The contrapositive of p -> q is not q -> not p, and it is logically equivalent to p -> q."),
      q("tf", "A single counterexample shows that a universal statement is false.", [], true, "One $x$ with $\\neg P(x)$ makes $\\forall x\\, P(x)$ false.", "Universal quantifier", L6, "math240-l6",
        "A single counterexample shows that a universal statement is false."),
      q("mc", "What is the negation of $\\forall x\\, P(x)$?", [["$\\exists x\\, \\neg P(x)$", true], ["$\\forall x\\, \\neg P(x)$", false], ["$\\exists x\\, P(x)$", false], ["$\\neg \\exists x\\, P(x)$", false]], null,
        "Negating a universal statement gives an existential one with the predicate negated.", "Negating quantifiers", L6, "math240-l6",
        "The negation of \"for all x, P(x)\" is \"there exists x such that not P(x)\"."),
      q("tf", "The conditional $p \\to q$ is false when $p$ is false.", [], false, "It is false only when $p$ is true and $q$ is false; with $p$ false it is vacuously true.", "Conditionals", L5, "math240-l5",
        "The conditional p -> q is false only when p is true and q is false."),
      q("mc", "By De Morgan's laws, $\\neg(p \\wedge q)$ is equivalent to:", [["$\\neg p \\vee \\neg q$", true], ["$\\neg p \\wedge \\neg q$", false], ["$p \\vee q$", false], ["$\\neg p \\to q$", false]], null,
        "De Morgan: the negation of a conjunction is the disjunction of the negations.", "De Morgan's laws", L5, "math240-l5",
        "De Morgan's laws state that not (p and q) is equivalent to (not p) or (not q)"),
    ] };
    const card = (front: string, back: string, topic: string, section: string, ext: string, quote: string) => ({ kind: "term", front, back, topics: [topic], section, sourceId: at(ext, quote), quote });
    const cards = { cards: [
      card("Inductive hypothesis", "The assumption that $P(k)$ is true, used to prove $P(k+1)$", "Mathematical induction", L7, "math240-l7-slides", "The assumption that P(k) is true is called the inductive hypothesis."),
      card("Two parts of an induction proof", "The base case $P(1)$ and the inductive step $P(k) \\Rightarrow P(k+1)$", "Mathematical induction", L7, "math240-l7-slides", "prove the base case P(1) and the inductive step"),
      card("Strong induction", "Assume $P(1), \\dots, P(k)$ all hold, then prove $P(k+1)$", "Strong induction", R4, "math240-reading4", "In strong induction the inductive step assumes P(1), P(2), ..., P(k) are all true and proves P(k + 1)."),
      card("When to use strong induction", "When case $k+1$ depends on a case smaller than $k$", "Strong induction", R4, "math240-reading4", "Strong induction is useful when the case k + 1 depends on a case smaller than k."),
      card("Well-ordering principle", "Every nonempty set of nonnegative integers has a least element", "Well-ordering", R4, "math240-reading4", "Every nonempty set of nonnegative integers has a least element."),
      card("Contrapositive of $p \\to q$", "$\\neg q \\to \\neg p$, equivalent to $p \\to q$", "Contrapositive", L5, "math240-l5", "The contrapositive of p -> q is not q -> not p"),
    ] };
    const blank = { guide: null, quiz: null, cards: null, exam: null, problems: null, outline: null };
    const responses = [{ output: { ...blank, quiz }, model: "synthetic-sample" }, { output: { ...blank, cards }, model: "synthetic-sample" }];
    const fake: CliCommand = { file: process.execPath, prefixArgs: [join(REPO, "tests", "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
    const env = { FAKE_CLI_STATE: join(bin, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
    const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir: join(bin, "work"), env }), { dailyBackgroundTokens: 1_000_000 }).runner;
    const handler = createPackHandler({ store, runner: () => runner });
    const core = createCore(store, { fixture: sample.map((b) => captureBatchSchema.parse(b)), seams: { pack: handler.pack } });
    const quiz2 = byExt("math240-quiz2"), mid1 = byExt("math240-midterm1");
    for (const [item, kinds] of [[quiz2, ["quiz"]], [mid1, ["cards"]]] as const) {
      const r = (await core.execute({ type: "pack", pack: studyPrepPackName([...kinds]), scope: { courseId: item.courseId, assessmentId: item.id } })).pack as { status: string; message: string; counts?: unknown; drops?: unknown };
      console.log(`sample ${kinds.join("+")} for ${item.title}: ${r.status} ${r.message} ${JSON.stringify(r.counts)} ${JSON.stringify(r.drops ?? [])}`);
      if (r.status !== "done") throw new Error(`seeding ${item.title} failed`);
    }
    await core.close?.();
  } finally {
    store.close();
  }
}

// ---- Launch 2: Study & Learn, a practice question answered right, a completed card set ----
{
  const { app, page } = await launch();
  try {
    await page.getByRole("heading", { name: "Daily Brief" }).waitFor({ timeout: 30_000 });

    // Frame 6: Midterm 1's study space with the practice-exam control.
    // (Clicking an unmade action starts a live generation, so the control is shown, not pressed.)
    await openStudyItem(page, "Midterm 1");
    await action(page, /Practice exam/).waitFor({ timeout: 15_000 });
    await capture(app, "frame6-study.png", 3500);
    await page.locator("dialog.sp-dialog .sp-dialog-close").click();
    await page.locator("dialog.sp-dialog[open]").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);

    // Frame 7: Quiz 2's practice quiz, first question answered correctly.
    await openStudyItem(page, "Quiz 2: Logic and quantifiers");
    await action(page, /Practice quiz/).click();
    await page.getByLabel("Practice quiz").waitFor({ timeout: 15_000 });
    const stem = (await page.locator(".sp-stem").first().innerText()).trim();
    const right: Record<string, string> = { "equivalent to": "¬q", "negation of": "∃", "De Morgan": "∨" };
    const pick = page.locator(".sp-option").filter({ hasText: Object.entries(right).find(([k]) => stem.includes(k))?.[1] ?? "¬q" }).first();
    if (await page.locator(".sp-option").count()) await pick.click();
    else await page.locator(".sp-option, label").filter({ hasText: /True/ }).first().click();
    await page.getByRole("button", { name: /Check/ }).click();
    await page.locator(".sp-feedback").waitFor({ timeout: 10_000 });
    console.log(`frame 7 feedback: ${(await page.locator(".sp-feedback").innerText()).slice(0, 80)}`);
    await capture(app, "frame7-test-correct.png", 1200);
    await page.locator("dialog.sp-dialog .sp-dialog-close").click();
    await page.locator("dialog.sp-dialog[open]").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);

    // Frame 5: Midterm 1's cards reviewed to the end through the real review UI.
    await openStudyItem(page, "Midterm 1");
    await action(page, /Cards/).click();
    await page.getByRole("button", { name: /^Review/ }).first().click();
    await page.waitForTimeout(1500);
    const refused = page.locator("dialog.sp-dialog .sp-error");
    if (await refused.count()) {
      // Known gap on this base: the item space sends material anchors that the desktop's study-context
      // resolver rejects, so a review can't start. Report it instead of saving a misleading frame.
      console.error(`frame 5 blocked: the review refused to start: ${await refused.first().innerText()}`);
      process.exitCode = 1;
    } else {
      for (let i = 0; i < 20; i++) {
        if (await page.getByText(/^Done: \d+ reviewed\./).count()) break;
        await page.locator(".sp-flashcard").click();
        await page.getByRole("button", { name: /^Good/ }).click();
        await page.waitForTimeout(400);
      }
      await page.getByText(/^Done: \d+ reviewed\./).waitFor({ timeout: 10_000 });
      await capture(app, "frame-notecards-complete.png", 1200);
    }
  } catch (error) {
    await capture(app, "failure-launch2.png", 0).catch(() => undefined);
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
