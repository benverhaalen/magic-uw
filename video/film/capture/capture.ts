// Re-shoots every real-UI shot for the film from the app's own headless preview.
//
//   MAGIC_APP_DIR=<app checkout> npx tsx capture/capture.ts [--build]
//
// - Starts a fresh `scripts/preview.ts` server in MAGIC_APP_DIR (synthetic sample course,
//   temporary store, no school or AI connections) on a private port, then drives it with
//   headless Chromium. No window ever opens.
// - Walks the real onboarding, loads the sample course, then imports one more synthetic
//   course (Algorithms 301 · Sample) through the app's own `import` command, so the film
//   shows a reading-heavy and a CS-heavy course in the same app.
// - Writes 2x PNGs to assets/ui/ (git-ignored) and assets/ui/manifest.json listing every
//   shot as captured or missed. A missed shot is reported, never substituted.
// - The practice quiz and flashcards need a model to generate. The preview has none, so the
//   script feeds the real quiz/card components synthetic items (SYNTHETIC_QUIZ below) by
//   answering the study.prep read at the bridge. The components, layout and KaTeX are real;
//   the questions are ours and are labelled synthetic in STORYBOARD.md.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium, type Page, type Route } from "playwright";

const here = resolve(import.meta.dirname, "..");
const appDir = resolve(process.env.MAGIC_APP_DIR ?? join(here, "..", ".."));
const outDir = join(here, "assets", "ui");
const port = Number(process.env.CAPTURE_PORT ?? 4397);
const scale = Number(process.env.CAPTURE_SCALE ?? 2);
mkdirSync(outDir, { recursive: true });

type Shot = { file: string; ok: boolean; note: string };
const manifest: { app: string; appCommit: string; capturedAt: string; shots: Shot[] } = {
  app: appDir,
  appCommit: git(["rev-parse", "--short", "HEAD"]),
  capturedAt: new Date().toISOString(),
  shots: [],
};

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

if (process.argv.includes("--build") || !existsSync(join(appDir, "apps/desktop/dist/renderer/index.html"))) {
  console.log(`building the renderer in ${appDir}`);
  execFileSync("npx", ["tsx", "scripts/build.ts"], { cwd: appDir, stdio: "inherit", shell: true });
}

function startPreview(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((ok, fail) => {
    const child = spawn("npx", ["tsx", "scripts/preview.ts"], {
      cwd: appDir,
      shell: true,
      env: { ...process.env, MAGIC_PREVIEW_PORT: String(port), MAGIC_PREVIEW_LEARNING_FIXTURE: "1" },
      windowsHide: true,
    });
    const timer = setTimeout(() => fail(new Error("preview did not start in 60 s")), 60_000);
    child.stdout!.on("data", (d: Buffer) => {
      const m = /Local verification: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        ok({ child, url: m[1]! });
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (/EADDRINUSE/.test(String(d))) fail(new Error(`port ${port} in use; set CAPTURE_PORT`));
    });
  });
}

function stopPreview(child: ChildProcess) {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else child.kill("SIGTERM");
}

