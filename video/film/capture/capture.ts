// Re-shoots every real-UI shot for the film from the app's own headless preview.
//
//   MAGIC_APP_DIR=<main checkout> MAGIC_STUDY_DIR=<study checkout> npx tsx capture/capture.ts [--build]
//
// Two passes, same synthetic data:
// - main pass (MAGIC_APP_DIR): Home / Daily Brief, Calendar (week and month), course page and its Analytics tab.
// - study pass (MAGIC_STUDY_DIR, default = MAGIC_APP_DIR): Study & Learn, the catered item space, the practice
//   quiz and flashcards. Once land/study-prepper merges, point both at one checkout.
// Each pass starts a fresh `scripts/preview.ts` server (synthetic sample course, temporary store, no school or
// AI connections) and drives it with headless Chromium. No window ever opens. After the sample course loads, the
// script imports a second synthetic course (Algorithms 301 · Sample, with a lecture an hour from now and a
// synthetic advising email) through the app's own `import` command.
// Writes 2x PNGs to assets/ui/ (git-ignored) and assets/ui/manifest.json. A missed shot is reported, never
// substituted. The preview has no model, so the quiz and card components get synthetic items at the bridge
// (SYNTHETIC_QUIZ below): the components, layout and KaTeX are real; the questions are ours.
// Windows: the preview needs 4f0f995 ("preview serves renderer assets on Windows") until it reaches main.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium, type Page, type Route } from "playwright";

const here = resolve(import.meta.dirname, "..");
const appDir = resolve(process.env.MAGIC_APP_DIR ?? join(here, "..", ".."));
const studyDir = resolve(process.env.MAGIC_STUDY_DIR ?? appDir);
const outDir = join(here, "assets", "ui");
const port = Number(process.env.CAPTURE_PORT ?? 4397);
const scale = Number(process.env.CAPTURE_SCALE ?? 2);
mkdirSync(outDir, { recursive: true });

type Shot = { file: string; ok: boolean; note: string };
const manifest: { app: string; appCommit: string; study: string; studyCommit: string; capturedAt: string; shots: Shot[] } = {
  app: appDir,
  appCommit: git(["rev-parse", "--short", "HEAD"], appDir),
  study: studyDir,
  studyCommit: git(["rev-parse", "--short", "HEAD"], studyDir),
  capturedAt: new Date().toISOString(),
  shots: [],
};

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

for (const dir of new Set([appDir, studyDir]))
  if (process.argv.includes("--build") || !existsSync(join(dir, "apps/desktop/dist/renderer/index.html"))) {
    console.log(`building the renderer in ${dir}`);
    execFileSync("npx", ["tsx", "scripts/build.ts"], { cwd: dir, stdio: "inherit", shell: true });
  }

