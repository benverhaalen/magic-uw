// Records continuous user-journey takes of the real app, headless, for the show-off beats.
//
//   MAGIC_APP_DIR=<main checkout> MAGIC_STUDY_DIR=<study checkout> npx tsx capture/journey.ts
//
// Take A (study checkout): Home → Study & Learn → the problem set's item space → the course's Exam 2
//   study prep → practice quiz (question 6 answered) → flashcards (flip, grade).
// Take B (main checkout): Calendar (week, month) → course page → Analytics tab.
// Each take is a Chrome screencast (JPEG frames with timestamps) assembled to a 30 fps MP4 at 2880x1620:
// assets/ui/take-a.mp4, take-b.mp4, plus take-*.json with every step's planned and actual time and the
// target box (1920x1080 CSS pixels), so the compositions' punch-ins line up with the clicks.
// A synthetic cursor, click ripple and a soft spotlight are injected into the page; nothing is clicked
// that could leave the machine (the preview has no school or AI connections).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium, type Page, type Route, type Locator } from "playwright";

const here = resolve(import.meta.dirname, "..");
const appDir = resolve(process.env.MAGIC_APP_DIR ?? join(here, "..", ".."));
const studyDir = resolve(process.env.MAGIC_STUDY_DIR ?? appDir);
const outDir = join(here, "assets", "ui");
const SCALE = 1.5;
mkdirSync(outDir, { recursive: true });
const git = (cwd: string) => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

function startPreview(dir: string, port: number): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((ok, fail) => {
    const child = spawn("npx", ["tsx", "scripts/preview.ts"], { cwd: dir, shell: true, windowsHide: true, env: { ...process.env, MAGIC_PREVIEW_PORT: String(port), MAGIC_PREVIEW_LEARNING_FIXTURE: "1" } });
    const timer = setTimeout(() => fail(new Error("preview did not start")), 60_000);
    child.stdout!.on("data", (d: Buffer) => {
      const m = /Local verification: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        ok({ child, url: m[1]! });
      }
    });
  });
}
const stop = (c: ChildProcess) => {
  try {
    execFileSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    c.kill();
  }
};

// ---------- the same synthetic data as capture.ts ----------
const day = 86_400_000;
const at = (d: number, h: number) => {
  const x = new Date(Date.now() + d * day);
  x.setHours(h, 0, 0, 0);
  return x.toISOString();
};
const nextHour = () => {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
};
const csCourse = "Algorithms 301 · Sample";
const cs = (externalId: string, kind: string, title: string, text: string, extra: Record<string, unknown> = {}) => ({ externalId, kind, courseId: "sample-301", courseName: csCourse, title, url: `https://example.org/algorithms/${externalId}`, text, deadlines: [], points: null, submitted: null, policy: { mode: "coaching", evidence: "Use AI to explain ideas; write your own proofs and code." }, ...extra });
const due = (value: string) => [{ value, kind: "due", quote: `due_at: ${value}`, authority: "structured", scopeConfirmed: true }];
const batch = () => ({
  source: { id: "sample-algorithms", label: "Algorithms sample · synthetic", kind: "fixture", accountScope: "synthetic", courseId: "sample-301", scope: "assignments" },
  observedAt: new Date().toISOString(),
  complete: true,
  status: "ok",
  resources: [
    cs("pset-4", "assignment", "Problem set 4: recurrences", "Solve the four recurrences using the Master theorem. Show each case. See Lecture 12. Late work loses 10% per day (syllabus).", { links: ["https://example.org/algorithms/lecture-12", "https://example.org/algorithms/syllabus"], deadlines: due(at(1, 23)), points: 40, submitted: false }),
    cs("exam-2", "assignment", "Exam 2", "Covers divide and conquer, recurrences and the Master theorem. Closed book; one page of notes.", { links: ["https://example.org/algorithms/lecture-12"], deadlines: due(at(5, 10)), points: 100, submitted: false }),
    cs("lecture-12", "material", "Lecture 12 · The Master theorem", "For T(n) = aT(n/b) + f(n): compare f(n) with n^(log_b a). Merge sort: T(n) = 2T(n/2) + n, so T(n) = Θ(n log n)."),
    cs("syllabus", "material", "Syllabus · Late work", "Late work loses 10% per day, up to three days."),
    cs("lecture-13", "event", "Algorithms 301 · Lecture 13", "", { deadlines: [{ value: nextHour(), kind: "event", quote: "start", authority: "structured", scopeConfirmed: true }] }),
  ],
});