// ---------- synthetic second course (CS-heavy), dates relative to now ----------
const day = 86_400_000;
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * day);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const csCourse = "Algorithms 301 · Sample";
const cs = (externalId: string, kind: string, title: string, text: string, extra: Record<string, unknown> = {}) => ({
  externalId,
  kind,
  courseId: "sample-301",
  courseName: csCourse,
  title,
  url: `https://example.org/algorithms/${externalId}`,
  text,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Use AI to explain ideas; write your own proofs and code." },
  ...extra,
});
const due = (value: string, quote: string) => [{ value, kind: "due", quote, authority: "structured", scopeConfirmed: true }];
function csBatch() {
  const exam = at(5, 10);
  const pset = at(2, 23);
  return {
    source: {
      id: "sample-algorithms",
      label: "Algorithms sample · synthetic",
      kind: "fixture",
      accountScope: "synthetic",
      courseId: "sample-301",
      scope: "assignments",
    },
    observedAt: new Date().toISOString(),
    complete: true,
    status: "ok",
    resources: [
      cs("pset-4", "assignment", "Problem set 4: recurrences", "Solve the four recurrences using the Master theorem. Show each case. See Lecture 12. Late work loses 10% per day (syllabus).", {
        links: ["https://example.org/algorithms/lecture-12", "https://example.org/algorithms/syllabus"],
        deadlines: due(pset, `due_at: ${pset}`),
        points: 40,
        submitted: false,
      }),
      cs("exam-2", "assignment", "Exam 2", "Covers divide and conquer, recurrences and the Master theorem. Closed book; one page of notes.", {
        links: ["https://example.org/algorithms/lecture-12"],
        deadlines: due(exam, `Exam 2: ${exam}`),
        points: 100,
        submitted: false,
      }),
      cs("lecture-12", "material", "Lecture 12 · The Master theorem", "For T(n) = aT(n/b) + f(n): compare f(n) with n^(log_b a). Merge sort: T(n) = 2T(n/2) + n, so T(n) = Θ(n log n)."),
      cs("syllabus", "material", "Syllabus · Late work", "Late work loses 10% per day, up to three days. Exams cannot be taken late without a documented reason."),
      cs("announce-exam2", "message", "Exam 2 moved to Friday", "Exam 2 now takes place on Friday in the usual room. Coverage is unchanged."),
    ],
  };
}

// ---------- synthetic study material for the real quiz and card components ----------
const quote = (title: string, text: string) => ({ resourceId: null, title, url: null, quote: text, start: null, end: null });
const lec = "Lecture 12 · The Master theorem";
const QUIZ = [
  ["Which case of the Master theorem applies to $T(n) = 2T(n/2) + n$?", ["Case 1", "Case 2", "Case 3", "It does not apply"], "b"],
  ["What is $\\log_b a$ for $T(n) = 4T(n/2) + n$?", ["1", "2", "4", "$\\tfrac{1}{2}$"], "b"],
  ["Solve $T(n) = 8T(n/2) + n^2$.", ["$\\Theta(n^2)$", "$\\Theta(n^2 \\log n)$", "$\\Theta(n^3)$", "$\\Theta(n \\log n)$"], "c"],
  ["Merge sort's recurrence is $T(n) = 2T(n/2) + \\Theta(n)$. Its running time is", ["$\\Theta(n)$", "$\\Theta(n \\log n)$", "$\\Theta(n^2)$", "$\\Theta(\\log n)$"], "b"],
  ["Binary search: $T(n) = T(n/2) + \\Theta(1)$ gives", ["$\\Theta(1)$", "$\\Theta(\\log n)$", "$\\Theta(n)$", "$\\Theta(n \\log n)$"], "b"],
  ["For $T(n) = 3T(n/4) + n^2$, the dominant term is", ["$n^{\\log_4 3}$", "$n^2$", "$\\log n$", "$n^{3/4}$"], "b"],
  ["Case 1 needs $f(n) = O(n^{\\log_b a - \\epsilon})$ for some", ["$\\epsilon < 0$", "$\\epsilon > 0$", "$\\epsilon = 0$", "$\\epsilon = 1$ only"], "b"],
  ["Strassen: $T(n) = 7T(n/2) + \\Theta(n^2)$ gives", ["$\\Theta(n^3)$", "$\\Theta(n^{\\log_2 7})$", "$\\Theta(n^2)$", "$\\Theta(n^2 \\log n)$"], "b"],
  ["$T(n) = 2T(n/2) + n \\log n$ falls", ["in Case 1", "in Case 2", "in Case 3", "outside the basic theorem"], "d"],
  ["A recursion tree with $\\log_2 n$ levels doing $n$ work each totals", ["$n$", "$n \\log n$", "$n^2$", "$\\log n$"], "b"],
] as const;
const syntheticMaterials = (base: Record<string, any>) => {
  const now = new Date().toISOString();
  const quiz = QUIZ.map(([stem, opts, key], i) => ({
    itemId: `syn-q${i + 1}`,
    version: 1,
    kind: "mc",
    stem,
    options: opts.map((text, j) => ({ id: "abcd"[j]!, text })),
    key,
    unit: null,
    explanation: i === 5 ? "$f(n) = n^2$ grows faster than $n^{\\log_4 3} \\approx n^{0.79}$, so Case 3: $T(n) = \\Theta(n^2)$." : null,
    topics: ["Master theorem", "Recurrences"],
    source: quote(lec, "compare f(n) with n^(log_b a)"),
  }));
  const cards = [
    ["Master theorem, Case 2", "If $f(n) = \\Theta(n^{\\log_b a})$, then $T(n) = \\Theta(n^{\\log_b a} \\log n)$."],
    ["Merge sort recurrence", "$T(n) = 2T(n/2) + n = \\Theta(n \\log n)$"],
    ["Binary search recurrence", "$T(n) = T(n/2) + 1 = \\Theta(\\log n)$"],
  ].map(([front, back], i) => ({ cardId: `syn-c${i + 1}`, itemId: `syn-c${i + 1}`, kind: "card", front, back, topics: ["Master theorem"], due: null, source: quote(lec, "Merge sort: T(n) = 2T(n/2) + n") }));
  const mat = (kind: string, count: number, extra: Record<string, unknown>) => ({ kind, status: "ready", count, generatedAt: now, message: null, changed: [], guide: null, quiz: null, cards: null, ...extra });
  return {
    ...base,
    guide: base.guide ?? mat("guide", 0, {}),
    quiz: mat("quiz", quiz.length, { quiz }),
    cards: mat("cards", cards.length, { cards }),
  };
};
let injectStudy = false;
async function studyRoute(route: Route) {
  const req = route.request();
  let body: any = null;
  try {
    body = JSON.parse(req.postData() ?? "null");
  } catch {}
  if (!injectStudy || body?.view !== "study.prep") return route.continue();
  const res = await route.fetch();
  const json = await res.json();
  if (json?.status === "ok" && json.materials) json.materials = syntheticMaterials(json.materials);
  return route.fulfill({ response: res, json });
}