function startPreview(appDir: string, port: number): Promise<{ child: ChildProcess; url: string }> {
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
const nextHour = () => {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
};
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
      cs("lecture-13", "event", "Algorithms 301 · Lecture 13", "", {
        deadlines: [{ value: nextHour(), kind: "event", quote: "start", authority: "structured", scopeConfirmed: true }],
      }),
      // Synthetic advising email (the Outlook connector is built but has not run live).
      cs("advising", "message", "Advising: registration hold, reply by Friday", "Your registration hold can be cleared once you reply to schedule a check-in. Please reply by Friday.", {
        mail: { messageId: "synthetic-advising-1", folder: "inbox", fromName: "Academic advising (sample)", receivedAt: new Date().toISOString(), preview: "Your registration hold can be cleared once you reply to schedule a check-in.", category: "advisor", categoryReason: "synthetic sample" },
      }),
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
async function onboard(p: Page, url: string, shots: boolean) {
  await p.goto(url);
  await settle(p, 1500);
  if (shots) await shoot(p, "onboard-agreement.png", "Real: first-run agreement (one checkbox), before sign-in");
  await p.getByText("Load sample course").click();
  await settle(p, 1800);
  if (shots) {
    await shoot(p, "onboard-choose-ai.png", "Real: Choose your AI (preview lists sample clients, labelled so on screen)");
    await panel(p, "panel-choose-ai.png", "Real: the detected-client cards", "Claude Code", 110, 24);
  }
  for (let i = 0; i < 10; i++) {
    let clicked = "";
    for (const n of ["Continue", "Agree and continue", "Skip for now", "Open workspace"]) {
      const l = p.getByRole("button", { name: n, exact: true });
      if ((await l.count()) && (await l.first().isEnabled())) {
        await l.first().click();
        clicked = n;
        break;
      }
    }
    if (!clicked) break;
    await settle(p, 1100);
  }
  const imported = await p.evaluate(async (batch) => (await (window as any).magic.execute({ type: "import", batch })).message ?? "ok", csBatch());
  console.log(`  import: ${imported}`);
  await p.reload();
  await settle(p, 2500);
}
async function pass(name: string, dir: string, portNo: number, body: (p: Page, url: string) => Promise<void>) {
  const { child, url } = await startPreview(dir, portNo);
  console.log(`${name} pass: ${url} (${git(["rev-parse", "--short", "HEAD"], dir)})`);
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale, reducedMotion: "reduce" });
    const p = await ctx.newPage();
    await p.route("**/query", studyRoute);
    await body(p, url);
  } catch (e) {
    manifest.shots.push({ file: `${name}-pass`, ok: false, note: `pass stopped: ${(e as Error).message.split("\n")[0]}` });
    console.log(`  ${name} pass stopped: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await browser.close();
    stopPreview(child);
  }
}
async function quizAndCards(p: Page) {
  injectStudy = true;
  try {
    await p.locator(".sp-entry", { hasText: "Exam 2" }).first().click({ timeout: 8000 });
    await settle(p, 2000);
    await shoot(p, "study-space.png", "Real: the exam's study space (sources, zero-token overview, Studio)");
    await p.getByRole("button", { name: /Practice quiz/ }).first().click({ timeout: 8000 });
    await settle(p, 1500);
    const quizPanel = p.locator(".sp-quiz").first();
    const answer = async () => {
      await p.locator(".sp-option").nth(1).click();
      await p.getByRole("button", { name: /Check/ }).first().click();
    };
    for (let i = 0; i < 5; i++) {
      await answer();
      await p.getByRole("button", { name: "Next" }).first().click();
      await settle(p, 250);
    }
    await shoot(p, "quiz-q6.png", "Real quiz component, synthetic items: question 6 with KaTeX");
    await quizPanel.screenshot({ path: join(outDir, "panel-quiz-q6.png") });
    manifest.shots.push({ file: "panel-quiz-q6.png", ok: true, note: "Real quiz component: question 6 panel" });
    await answer();
    await settle(p, 700);
    await quizPanel.screenshot({ path: join(outDir, "panel-quiz-right.png") });
    manifest.shots.push({ file: "panel-quiz-right.png", ok: true, note: "Real quiz component: correct-answer feedback" });
    for (let i = 0; i < 24 && !(await p.locator(".sp-quiz-done").count()); i++) {
      const check = p.getByRole("button", { name: /Check/ });
      if ((await check.count()) && (await check.first().isVisible())) await answer();
      else await p.getByRole("button", { name: /^(Next|Finish)/ }).first().click();
      await settle(p, 250);
    }
    const done = p.locator(".sp-quiz-done").first();
    if (await done.count()) {
      await done.screenshot({ path: join(outDir, "panel-quiz-results.png") });
      manifest.shots.push({ file: "panel-quiz-results.png", ok: true, note: "Real quiz component: results panel" });
    } else manifest.shots.push({ file: "panel-quiz-results.png", ok: false, note: "results screen not reached" });
    await p.getByRole("button", { name: /Flashcards/ }).first().click({ timeout: 6000 });
    await settle(p, 1200);
    await shoot(p, "cards-front.png", "Real flashcard component, synthetic card: front");
    await p.locator(".sp-card, [class*=card]").first().click({ timeout: 3000 }).catch(() => p.keyboard.press("Space"));
    await settle(p, 900);
    await shoot(p, "cards-back.png", "Real flashcard component, synthetic card: back");
  } catch (e) {
    manifest.shots.push({ file: "quiz/cards", ok: false, note: `study prep not reachable: ${(e as Error).message.split("\n")[0]}` });
    console.log(`  MISSED quiz/cards: ${(e as Error).message.split("\n")[0]}`);
  }
  injectStudy = false;
  await p.keyboard.press("Escape");
  await settle(p, 500);
}

await pass("main", appDir, port, async (p, url) => {
  await onboard(p, url, true);
  await shoot(p, "home.png", "Real: Home / Daily Brief, Upcoming, Study & Learn and the Today rail (lecture an hour out)");
  await panel(p, "panel-upcoming.png", "Real: the ranked Upcoming list", "Upcoming", 240);
  await panel(p, "panel-today.png", "Real: Today rail", "Today", 600);
  await click(p, "Calendar");
  await settle(p, 1500);
  await shoot(p, "calendar.png", "Real: Calendar, this week");
  const month = p.getByRole("button", { name: "Month", exact: true });
  if (await month.count()) {
    await month.first().click();
    await settle(p, 1500);
    await shoot(p, "calendar-month.png", "Real: Calendar, month view");
  }
  await p.getByRole("button", { name: csCourse, exact: true }).first().click();
  await settle(p, 2000);
  await shoot(p, "course-page.png", "Real: course page (Overview)");
  await p.getByRole("button", { name: "Analytics", exact: true }).first().click();
  await settle(p, 2500);
  await shoot(p, "analytics.png", "Real: course Analytics tab (the app labels it Synthetic sample)");
  await p.mouse.wheel(0, 700);
  await settle(p, 1200);
  await shoot(p, "analytics-lower.png", "Real: course Analytics tab, lower half (completion, prep, topic mastery)");
  await p.mouse.wheel(0, -700);
  await p.getByRole("button", { name: "Overview", exact: true }).first().click();
  await settle(p, 1500);
  await quizAndCards(p);
});

await pass("study", studyDir, port + 1, async (p, url) => {
  await onboard(p, url, false);
  await click(p, "Study & Learn");
  await settle(p, 2000);
  await shoot(p, "study-learn.png", "Real: Study & Learn, every work item by when it's due");
  await p.getByText("Problem set 4: recurrences").first().click();
  await settle(p, 2500);
  await shoot(p, "item-space.png", "Real: the catered item space for a problem set (cards, practice, explain, instructions, worked examples, linked materials)");
  const dlg = p.locator("dialog[open], [role=dialog]").first();
  if (await dlg.count()) {
    await dlg.screenshot({ path: join(outDir, "panel-item-space.png") });
    manifest.shots.push({ file: "panel-item-space.png", ok: true, note: "Real: item space panel" });
  } else await panel(p, "panel-item-space.png", "Real: item space panel", "Problem set 4: recurrences", 300);
  await p.keyboard.press("Escape");
  await settle(p, 800);
  if (!manifest.shots.some((s) => s.file === "panel-quiz-q6.png" && s.ok)) {
    await p.getByRole("button", { name: csCourse, exact: true }).first().click();
    await settle(p, 2000);
    await quizAndCards(p);
  }
});

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
const missed = manifest.shots.filter((s) => !s.ok);
console.log(`${manifest.shots.length - missed.length} shots captured, ${missed.length} missed (see assets/ui/manifest.json)`);
for (const m of missed) console.log(`  missed: ${m.file}: ${m.note}`);