// ---------- synthetic quiz and cards for the real components (see capture.ts) ----------
const quote = (title: string, text: string) => ({ resourceId: null, title, url: null, quote: text, start: null, end: null });
const QUIZ: [string, string[], string][] = [
  ["Which case of the Master theorem applies to $T(n) = 2T(n/2) + n$?", ["Case 1", "Case 2", "Case 3", "It does not apply"], "b"],
  ["What is $\\log_b a$ for $T(n) = 4T(n/2) + n$?", ["1", "2", "4", "$\\tfrac{1}{2}$"], "b"],
  ["Solve $T(n) = 8T(n/2) + n^2$.", ["$\\Theta(n^2)$", "$\\Theta(n^2 \\log n)$", "$\\Theta(n^3)$", "$\\Theta(n \\log n)$"], "c"],
  ["Merge sort, $T(n) = 2T(n/2) + \\Theta(n)$, runs in", ["$\\Theta(n)$", "$\\Theta(n \\log n)$", "$\\Theta(n^2)$", "$\\Theta(\\log n)$"], "b"],
  ["Binary search, $T(n) = T(n/2) + \\Theta(1)$, gives", ["$\\Theta(1)$", "$\\Theta(\\log n)$", "$\\Theta(n)$", "$\\Theta(n \\log n)$"], "b"],
  ["For $T(n) = 3T(n/4) + n^2$, the dominant term is", ["$n^{\\log_4 3}$", "$n^2$", "$\\log n$", "$n^{3/4}$"], "b"],
  ["Case 1 needs $f(n) = O(n^{\\log_b a - \\epsilon})$ for some", ["$\\epsilon < 0$", "$\\epsilon > 0$", "$\\epsilon = 0$", "$\\epsilon = 1$ only"], "b"],
  ["Strassen, $T(n) = 7T(n/2) + \\Theta(n^2)$, gives", ["$\\Theta(n^3)$", "$\\Theta(n^{\\log_2 7})$", "$\\Theta(n^2)$", "$\\Theta(n^2 \\log n)$"], "b"],
  ["$T(n) = 2T(n/2) + n \\log n$ falls", ["in Case 1", "in Case 2", "in Case 3", "outside the basic theorem"], "d"],
  ["$\\log_2 n$ levels doing $n$ work each total", ["$n$", "$n \\log n$", "$n^2$", "$\\log n$"], "b"],
];
function materials(base: Record<string, any>) {
  const now = new Date().toISOString();
  const lec = "Lecture 12 · The Master theorem";
  const quiz = QUIZ.map(([stem, opts, key], i) => ({ itemId: `syn-q${i + 1}`, version: 1, kind: "mc", stem, options: opts.map((text, j) => ({ id: "abcd"[j]!, text })), key, unit: null, explanation: i === 5 ? "$f(n) = n^2$ grows faster than $n^{\\log_4 3} \\approx n^{0.79}$, so Case 3: $T(n) = \\Theta(n^2)$." : null, topics: ["Master theorem", "Recurrences"], source: quote(lec, "compare f(n) with n^(log_b a)") }));
  const cards = [
    ["Master theorem, Case 2", "If $f(n) = \\Theta(n^{\\log_b a})$, then $T(n) = \\Theta(n^{\\log_b a} \\log n)$."],
    ["Merge sort recurrence", "$T(n) = 2T(n/2) + n = \\Theta(n \\log n)$"],
    ["Binary search recurrence", "$T(n) = T(n/2) + 1 = \\Theta(\\log n)$"],
  ].map(([front, back], i) => ({ cardId: `syn-c${i + 1}`, itemId: `syn-c${i + 1}`, kind: "card", front, back, topics: ["Master theorem"], due: null, source: quote(lec, "Merge sort: T(n) = 2T(n/2) + n") }));
  const mat = (kind: string, count: number, extra: Record<string, unknown>) => ({ kind, status: "ready", count, generatedAt: now, message: null, changed: [], guide: null, quiz: null, cards: null, exam: null, problems: null, outline: null, ...extra });
  const src = [quote(lec, "compare f(n) with n^(log_b a)")];
  const problems = [
    { id: "p1", number: "1", section: "A", points: 5, format: "multiple choice", topic: "Master theorem", prompt: "For $T(n) = 3T(n/4) + n^2$, which term dominates?", options: [{ id: "a", text: "$n^{\\log_4 3}$" }, { id: "b", text: "$n^2$" }, { id: "c", text: "$\\log n$" }, { id: "d", text: "$n^{3/4}$" }], answer: { kind: "choice", key: "b" }, solution: "$n^2$ grows faster than $n^{\\log_4 3} \\approx n^{0.79}$, so Case 3: $T(n) = \\Theta(n^2)$.", verified: "key", sources: src },
    { id: "p2", number: "2", section: "A", points: 5, format: "multiple choice", topic: "Recurrences", prompt: "Solve $T(n) = 8T(n/2) + n^2$.", options: [{ id: "a", text: "$\\Theta(n^2)$" }, { id: "b", text: "$\\Theta(n^2 \\log n)$" }, { id: "c", text: "$\\Theta(n^3)$" }, { id: "d", text: "$\\Theta(n \\log n)$" }], answer: { kind: "choice", key: "c" }, solution: "$\\log_2 8 = 3 > 2$, so Case 1: $\\Theta(n^3)$.", verified: "key", sources: src },
    { id: "p3", number: "3", section: "B", points: 10, format: "numeric", topic: "Master theorem", prompt: "For $T(n) = 4T(n/2) + n$, what is $\\log_b a$?", options: null, answer: { kind: "numeric", value: 2, unit: null }, solution: "$\\log_2 4 = 2$.", verified: "recomputed", sources: src },
  ];
  const exam = { title: "Exam 2 practice (synthetic)", minutes: 20, totalPoints: 20, basis: "Built from Lecture 12 (synthetic sample)", problems };
  return { ...base, quiz: mat("quiz", quiz.length, { quiz }), cards: mat("cards", cards.length, { cards }), exam: mat("exam", problems.length, { exam, problems }) };
}
async function studyRoute(route: Route) {
  let body: any = null;
  try {
    body = JSON.parse(route.request().postData() ?? "null");
  } catch {}
  if (body?.view !== "study.prep") return route.continue();
  const res = await route.fetch();
  const json = await res.json();
  if (json?.status === "ok" && json.materials) json.materials = materials(json.materials);
  return route.fulfill({ response: res, json });
}