// ---------- shooting helpers ----------
const settle = (p: Page, ms = 900) => p.waitForTimeout(ms);
async function shoot(p: Page, file: string, note: string, clip?: { x: number; y: number; width: number; height: number }) {
  try {
    await p.screenshot({ path: join(outDir, file), ...(clip ? { clip } : {}) });
    manifest.shots.push({ file, ok: true, note });
    console.log(`  shot ${file}`);
  } catch (e) {
    manifest.shots.push({ file, ok: false, note: `${note} (missed: ${(e as Error).message.split("\n")[0]})` });
    console.log(`  MISSED ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
}
/** The box of the nearest ancestor of the first element matching `text` that is at least minH tall. */
async function panel(p: Page, file: string, note: string, text: string, minH = 200, pad = 16) {
  const box = await p.evaluate(
    ({ text, minH }) => {
      const all = [...document.querySelectorAll("h1,h2,h3,[aria-label],button,a,p,span")];
      const hit = all.find((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().startsWith(text));
      let el: Element | null = hit ?? null;
      while (el && el.getBoundingClientRect().height < minH) el = el.parentElement;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    { text, minH },
  );
  if (!box) {
    manifest.shots.push({ file, ok: false, note: `${note} (missed: no element starting "${text}")` });
    console.log(`  MISSED ${file}: no element "${text}"`);
    return;
  }
  const vw = 1920, vh = 1080;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  await shoot(p, file, note, { x, y, width: Math.min(vw - x, box.width + pad * 2), height: Math.min(vh - y, box.height + pad * 2) });
}
async function click(p: Page, name: string, role: "button" | "link" = "button", exact = true) {
  const l = p.getByRole(role, { name, exact });
  await l.first().click({ timeout: 8000 });
  await settle(p);
}

// ---------- the run ----------
const { child, url } = await startPreview();
console.log(`preview at ${url} (app ${manifest.appCommit})`);
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  await p.route("**/query", studyRoute);
  await p.goto(url);
  await settle(p, 1500);

  console.log("onboarding");
  await shoot(p, "onboard-agreement.png", "Real: first-run agreement (one checkbox), before sign-in");
  await p.getByText("Load sample course").click();
  await settle(p, 1800);
  await shoot(p, "onboard-choose-ai.png", "Real: Choose your AI (preview lists sample clients, labelled so on screen)");
  await panel(p, "panel-choose-ai.png", "Real: the detected-client cards", "Claude Code", 110, 24);
  for (let i = 0; i < 10; i++) {
    let clicked = "";
    for (const n of ["Continue", "Agree and continue", "Skip for now", "Open workspace"]) {
      const l = p.getByRole("button", { name: n, exact: true });
      if ((await l.count()) && (await l.first().isEnabled())) {
        const h = (await p.locator("h1").first().textContent())?.trim() ?? "";
        if (/^Connect your/.test(h)) await shoot(p, "onboard-connect-client.png", "Real: client connection step");
        await l.first().click();
        clicked = n;
        break;
      }
    }
    if (!clicked) break;
    await settle(p, 1100);
  }

  console.log("second synthetic course");
  const imported = await p.evaluate(async (batch) => {
    const r = await (window as any).magic.execute({ type: "import", batch });
    return r.message ?? "ok";
  }, csBatch());
  console.log(`  import: ${imported}`);
  await p.reload();
  await settle(p, 2500);

  console.log("home");
  await shoot(p, "home.png", "Real: Home with briefing, Upcoming, Study & Learn and the Today rail");
  await panel(p, "panel-upcoming.png", "Real: the ranked Upcoming list", "Upcoming", 240);
  await panel(p, "panel-today.png", "Real: Today rail with the day's agenda", "Today", 600);
  await panel(p, "panel-briefing.png", "Real: Briefing sentences", "Briefing", 120);

  console.log("item space");
  try {
    await click(p, "Details: Problem set 4: recurrences", "link");
  } catch {
    await click(p, "Details: Comparative analysis", "link");
  }
  await settle(p, 1200);
  await shoot(p, "item-space.png", "Real: an assignment's item space (instructions, related material, start work)");
  await panel(p, "panel-related.png", "Real: Related material links found by code", "Related material", 120);
  await panel(p, "panel-instructions.png", "Real: Instructions", "Instructions", 120);

  console.log("course page");
  await click(p, "Home");
  const courseBtn = p.getByRole("button", { name: csCourse, exact: true });
  if (await courseBtn.count()) await courseBtn.first().click();
  else await p.getByRole("button", { name: "Writing 101 · Sample", exact: true }).first().click();
  await settle(p, 2000);
  await shoot(p, "course-page.png", "Real: course page");
  await panel(p, "panel-study-prep.png", "Real: Study prep on the course page (zero-token overview)", "Study prep", 300);

  console.log("practice quiz (real component, synthetic items)");
  injectStudy = true;
  try {
    await p.locator(".sp-entry", { hasText: "Exam 2" }).first().click({ timeout: 8000 });
    await settle(p, 2000);
    await shoot(p, "study-space.png", "Real: the exam's study space (sources, zero-token overview, Studio)");
    const studio = p.getByRole("button", { name: /Practice quiz/ });
    console.log(`  studio buttons: ${(await p.getByRole("button").allTextContents()).filter((t) => /quiz|card|guide/i.test(t)).join(" / ")}`);
    await studio.first().click({ timeout: 8000 });
    await settle(p, 1500);
    await shoot(p, "quiz-open.png", "Real quiz component, synthetic items: question 1");
    const quizPanel = p.locator(".sp-quiz").first();
    for (let i = 0; i < 5; i++) {
      await p.getByRole("button", { name: "Next" }).first().click({ timeout: 3000 }).catch(async () => {
        await p.locator(".sp-option").nth(1).click();
        await p.getByRole("button", { name: /Check/ }).first().click();
        await p.getByRole("button", { name: "Next" }).first().click();
      });
      await settle(p, 300);
    }
    await shoot(p, "quiz-q6.png", "Real quiz component, synthetic items: question 6 with KaTeX");
    if (await quizPanel.count()) await quizPanel.screenshot({ path: join(outDir, "panel-quiz-q6.png") }).then(() => manifest.shots.push({ file: "panel-quiz-q6.png", ok: true, note: "Real quiz component: question 6 panel" }));
    await p.locator(".sp-option").nth(1).click();
    await p.getByRole("button", { name: /Check/ }).first().click();
    await settle(p, 700);
    await shoot(p, "quiz-q6-right.png", "Real quiz component: correct-answer feedback");
    if (await quizPanel.count()) await quizPanel.screenshot({ path: join(outDir, "panel-quiz-right.png") }).then(() => manifest.shots.push({ file: "panel-quiz-right.png", ok: true, note: "Real quiz component: feedback panel" }));
    // Answer the rest until the results screen shows.
    for (let i = 0; i < 24 && !(await p.locator(".sp-quiz-done").count()); i++) {
      const check = p.getByRole("button", { name: /Check/ });
      if ((await check.count()) && (await check.first().isVisible())) {
        await p.locator(".sp-option").nth(1).click();
        await check.first().click();
      } else await p.getByRole("button", { name: /^(Next|Finish)/ }).first().click();
      await settle(p, 250);
    }
    await shoot(p, "quiz-results-full.png", "Real quiz component: results screen (full window)");
    const done = p.locator(".sp-quiz-done").first();
    if (await done.count()) await done.screenshot({ path: join(outDir, "panel-quiz-results.png") }).then(() => manifest.shots.push({ file: "panel-quiz-results.png", ok: true, note: "Real quiz component: results panel" }));
    else manifest.shots.push({ file: "panel-quiz-results.png", ok: false, note: "results screen not reached" });
  } catch (e) {
    manifest.shots.push({ file: "quiz-*.png", ok: false, note: `practice quiz not reachable: ${(e as Error).message.split("\n")[0]}` });
    console.log(`  MISSED quiz: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    await p.getByRole("button", { name: /Flashcards/ }).first().click({ timeout: 6000 });
    await settle(p, 1200);
    await shoot(p, "cards-front.png", "Real flashcard component, synthetic card: front");
    await p.locator(".sp-card, [class*=card]").first().click({ timeout: 3000 }).catch(() => p.keyboard.press("Space"));
    await settle(p, 900);
    await shoot(p, "cards-back.png", "Real flashcard component, synthetic card: back");
  } catch (e) {
    manifest.shots.push({ file: "cards-*.png", ok: false, note: `flashcards not reachable: ${(e as Error).message.split("\n")[0]}` });
  }
  injectStudy = false;

  console.log("calendar");
  await p.keyboard.press("Escape");
  await settle(p, 500);
  if (await p.locator("dialog[open]").count()) await p.locator("dialog[open] button[aria-label*=lose i], dialog[open] .sp-close").first().click().catch(() => {});
  await click(p, "Calendar");
  await settle(p, 1500);
  await shoot(p, "calendar.png", "Real: Calendar, this week");
  const nextWeek = p.getByRole("button", { name: /next/i });
  if (await nextWeek.count()) {
    await nextWeek.first().click();
    await settle(p, 1200);
    await shoot(p, "calendar-next.png", "Real: Calendar, next week (problem set and Exam 2)");
  } else manifest.shots.push({ file: "calendar-next.png", ok: false, note: "no next-week control found" });
} finally {
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await browser.close();
  stopPreview(child);
}
const missed = manifest.shots.filter((s) => !s.ok);
console.log(`${manifest.shots.length - missed.length} shots captured, ${missed.length} missed (see assets/ui/manifest.json)`);
