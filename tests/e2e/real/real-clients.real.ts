/**
 * Tier 2 (local only, on request, cost-capped): the operator's own signed-in Claude Code and Codex,
 * driven by the fresh app as a student would. Run with `pnpm test:e2e:real`. Never in CI.
 *
 * Limits, enforced by the cost guard (tests/e2e/real/guard.mjs) in front of each real client:
 * - the cheapest tier, passed explicitly: Claude `--model haiku` (MAGIC_E2E_CLAUDE_MODEL to change);
 *   Codex the CLI's default model at low reasoning effort (MAGIC_E2E_CODEX_MODEL to name one);
 * - at most 2 generation calls per client (the journey makes 1 each; the second leaves room for
 *   the pack runner's one retry; its escalation to the strong model is refused);
 * - at most 48,000 characters of prompt per call (about 12k tokens); a larger call is refused
 *   before it is sent. The synthetic course is about 2k tokens.
 * The operator's ~/.claude, ~/.claude.json and ~/.codex are listed before and after by name, size
 * and modification time only; no file there is opened.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCli } from "@magic/runner";
import { CONSENT_DISCLOSURE_VERSION } from "../../../packages/domain/src/index";
import { launchFreshSystem, type RealClients } from "../harness/fresh-system";
import { createSteps } from "../harness/steps";
import { diffHome, snapshotHome } from "../harness/home-snapshot";
import { agree, allowCourseText, button, execute, heading, passAppearanceAndConnections, skipUw, tiles } from "../harness/onboarding";

const CAP_CHARS = 48_000;
const MAX_CALLS = 2;

/** About 2k tokens of synthetic course text (no real coursework). */
const PARAGRAPHS = [
  "An argument begins with a claim: a statement that the writer defends and that a reasonable reader could dispute.",
  "Evidence is the material a writer offers in support of a claim, such as data, quotations from sources, or observations.",
  "A warrant explains why the evidence supports the claim; readers who do not share the warrant will not be persuaded.",
  "A counterclaim is a position that opposes the writer's claim, and a strong essay states it fairly before answering it.",
  "A rebuttal answers a counterclaim by showing that it is mistaken, incomplete, or outweighed by other evidence.",
  "Synthesis combines two or more sources so that together they support a point that neither makes on its own.",
  "A thesis statement names the essay's main claim and previews the reasons that the body paragraphs develop.",
  "Paraphrase restates a source's idea in new words and sentence structure, and it still requires a citation.",
];
const COURSE_TEXT = Array.from({ length: 4 }, (_, i) => PARAGRAPHS.map((p) => `${p} (Section ${i + 1}.)`).join(" ")).join("\n\n");
const COURSE = { courseId: "real-101", courseName: "Argument 101 · Synthetic" };
function tinyCourse() {
  const base = (externalId: string, kind: string, title: string, text = "") => ({
    ...COURSE,
    text,
    deadlines: [] as unknown[],
    points: null,
    submitted: null,
    policy: { mode: "coaching", evidence: "Synthetic course: AI may explain concepts and quiz the student." },
    externalId,
    kind,
    title,
    url: `https://example.org/real-101/${externalId}`,
  });
  return {
    source: { id: "e2e-real-course", label: "Synthetic course", kind: "fixture", accountScope: "synthetic", courseId: COURSE.courseId, scope: "assignments" },
    observedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    complete: true,
    status: "ok",
    resources: [base("course", "course", COURSE.courseName), base("reading-1", "material", "Reading: parts of an argument", COURSE_TEXT)],
  };
}

interface GuardEntry {
  client: "claude" | "codex";
  kind: string;
  ms?: number;
  usage?: Record<string, number> | null;
  model?: string | null;
  reason?: string;
  chars?: number;
}