// ---------- cursor, ripple and spotlight, injected into the page ----------
function overlay() {
  const install = () => {
    if (document.getElementById("__cur")) return;
    const cur = document.createElement("div");
    cur.id = "__cur";
    cur.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15.5 L12.5 22 L15.5 20.6 L12 14 L19 14 Z" fill="#fff" stroke="#1a0d0b" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    cur.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-80px,-80px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))";
    const spot = document.createElement("div");
    spot.id = "__spot";
    spot.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border-radius:12px;border:3px solid #f7c440;box-shadow:0 0 0 9999px rgba(26,13,11,.16),0 0 18px rgba(247,196,64,.6);opacity:0;transition:opacity .25s,left .35s,top .35s,width .35s,height .35s";
    document.body.append(spot, cur);
    addEventListener("mousemove", (e) => (cur.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`), true);
    addEventListener(
      "mousedown",
      (e) => {
        const r = document.createElement("div");
        r.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #f7c440;z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out`;
        document.body.appendChild(r);
        requestAnimationFrame(() => {
          r.style.transform = "scale(1.8)";
          r.style.opacity = "0";
        });
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
  };
  if (document.body) install();
  else addEventListener("DOMContentLoaded", install);
}

type Step = { name: string; planned: number; actual: number; box: { x: number; y: number; w: number; h: number } | null };
class Take {
  steps: Step[] = [];
  t0 = 0;
  frames: { t: number; file: string }[] = [];
  mouse = { x: 1500, y: 900 };
  constructor(public name: string, public p: Page) {}
  async start() {
    const dir = join(outDir, `frames-${this.name}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const cdp = await this.p.context().newCDPSession(this.p);
    let n = 0;
    cdp.on("Page.screencastFrame", async (f) => {
      const file = join(dir, `${String(n++).padStart(5, "0")}.jpg`);
      writeFileSync(file, Buffer.from(f.data, "base64"));
      this.frames.push({ t: f.metadata.timestamp ?? Date.now() / 1000, file });
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.p.mouse.move(this.mouse.x, this.mouse.y);
    this.t0 = Date.now() / 1000;
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920 * SCALE, maxHeight: 1080 * SCALE, everyNthFrame: 1 });
    // A heartbeat repaint keeps frames flowing while the page is still.
    await this.p.evaluate(() => {
      const hb = document.createElement("div");
      hb.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;z-index:2147483647;pointer-events:none";
      document.body.appendChild(hb);
      let i = 0;
      setInterval(() => (hb.style.background = i++ % 2 ? "#000" : "#010101"), 33);
    });
    (this as any).cdp = cdp;
  }
  async until(sec: number) {
    const wait = this.t0 + sec - Date.now() / 1000;
    if (wait > 0) await this.p.waitForTimeout(wait * 1000);
  }
  async boxOf(l: Locator) {
    const b = await l.boundingBox({ timeout: 2500 });
    return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
  }
  async moveTo(x: number, y: number, ms = 600) {
    const steps = Math.max(8, Math.round(ms / 16));
    const from = { ...this.mouse };
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      await this.p.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await this.p.waitForTimeout(ms / steps);
    }
    this.mouse = { x, y };
  }
  async spot(box: Step["box"]) {
    await this.p.evaluate((b) => {
      const s = document.getElementById("__spot");
      if (!s) return;
      if (!b) {
        s.style.opacity = "0";
        return;
      }
      Object.assign(s.style, { left: `${b.x - 6}px`, top: `${b.y - 6}px`, width: `${b.w + 12}px`, height: `${b.h + 12}px`, opacity: "1" });
    }, box);
  }
  /** At `sec`, move to the target, spotlight it and (optionally) click it. */
  async act(sec: number, name: string, l: Locator, opts: { click?: boolean; hold?: number; move?: number } = {}) {
    await this.until(sec);
    const actual = Date.now() / 1000 - this.t0;
    let box: Step["box"] = null;
    try {
      await l.first().scrollIntoViewIfNeeded({ timeout: 2500 });
      box = await this.boxOf(l.first());
    } catch {}
    this.steps.push({ name, planned: sec, actual: +actual.toFixed(2), box });
    if (!box) {
      await this.p.screenshot({ path: join(outDir, `debug-${this.name}-${name}.png`) }).catch(() => {});
      return console.log(`  ${this.name}: ${name} not found (debug-${this.name}-${name}.png)`);
    }
    await this.spot(box);
    await this.moveTo(box.x + Math.min(box.w / 2, 160), box.y + box.h / 2, opts.move ?? 550);
    if (opts.hold) await this.p.waitForTimeout(opts.hold);
    if (opts.click !== false) {
      await this.p.mouse.down();
      await this.p.waitForTimeout(70);
      await this.p.mouse.up();
      await this.p.waitForTimeout(150);
      await this.spot(null);
    }
  }
  async stop(end: number) {
    await this.until(end);
    await (this as any).cdp.send("Page.stopScreencast");
    const list: string[] = [];
    const fr = this.frames.sort((a, b) => a.t - b.t);
    for (let i = 0; i < fr.length; i++) {
      const next = i + 1 < fr.length ? fr[i + 1]!.t : this.t0 + end;
      const start = i === 0 ? this.t0 : fr[i]!.t;
      list.push(`file '${fr[i]!.file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, next - start).toFixed(4)}`);
    }
    list.push(`file '${fr[fr.length - 1]!.file.replace(/\\/g, "/")}'`);
    const listFile = join(outDir, `take-${this.name}.txt`);
    writeFileSync(listFile, list.join("\n"));
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=30,scale=${1920 * SCALE}:${1080 * SCALE}:flags=lanczos,format=yuv420p`, "-t", String(end), "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-g", "30", "-keyint_min", "30", "-movflags", "+faststart", join(outDir, `take-${this.name}.mp4`)]);
    writeFileSync(join(outDir, `take-${this.name}.json`), JSON.stringify({ take: this.name, seconds: end, frames: fr.length, scale: SCALE, steps: this.steps }, null, 2));
    const late = this.steps.filter((s) => s.actual - s.planned > 0.3);
    console.log(`  take ${this.name}: ${fr.length} frames over ${end} s; ${late.length} late steps${late.length ? ": " + late.map((s) => `${s.name} +${(s.actual - s.planned).toFixed(1)}s`).join(", ") : ""}`);
  }
}

async function setup(dir: string, port: number, fn: (p: Page) => Promise<void>) {
  const { child, url } = await startPreview(dir, port);
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE });
    await ctx.addInitScript(overlay);
    const p = await ctx.newPage();
    await p.route("**/query", studyRoute);
    await p.goto(url);
    await p.waitForTimeout(1500);
    await p.getByText("Load sample course").click();
    await p.waitForTimeout(1800);
    for (let i = 0; i < 10; i++) {
      let c = false;
      for (const n of ["Continue", "Agree and continue", "Skip for now", "Open workspace"]) {
        const l = p.getByRole("button", { name: n, exact: true });
        if ((await l.count()) && (await l.first().isEnabled())) {
          await l.first().click();
          c = true;
          break;
        }
      }
      if (!c) break;
      await p.waitForTimeout(1000);
    }
    await p.evaluate(async (b) => (window as any).magic.execute({ type: "import", batch: b }), batch());
    await p.reload();
    await p.waitForTimeout(3000);
    await fn(p);
  } finally {
    await browser.close();
    stop(child);
  }
}

const btn = (p: Page, name: string | RegExp, exact = true) => p.getByRole("button", { name, exact: typeof name === "string" ? exact : undefined });

const TAKES = (process.env.TAKES ?? "a,b").split(",");
// Take A (film 0:30-0:50 and 0:56-1:06): agenda → item space; then (off-camera during the goof) the
// course's Exam 2 space → cards → practice exam. 35 s. The voice request and typed questions are not
// captured live: the headless preview has no microphone and no AI (see STORYBOARD.md).
console.log(`take A from ${studyDir} (${git(studyDir)})`);
if (TAKES.includes("a")) await setup(studyDir, 4401, async (p) => {
  const t = new Take("a", p);
  await t.start();
  // J1 (A 0-10): the ranked day.
  await t.act(0.8, "brief-top", p.getByRole("heading", { name: /Daily Brief|Briefing/ }).locator("xpath=.."), { click: false, hold: 900 });
  await t.act(3.6, "today-lecture", p.getByRole("button", { name: /Lecture 13/ }), { click: false, hold: 700 });
  await t.act(6.2, "upcoming-pset", p.getByRole("button", { name: /Problem set 4: recurrences/ }).first(), { click: false, hold: 500 });
  await t.act(8.6, "nav-study-learn", btn(p, "Study & Learn"));
  // J2 (A 10-20): the assignment's item space.
  await t.act(10.0, "open-pset", p.getByText("Problem set 4: recurrences").first());
  await t.act(12.2, "space-instructions", p.getByText("Instructions", { exact: false }).last(), { click: false, hold: 500 });
  await t.act(14.2, "space-examples", p.getByText(/Worked examples/i).last(), { click: false, hold: 500 });
  await t.act(16.2, "space-linked", p.getByText(/Linked materials/i).last(), { click: false, hold: 500 });
  await t.act(18.2, "space-tiles", p.getByRole("button", { name: /Concept cards/ }).first(), { click: false, hold: 400 });
  // Off-camera (the goof covers A 20-24): to the course and Exam 2's space.
  await t.until(20.0);
  await p.keyboard.press("Escape");
  await t.act(20.4, "nav-course", btn(p, csCourse));
  await t.act(22.2, "prep-exam2", p.locator("button, [role=button], a", { hasText: "Prep" }).filter({ hasText: "Exam 2" }).or(p.getByText("Prep", { exact: true })).first());
  // J4 (A 24-35): cards, then the practice exam.
  await t.act(24.2, "tile-cards", p.getByRole("button", { name: /^Cards/ }).first());
  await t.act(25.8, "card-flip", p.getByText("Master theorem, Case 2", { exact: true }).first());
  await t.until(27.4);
  t.steps.push({ name: "card-next", planned: 27.4, actual: +(Date.now() / 1000 - t.t0).toFixed(2), box: null });
  await p.keyboard.press("ArrowRight");
  await t.act(28.4, "tile-exam", p.getByRole("button", { name: /Practice exam/ }).first());
  await t.act(29.8, "exam-start", p.getByRole("button", { name: "Start", exact: true }).first());
  await t.act(31.0, "exam-answer-1", p.getByRole("radio").nth(1), { hold: 100, move: 400 });
  await t.act(32.0, "exam-answer-2", p.getByRole("radio").nth(6), { hold: 100, move: 400 });
  await t.act(33.0, "exam-submit", p.getByRole("button", { name: "Submit", exact: true }).first(), { move: 400 });
  await t.stop(36);
});

// Take B (film 1:06-1:30): calendar → Study & Learn → course Analytics → My UW. 24 s.
console.log(`take B from ${appDir} (${git(appDir)})`);
if (TAKES.includes("b")) await setup(appDir, 4402, async (p) => {
  const t = new Take("b", p);
  await t.start();
  // J5 (B 0-8)
  await t.act(0.6, "nav-calendar", btn(p, "Calendar"));
  await t.act(2.2, "calendar-month", btn(p, "Month"));
  await t.act(3.8, "calendar-next", p.getByRole("button", { name: /next/i }).first());
  await t.act(5.4, "nav-study-learn", btn(p, "Study & Learn"));
  await t.act(6.8, "sl-list", p.getByRole("heading", { name: /This week/i }).locator("xpath=.."), { click: false, hold: 400 });
  // J6 (B 8-16)
  await t.act(8.2, "nav-course", btn(p, csCourse));
  await t.act(9.6, "tab-analytics", p.getByRole("tab", { name: "Analytics" }).or(p.getByText("Analytics", { exact: true })).first());
  await t.act(11.2, "grade-trend", p.getByRole("heading", { name: "Grade trend" }).locator("xpath=.."), { click: false, hold: 600 });
  await t.act(13.0, "what-next", p.getByRole("heading", { name: "What to do next" }).locator("xpath=.."), { click: false, hold: 500 });
  await t.until(14.6);
  await p.mouse.wheel(0, 650);
  await t.act(15.0, "topic-mastery", p.getByRole("heading", { name: "Topic mastery" }).locator("xpath=.."), { click: false, hold: 400 });
  // J7 (B 16-24)
  await t.until(16.0);
  await p.mouse.wheel(0, -650);
  await t.act(16.4, "nav-myuw", btn(p, "My UW"));
  await t.act(18.6, "myuw-first", p.locator("main h2, main h3").first().locator("xpath=.."), { click: false, hold: 700 });
  await t.act(21.0, "myuw-second", p.locator("main h2, main h3").nth(1).locator("xpath=.."), { click: false, hold: 700 });
  await p.screenshot({ path: join(outDir, "debug-b-myuw.png") });
  await t.stop(24);
});
console.log("journey takes written to assets/ui/take-a.mp4 and take-b.mp4");