test("Tier 2: the operator's real Claude Code and Codex, cost-capped", { timeout: 600_000 }, async (t) => {
  const claude = resolveCli("claude");
  const codex = resolveCli("codex");
  if (!claude && !codex) return t.skip("neither claude nor codex is installed here");
  const real: RealClients = {
    claude: claude ? { ...claude, model: process.env.MAGIC_E2E_CLAUDE_MODEL || "haiku" } : null,
    codex: codex ? { ...codex, model: process.env.MAGIC_E2E_CODEX_MODEL || "", effort: "low" } : null,
    capChars: CAP_CHARS,
    maxCalls: MAX_CALLS,
  };
  const home = homedir();
  const before = await snapshotHome(home);
  const sys = await launchFreshSystem({ name: "real-clients", real });
  const { page } = sys;
  const steps = createSteps("real clients", { onFail: () => page.locator("body").innerText() });
  const results: Record<string, { status: string; message: string; accepted: number; dropped: number; tokens: unknown; ms: number } | { skipped: string }> = {};
  try {
    let t0: string[] = [];
    await steps.step("onboarding: agreement, UW skipped (headless), the real clients' tiles", async () => {
      await agree(page);
      await skipUw(page);
      t0 = await tiles(page);
      console.log(`  tiles: ${t0.join(" | ")}`);
    });

    await steps.step("connect the recommended client (instant), finish onboarding", async () => {
      await button(page, "Continue").click();
      const name = t0[0].startsWith("Claude Code") && /Recommended/.test(t0[0]) ? "Claude Code" : "Codex";
      await heading(page, `Connect ${name}`).waitFor();
      await button(page, "Agree and continue").click();
      await heading(page, `Connect your ${name}`).waitFor();
      await page.locator("p.chn-line, [data-health-state]").first().waitFor({ timeout: 60_000 });
      const ready = await page.locator("p.chn-line").count();
      assert.ok(ready, `the client isn't ready: ${await page.locator("[data-health-state]").first().innerText().catch(() => "?")}`);
      await button(page, "Continue").click();
      await passAppearanceAndConnections(page);
      await heading(page, "Nothing connected yet").waitFor();
      await button(page, "Open workspace").click();
      const imported = await execute(page, { type: "import", batch: tinyCourse() });
      assert.ok(imported.snapshot.resources.some((r: any) => r.courseId === COURSE.courseId));
    });

    for (const id of ["claude", "codex"] as const) {
      await steps.step(`${id}: cards from the synthetic course`, async () => {
        const h = await page.evaluate((c) => (window as any).magic.clients.health(c), id);
        if (!real[id] || h.state !== "ok") {
          results[id] = { skipped: real[id] ? `health ${h.state}` : "not installed" };
          return;
        }
        await execute(page, { type: "consent", value: { action: "grant", recipient: id, disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
        await page.evaluate((c) => (window as any).magic.clients.choose(c), id);
        await allowCourseText(page, id);
        const started = performance.now();
        const pack = (await execute(page, { type: "pack", pack: "cards", scope: { courseId: COURSE.courseId } })).pack;
        results[id] = {
          status: pack.status,
          message: pack.message,
          accepted: pack.counts?.accepted ?? 0,
          dropped: pack.counts?.dropped ?? 0,
          tokens: pack.tokens,
          ms: Math.round(performance.now() - started),
        };
      });
    }
  } finally {
    await sys.close();
    const after = await snapshotHome(home);
    const diff = diffHome(before, after);
    const guardLog = join(sys.artifacts, "guard.jsonl");
    const entries: GuardEntry[] = existsSync(guardLog) ? (await readFile(guardLog, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    await steps.report(sys.artifacts);
    console.log("\nCost summary (tokens as each client reported them)");
    for (const id of ["claude", "codex"] as const) {
      const mine = entries.filter((e) => e.client === id);
      const done = mine.filter((e) => e.kind === "result");
      const sum = (k: string) => done.reduce((n, e) => n + (e.usage?.[k] ?? 0), 0);
      console.log(
        `  ${id}: ${mine.filter((e) => e.kind === "call").length} call(s), ${mine.filter((e) => e.kind === "refused").length} refused by the guard;` +
          ` input ${sum("input_tokens")}, cache read ${sum("cache_read_input_tokens") + sum("cached_input_tokens")}, cache write ${sum("cache_creation_input_tokens")}, output ${sum("output_tokens")};` +
          ` model ${[...new Set(done.map((e) => e.model).filter(Boolean))].join(", ") || real[id]?.model || "CLI default"}; latency ${done.map((e) => e.ms).join(", ") || "-"} ms`,
      );
      console.log(`    app result: ${JSON.stringify(results[id] ?? "not reached")}`);
      for (const e of mine.filter((x) => x.kind === "refused" || x.kind === "refused_login")) console.log(`    guard: ${e.kind} ${e.reason ?? ""}`);
    }
    console.log(`  ~/.claude, ~/.claude.json, ~/.codex (names, sizes, times only): ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed`);
    for (const p of [...diff.added.map((p) => `+ ${p}`), ...diff.changed.map((p) => `~ ${p}`), ...diff.removed.map((p) => `- ${p}`)].slice(0, 40)) console.log(`    ${p}`);
    console.log(`  artifacts: ${sys.artifacts}`);
  }
});
