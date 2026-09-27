/**
 * Notification benchmark. Runs the real store → core → rules path on a capture folder (for
 * example a field-test run) and on the labeled synthetic corpora beside this file, and writes
 * aggregate CSV/JSON for charts. It never prints or writes titles or message text, except the
 * optional PRIVATE labeling sheet, which stays in --out for a human to fill in.
 *
 *   pnpm exec tsx evals/notifications/run.ts --captures <folder>/captures --out <dir outside repo>
 *   node --env-file=apps/gateway/.env --import tsx evals/notifications/run.ts ... --jev --max-calls 260
 *   ... --labels <filled labeling sheet.csv>   (accuracy on real announcements)
 *
 * With --jev, an in-process gateway built from apps/gateway (same validation and transport)
 * sends each triage state to TypeSafe under a hard per-run call ceiling. Every state is identity-
 * scrubbed by core's scrubber and then stripped of other personal identifiers (redactPii).
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  captureBatchSchema,
  emptyNotificationState,
  MAIL_TRIAGE_QUESTION_VERSION,
  MESSAGE_TRIAGE_QUESTION_VERSION,
  OUTLOOK_MAIL_COURSE_ID,
  type CaptureBatch,
  type MailTriageJudgment,
  type MailTriageResult,
  type MailTriageState,
  type MessageTriageJudgment,
  type MessageTriageResult,
  type MessageTriageState,
  type NotificationLevel,
  type ResourceChange,
  type ResourceView,
  type Store,
} from "@magic/contracts";
import { buildNotifications, NOTIFICATION_RULES } from "@magic/domain";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { gatewayClient } from "@magic/ai";
import { resourceViews } from "../../packages/core/src/queries";
import { rosterFor, scrubText } from "../../packages/core/src/identity";
import { createNotifications } from "../../packages/core/src/notifications";
import { createGateway } from "../../apps/gateway/src/gateway";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const here = dirname(fileURLToPath(import.meta.url));
const TZ = "America/Chicago";
const HOUR = 3600e3;
const DAY = 24 * HOUR;
type Level = NotificationLevel | "suppressed";
const RANK: Record<Level, number> = { suppressed: 0, info: 1, important: 2, urgent: 3 };

// ── arguments ───────────────────────────────────────────────────────────────────────────────
function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const capturesDir = arg("captures");
const outDir = arg("out");
const useJev = process.argv.includes("--jev");
const maxCalls = Number(arg("max-calls") ?? 0);
const labelsFile = arg("labels");
if (!outDir) throw new Error("--out <dir> is required.");
const outAbs = resolve(outDir);
const rel = relative(repo, outAbs);
if (!rel.startsWith("..") && !isAbsolute(rel))
  throw new Error("--out must be outside the repository: benchmark outputs derive from private data.");
mkdirSync(outAbs, { recursive: true });
if (useJev && !(maxCalls > 0)) throw new Error("--jev needs --max-calls N.");
if (useJev && !process.env.TYPESAFE_API_KEY?.trim())
  throw new Error("--jev needs TYPESAFE_API_KEY (run with node --env-file=apps/gateway/.env).");

// ── small utilities ─────────────────────────────────────────────────────────────────────────
const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(name: string, rows: Record<string, unknown>[]) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  writeFileSync(join(outAbs, name), [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? 0;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), median: q(0.5), p95: q(0.95), min: s[0] ?? 0, max: s.at(-1) ?? 0 };
};
function time(fn: () => void, reps: number) {
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return stats(out);
}
const hashId = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
let seed = 20260927;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
function pick<T>(xs: T[], k: number) {
  const copy = [...xs];
  const out: T[] = [];
  while (copy.length && out.length < k) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]!);
  return out;
}
const iso = (ms: number) => new Date(ms).toISOString();
const fmtDue = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ }).format(new Date(ms));
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "magic-notify-bench-"));
  return { store: createStore(join(dir, "w.sqlite")), dir };
}
const fixture = captureBatchSchema.parse(JSON.parse(readFileSync(join(repo, "fixtures/course.json"), "utf8")));

/** Personal identifiers beyond the roster scrubber: emails, phones, URLs, IDs, greeting/sign-off names, titled names. */
export function redactPii(text: string) {
  const counts: Record<string, number> = {};
  const hit = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let t = text;
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, () => (hit("email"), "[EMAIL]"));
  t = t.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, () => (hit("url"), "[URL]"));
  t = t.replace(/(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, () => (hit("phone"), "[PHONE]"));
  t = t.replace(/\b\d{6,}\b/g, () => (hit("id"), "[ID]"));
  t = t.replace(/\b(Prof(essor)?|Dr|Mr|Ms|Mrs|Mx|TA|Instructor)\.?\s+[A-Z][\w'-]+(\s+[A-Z][\w'-]+)?/g, (m) => (hit("titled_name"), m.split(/\s+/)[0] + " [NAME]"));
  t = t.replace(/\b(Hi|Hello|Hey|Dear|Good (morning|afternoon|evening))\s+[A-Z][\w'-]+(\s+[A-Z][\w'-]+)?/g, (m) => (hit("greeting_name"), m.replace(/\s+[A-Z][\w'-]+(\s+[A-Z][\w'-]+)?$/, " [NAME]")));
  // A sign-off and whatever follows it (signature block) is dropped.
  t = t.replace(/(\n|\s)(Best|Thanks|Thank you|Regards|Sincerely|Cheers|Warmly|Best regards|Kind regards)[,!.]?\s*(\n|\s+)[\s\S]*$/i, (m, lead, word) => (hit("signature"), `${lead}${word},`));
  t = t.replace(/@[A-Za-z][\w.-]{2,}/g, () => (hit("handle"), "[HANDLE]"));
  return { text: t, counts };
}

/** Keyword families (for charts only): which kind of literal wording decided an announcement. */
const FAMILIES: [string, RegExp][] = [
  ["cancellation", /\b(cancel+ed|cancel+ing|no class|won'?t meet|will not meet)\b/i],
  ["reschedule", /\b(postponed|rescheduled|moved to|pushed back|pushed to)\b/i],
  ["location", /\b(room change|new room|location)\b/i],
  ["assessment", /\b(exam|midterm|final|quiz)\b/i],
  ["deadline", /\b(due date|deadline|extended|extension)\b/i],
];
const familyOf = (quote?: string) => (quote ? FAMILIES.find(([, re]) => re.test(quote))?.[0] ?? "other" : "none");

function newChange(v: ResourceView, observedAt: string, i: number, readId = "bench-new"): ResourceChange {
  return { id: `bench-${i}`, resourceId: v.id, sourceId: v.sourceId, accountScope: "bench", courseId: v.courseId, scope: "bench", readId, observedAt, type: "new", oldValues: {}, newValues: { title: v.title } };
}
const quiet = { status: "off" as const, reason: "benchmark" };

// ── Jev (optional, bounded) ─────────────────────────────────────────────────────────────────
let calls = 0;
let jev: { triage(s: MessageTriageState): Promise<MessageTriageResult>; mail(s: MailTriageState): Promise<MailTriageResult>; close(): Promise<void> } | undefined;
async function startJev() {
  const dir = mkdtempSync(join(tmpdir(), "magic-bench-gw-"));
  const limits = { globalDailyRequestLimit: maxCalls, deviceDailyLimit: maxCalls, deviceHourlyLimit: maxCalls, deviceConcurrency: 1, globalConcurrency: 1 };
  const gateway = createGateway({ apiKey: process.env.TYPESAFE_API_KEY, dbPath: join(dir, "gw.sqlite"), port: 0, log: () => {}, limits });
  await gateway.listening;
  const port = (gateway.server.address() as { port: number }).port;
  let token: string | null = null;
  const client = gatewayClient(`http://127.0.0.1:${port}/`, { async read() { return token; }, async write(t) { token = t; } });
  const guard = () => {
    if (calls >= maxCalls) throw new Error("benchmark call ceiling reached");
    calls++;
  };
  jev = {
    async triage(s) { guard(); return client.triage!(s, AbortSignal.timeout(30000)); },
    async mail(s) { guard(); return client.mailTriage!(s, AbortSignal.timeout(30000)); },
    async close() { await gateway.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const topOf = (p: Record<string, number>) => {
  const s = Object.values(p).sort((a, b) => b - a);
  return { top: s[0] ?? 0, margin: (s[0] ?? 0) - (s[1] ?? 0) };
};

// ── P02-style capture folder ────────────────────────────────────────────────────────────────
const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), timeZone: TZ, jev: useJev ? { maxCalls } : false };

function loadCaptures(dir: string) {
  const batches: CaptureBatch[] = [];
  let invalid = 0;
  let statusOverrides = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const parsed = captureBatchSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (!parsed.success) {
      invalid++;
      continue;
    }
    // A field-test run can end with the session expired, which marks every capture needs_sign_in
    // although its resources were read. The store rightly refuses to save such a read, so the
    // benchmark treats a capture that holds resources as a successful (possibly partial) read.
    const b = parsed.data;
    if (b.status === "needs_sign_in" && b.resources.length) {
      statusOverrides++;
      batches.push({ ...b, status: "partial", complete: false });
    } else batches.push(b);
  }
  batches.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  return { batches, invalid, statusOverrides };
}

async function realData(dir: string) {
  const { batches, invalid, statusOverrides } = loadCaptures(dir);
  const T = Math.max(...batches.map((b) => Date.parse(b.observedAt)));
  const out: Record<string, unknown> = { captures: batches.length, invalid, statusOverrides, capturedAt: iso(T) };

  // B1 · baseline: a first import must not notify about coursework.
  const { store, dir: sdir } = tempStore();
  let clock = new Date(T + 60e3);
  const core = createCore(store, { fixture, now: () => clock, timeZone: TZ });
  const ingestMs: number[] = [];
  for (const b of batches) {
    const t = performance.now();
    store.ingest(b);
    ingestMs.push(performance.now() - t);
  }
  const snap = core.snapshot();
  const feed = snap.notifications!;
  const baselineRows = Object.entries(
    feed.items.reduce<Record<string, number>>((m, n) => ((m[`${n.reason}|${n.level}|${n.resourceId ? "coursework" : "source"}`] = (m[`${n.reason}|${n.level}|${n.resourceId ? "coursework" : "source"}`] ?? 0) + 1), m), {}),
  ).map(([k, count]) => {
    const [reason, level, subject] = k.split("|");
    return { reason, level, subject, count };
  });
  writeCsv("b1_baseline_items.csv", baselineRows);
  const views = resourceViews(store, store.resources());
  out.baseline = {
    resources: views.length,
    byKind: views.reduce<Record<string, number>>((m, v) => ((m[v.kind] = (m[v.kind] ?? 0) + 1), m), {}),
    courseworkNotifications: feed.items.filter((n) => n.resourceId).length,
    sourceNotifications: feed.items.filter((n) => !n.resourceId).length,
    degraded: feed.degraded,
    ingestMs: stats(ingestMs),
  };

  // B4a · performance at real scale.
  const notifications = createNotifications(store, { now: () => clock.toISOString(), timeZone: TZ, generation: () => 0, closed: () => false });
  const perf: Record<string, unknown>[] = [];
  const feedT = time(() => notifications.feed(views), 30);
  const feedColdT = time(() => notifications.feed(), 5);
  const snapT = time(() => core.snapshot(), 10);
  perf.push({ measure: "feed inside snapshot (reuses views)", resources: views.length, ...feedT });
  perf.push({ measure: "feed standalone (loads and builds views)", resources: views.length, ...feedColdT });
  perf.push({ measure: "snapshot (whole app state)", resources: views.length, ...snapT });

  // B2 · announcement rules on every real course message (each judged as if it just arrived).
  const messages = views.filter((v) => v.kind === "message" && !v.mail);
  const courseAlias = new Map<string, string>();
  [...messages.reduce((m, v) => m.set(v.courseId, (m.get(v.courseId) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .forEach(([id], i) => courseAlias.set(id, `C${i + 1}`));
  const assignments = views.filter((v) => v.kind === "assignment" && !v.deleted);
  const judged: Record<string, unknown>[] = [];
  const labeling: Record<string, unknown>[] = [];
  const redactionTotals: Record<string, number> = {};
  if (useJev && !jev) await startJev();
  for (const [i, v] of messages.entries()) {
    const at = Date.parse(v.createdAt ?? iso(T)) + HOUR;
    const now = iso(at);
    const course = assignments.filter((a) => a.courseId === v.courseId);
    const run = (triage: Record<string, MessageTriageJudgment>) =>
      buildNotifications({ changes: [newChange(v, now, i)], resources: [v, ...course], sources: [], baselineReadIds: [], included: () => true, triage, mailTriage: {}, triageStatus: quiet, state: emptyNotificationState, now, timeZone: TZ }).items.find((n) => n.resourceId === v.id);
    const code = run({});
    const codeLevel: Level = code?.level ?? "suppressed";
    // The exact triage state core would build at that moment, then scrubbed and PII-redacted.
    const upcoming = course
      .filter((a) => a.deadline.planningAt && Date.parse(a.deadline.planningAt) >= at && Date.parse(a.deadline.planningAt) <= at + 21 * DAY)
      .sort((a, b) => a.deadline.planningAt!.localeCompare(b.deadline.planningAt!))
      .slice(0, 10);
    const roster = rosterFor(store, v.courseId);
    const clean = (s: string) => {
      const scrubbed = scrubText(s, roster);
      for (const sp of scrubbed.spans) redactionTotals[`roster_${sp.kind}`] = (redactionTotals[`roster_${sp.kind}`] ?? 0) + 1;
      const r = redactPii(scrubbed.text);
      for (const [k, n] of Object.entries(r.counts)) redactionTotals[k] = (redactionTotals[k] ?? 0) + n;
      return r.text;
    };
    const rawChars = v.title.length + Math.min(4000, v.text.length);
    const state: MessageTriageState = {
      course: (clean(v.courseName) || "Course").slice(0, 200),
      title: (clean(v.title) || "Announcement").slice(0, 500),
      text: clean(v.text.slice(0, 6000)).slice(0, 4000),
      upcoming: upcoming.map((a, k) => ({ key: `a${k}`, title: (clean(a.title) || "Assignment").slice(0, 300), due: fmtDue(Date.parse(a.deadline.planningAt!)) })),
    };
    const row: Record<string, unknown> = {
      // Stable across runs: the source and Canvas id, not the store's generated resource id.
      bench_id: hashId(`${v.sourceId}:${v.externalId}`), course: courseAlias.get(v.courseId), age_days: Math.round((T - Date.parse(v.createdAt ?? iso(T))) / DAY),
      code_level: codeLevel, keyword_family: familyOf(code?.evidence?.quote), has_quote: !!code?.evidence?.quote,
      raw_chars: rawChars, state_chars: JSON.stringify(state).length, upcoming_offered: state.upcoming.length,
    };
    if (jev) {
      const t = performance.now();
      try {
        const result = await jev.triage(state);
        row.latency_ms = Math.round(performance.now() - t);
        const { top, margin } = topOf(result.kindProbabilities);
        const judgment: MessageTriageJudgment = { result, upcoming: upcoming.map((a, k) => ({ key: `a${k}`, resourceId: a.id, title: a.title })) };
        const final = run({ [v.id]: judgment });
        Object.assign(row, {
          jev_kind: result.kind, jev_top: +top.toFixed(3), jev_margin: +margin.toFixed(3), jev_action: +result.actionRequired.toFixed(3),
          jev_affects_max: +Math.max(0, ...Object.values(result.affects)).toFixed(3),
          final_level: final?.level ?? "suppressed", raised_by_jev: !!final?.raisedBy,
        });
      } catch (e) {
        row.jev_error = e instanceof Error ? e.message.slice(0, 80) : "error";
      }
    }
    judged.push(row);
    labeling.push({ bench_id: row.bench_id, course: row.course, age_days: row.age_days, title: v.title, text_excerpt: v.text.replace(/\s+/g, " ").slice(0, 400), code_level: codeLevel, jev_level: row.final_level ?? "", your_label: "" });
  }
  writeCsv("b2_announcements_real.csv", judged);
  writeCsv("PRIVATE-labeling-sheet.csv", labeling);
  const lv = (k: string) => judged.reduce<Record<string, number>>((m, r) => ((m[String(r[k])] = (m[String(r[k])] ?? 0) + 1), m), {});
  out.announcements = {
    messages: messages.length, courses: courseAlias.size, codeLevels: lv("code_level"), keywordFamilies: lv("keyword_family"),
    ...(useJev ? { finalLevels: lv("final_level"), jevKinds: lv("jev_kind"), raisedByJev: judged.filter((r) => r.raised_by_jev).length, jevErrors: judged.filter((r) => r.jev_error).length } : {}),
    redactions: redactionTotals,
    stateChars: stats(judged.map((r) => Number(r.state_chars))),
    upcomingOffered: stats(judged.map((r) => Number(r.upcoming_offered))),
  };
  if (labelsFile) out.announcementAccuracy = scoreLabels(labelsFile, judged);

  // B3 · controlled changes on real assignments (second read ten minutes later).
  clock = new Date(T + 15 * 60e3);
  const now = clock.getTime();
  const bySource = new Map<string, CaptureBatch>();
  for (const b of batches) if (b.source.scope === "assignments") bySource.set(b.source.id, b);
  const real = [...bySource.values()].flatMap((b) => b.resources.map((r) => ({ b, r })));
  const dueOf = (r: (typeof real)[number]["r"]) => (r.dueAt ? Date.parse(r.dueAt) : NaN);
  const unsubmitted = (r: (typeof real)[number]["r"]) => !r.submitted && !["submitted", "graded", "pending_review"].includes(r.submission?.workflowState ?? "");
  const futureUnsub = real.filter(({ r }) => r.kind === "assignment" && unsubmitted(r) && dueOf(r) > now + 2 * DAY && dueOf(r) < now + 60 * DAY);
  const gradable = real.filter(({ r }) => r.kind === "assignment" && r.submission && r.submission.workflowState !== "graded" && (r.points ?? 0) > 0);
  const scenarios: { name: string; expect: { reason: string; level: Level }; picks: typeof real }[] = [];
  const used = new Set<string>();
  const take = (pool: typeof real, k: number) => {
    const chosen = pick(pool.filter((x) => !used.has(x.r.externalId)), k);
    chosen.forEach((x) => used.add(x.r.externalId));
    return chosen;
  };
  scenarios.push({ name: "due moved earlier", expect: { reason: "due_earlier", level: "urgent" }, picks: take(futureUnsub, 3) });
  scenarios.push({ name: "due moved later", expect: { reason: "due_later", level: "important" }, picks: take(futureUnsub, 3) });
  scenarios.push({ name: "instructions changed", expect: { reason: "instructions_changed", level: "important" }, picks: take(futureUnsub, 3) });
  scenarios.push({ name: "removed from Canvas", expect: { reason: "removed", level: "important" }, picks: take(futureUnsub, 2) });
  scenarios.push({ name: "grade posted", expect: { reason: "graded", level: "important" }, picks: take(gradable, 3) });
  const setDue = (r: any, ms: number) => {
    const value = iso(ms);
    return { ...r, dueAt: value, deadlines: (r.deadlines ?? []).map((c: any) => (c.kind === "due" ? { ...c, value, quote: `due_at: ${value}` } : c)) };
  };
  const mutated = new Map<string, any[]>();
  for (const [id, b] of bySource) mutated.set(id, b.resources.map((r) => ({ ...r })));
  const edit = (sourceId: string, externalId: string, fn: ((r: any) => any) | null) => {
    const list = mutated.get(sourceId)!;
    const i = list.findIndex((r) => r.externalId === externalId);
    if (fn) list[i] = fn(list[i]);
    else list.splice(i, 1);
  };
  for (const s of scenarios)
    for (const { b, r } of s.picks) {
      if (s.name === "due moved earlier") edit(b.source.id, r.externalId, (x) => setDue(x, dueOf(r) - DAY));
      if (s.name === "due moved later") edit(b.source.id, r.externalId, (x) => setDue(x, dueOf(r) + 2 * DAY));
      if (s.name === "instructions changed") edit(b.source.id, r.externalId, (x) => ({ ...x, text: `${x.text}\nUpdate: submit a single PDF.`, rawHtml: `${x.rawHtml ?? ""}<p>Update: submit a single PDF.</p>` }));
      if (s.name === "removed from Canvas") edit(b.source.id, r.externalId, null);
      if (s.name === "grade posted") edit(b.source.id, r.externalId, (x) => ({ ...x, submitted: true, submission: { ...x.submission, workflowState: "graded", score: Math.round((x.points ?? 10) * 0.9) } }));
    }
  // Two genuinely new assignments in the first assignments source.
  const firstSource = [...bySource.keys()][0];
  const template = firstSource ? bySource.get(firstSource)!.resources.find((r) => r.kind === "assignment") : undefined;
  const newOnes: { externalId: string; expect: Level }[] = [];
  if (template && firstSource) {
    for (const [k, [hours, level]] of ([[30, "urgent"], [6 * 24, "important"]] as const).entries()) {
      const externalId = `${template.externalId}-bench-new-${k}`;
      mutated.get(firstSource)!.push({ ...setDue({ ...template, submission: null, submitted: false }, now + hours * HOUR), externalId, title: `Bench new assignment ${k}`, createdAt: iso(now - HOUR) });
      newOnes.push({ externalId, expect: level });
    }
  }
  for (const [id, b] of bySource)
    store.ingest(captureBatchSchema.parse({ ...b, observedAt: iso(now - 5 * 60e3), readId: "bench-sim-2", status: "ok", complete: true, resources: mutated.get(id) }));
  const simFeed = core.snapshot().notifications!;
  const all = resourceViews(store, store.resources());
  const idFor = (sourceId: string, externalId: string) =>
    [...store.resources(), ...store.changes({ limit: 2000 }).map((c) => store.resource(c.resourceId)!).filter(Boolean)]
      .find((r) => r.sourceId === sourceId && r.externalId === externalId)?.id;
  const simRows: Record<string, unknown>[] = [];
  const touched = new Set<string>();
  for (const s of scenarios)
    for (const { b, r } of s.picks) {
      const id = idFor(b.source.id, r.externalId);
      if (id) touched.add(id);
      const item = simFeed.items.find((n) => n.resourceId === id);
      simRows.push({ scenario: s.name, expected_reason: s.expect.reason, expected_level: s.expect.level, detected: !!item, reason_match: item?.reason === s.expect.reason, level_match: item?.level === s.expect.level, got_level: item?.level ?? "none" });
    }
  for (const n of newOnes) {
    const id = firstSource ? idFor(firstSource, n.externalId) : undefined;
    if (id) touched.add(id);
    const item = simFeed.items.find((x) => x.resourceId === id);
    simRows.push({ scenario: "new assignment", expected_reason: "new_assignment", expected_level: n.expect, detected: !!item, reason_match: item?.reason === "new_assignment", level_match: item?.level === n.expect, got_level: item?.level ?? "none" });
  }
  const falsePositives = simFeed.items.filter((n) => n.resourceId && !touched.has(n.resourceId));
  writeCsv("b3_change_simulation.csv", simRows);
  out.changeSimulation = {
    cases: simRows.length,
    detected: simRows.filter((r) => r.detected).length,
    reasonMatch: simRows.filter((r) => r.reason_match).length,
    levelMatch: simRows.filter((r) => r.level_match).length,
    falsePositives: falsePositives.length,
    falsePositiveReasons: falsePositives.reduce<Record<string, number>>((m, n) => ((m[n.reason] = (m[n.reason] ?? 0) + 1), m), {}),
    candidatesAvailable: { futureUnsubmitted: futureUnsub.length, gradable: gradable.length },
  };

  // B4b · rules scaling with change volume on real resources.
  const liveAssignments = all.filter((v) => v.kind === "assignment" && !v.deleted && v.deadline.planningAt);
  for (const n of [0, 100, 250, 500, 1000, 2000, 4000]) {
    const changes: ResourceChange[] = Array.from({ length: n }, (_, i) => {
      const v = liveAssignments[i % liveAssignments.length]!;
      const due = Date.parse(v.deadline.planningAt!);
      return { id: `scale-${i}`, resourceId: v.id, sourceId: v.sourceId, accountScope: "bench", courseId: v.courseId, scope: "bench", readId: `scale-${i % 7}`, observedAt: iso(now - (i % 100) * 60e3), type: "date_changed", oldValues: { dueAt: iso(due + DAY) }, newValues: { dueAt: iso(due) } };
    });
    const input = { changes, resources: all, sources: store.sources(), baselineReadIds: [], included: () => true, triage: {}, mailTriage: {}, triageStatus: quiet, state: emptyNotificationState, now: iso(now), timeZone: TZ };
    perf.push({ measure: "rules (buildNotifications)", resources: all.length, changes: n, ...time(() => buildNotifications(input), n >= 2000 ? 5 : 15) });
  }
  writeCsv("b4_performance.csv", perf);
  out.performance = perf;
  await core.close();
  rmSync(sdir, { recursive: true, force: true });
  return out;
}

function scoreLabels(file: string, judged: Record<string, unknown>[]) {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const cols = lines[0]!.split(",");
  const idCol = cols.indexOf("bench_id"), labelCol = cols.indexOf("your_label");
  const labels = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    if (cells[labelCol]?.trim()) labels.set(cells[idCol]!, cells[labelCol]!.trim().toLowerCase());
  }
  const rows = judged.filter((r) => labels.has(String(r.bench_id))).map((r) => ({ label: labels.get(String(r.bench_id))!, code: String(r.code_level), final: String(r.final_level ?? r.code_level) }));
  return { labeled: rows.length, code: confusion(rows.map((r) => [r.label, r.code])), codeJev: confusion(rows.map((r) => [r.label, r.final])) };
}

// ── labeled synthetic corpora ───────────────────────────────────────────────────────────────
type Label = "urgent" | "important" | "info" | "ignore";
const asLevel = (l: string): Level => (l === "ignore" ? "suppressed" : (l as Level));
function confusion(pairs: [string, string][]) {
  const levels = ["urgent", "important", "info", "suppressed"];
  const norm = (s: string) => (s === "ignore" || s === "none" ? "suppressed" : s);
  const m: Record<string, Record<string, number>> = {};
  for (const a of levels) m[a] = Object.fromEntries(levels.map((b) => [b, 0]));
  for (const [truth, got] of pairs) m[norm(truth)]![norm(got)]!++;
  const exact = pairs.filter(([a, b]) => norm(a) === norm(b)).length;
  const badge = (s: string) => ["urgent", "important"].includes(norm(s));
  const tp = pairs.filter(([a, b]) => badge(a) && badge(b)).length;
  const fp = pairs.filter(([a, b]) => !badge(a) && badge(b)).length;
  const fn = pairs.filter(([a, b]) => badge(a) && !badge(b)).length;
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
  const under = pairs.filter(([a, b]) => RANK[norm(b) as Level] < RANK[norm(a) as Level]).length;
  const over = pairs.filter(([a, b]) => RANK[norm(b) as Level] > RANK[norm(a) as Level]).length;
  return { n: pairs.length, exactAccuracy: exact / (pairs.length || 1), badge: { precision, recall, f1: (2 * precision * recall) / (precision + recall || 1), tp, fp, fn }, underRated: under, overRated: over, matrix: m };
}

async function synthetic() {
  const annPath = join(here, "synthetic-announcements.json");
  const mailPath = join(here, "synthetic-email.json");
  if (!existsSync(annPath) || !existsSync(mailPath)) return { skipped: "synthetic corpora not found" };
  const anns = JSON.parse(readFileSync(annPath, "utf8")) as any[];
  const mails = JSON.parse(readFileSync(mailPath, "utf8")) as any[];
  const now = Date.parse("2026-09-28T15:00:00Z");
  const { store, dir } = tempStore();
  // One synthetic course per course code, with the affected assignments at their stated due times.
  const courseId = (code: string) => `syn-${code.replace(/\W+/g, "").toLowerCase()}`;
  const policy = { mode: "unknown", evidence: "" };
  const courseRes = new Map<string, any[]>();
  const addAssignment = (code: string, title: string, days: number, key: string) => {
    const list = courseRes.get(code) ?? [];
    const due = iso(now + days * DAY);
    list.push({ externalId: `asg-${key}`, kind: "assignment", courseId: courseId(code), courseName: code, title, url: "https://example.edu/a", text: "Synthetic assignment.", dueAt: due, deadlines: [{ value: due, kind: "due", quote: `due_at: ${due}`, authority: "structured", scopeConfirmed: true }], submitted: false, policy });
    courseRes.set(code, list);
  };
  for (const a of anns) {
    if (a.affectedTitle && a.daysUntilAffectedDue !== null) addAssignment(a.course, a.affectedTitle, a.daysUntilAffectedDue, a.id);
    const list = courseRes.get(a.course) ?? [];
    list.push({ externalId: a.id, kind: "message", courseId: courseId(a.course), courseName: a.course, title: a.title, url: "https://example.edu/m", text: a.text, createdAt: iso(now - HOUR), policy });
    courseRes.set(a.course, list);
  }
  for (const e of mails) if (e.courseCode && e.affectedTitle && e.daysUntilAffectedDue !== null) addAssignment(e.courseCode, e.affectedTitle, e.daysUntilAffectedDue, e.id);
  for (const [code, resources] of courseRes)
    store.ingest(captureBatchSchema.parse({ source: { id: `syn:${code}`, label: code, kind: "canvas", accountScope: "syn", courseId: courseId(code), scope: "course-bench" }, observedAt: iso(now - 30 * 60e3), complete: true, status: "ok", resources }));
  store.ingest(captureBatchSchema.parse({
    source: { id: "syn:mail", label: "Outlook mail", kind: "mail", accountScope: "syn", courseId: OUTLOOK_MAIL_COURSE_ID, scope: "inbox" },
    observedAt: iso(now - 30 * 60e3), complete: true, status: "ok",
    resources: mails.map((e) => ({
      externalId: `mail:${e.id}`, kind: "message", courseId: OUTLOOK_MAIL_COURSE_ID, courseName: "Outlook mail", title: e.subject, url: "https://outlook.office.com/mail/", text: e.preview,
      createdAt: iso(now - HOUR), updatedAt: iso(now - HOUR), deadlines: [], policy,
      ...(e.canvasNotification ? { links: [{ url: "https://canvas.wisc.edu/courses/1/assignments/1", rel: "canvas-item" }] } : {}),
      mail: {
        messageId: `m-${e.id}`, folder: "Inbox", fromName: e.fromName, fromAddress: e.fromAddress, receivedAt: iso(now - HOUR), preview: String(e.preview).slice(0, 255),
        importance: e.importance, isRead: false, category: e.category,
        categoryReason: e.canvasNotification ? `Canvas notification links ${e.courseCode ?? "a course"}` : `Synthetic ${e.category}`,
        ...(e.courseCode ? { courseId: courseId(e.courseCode), courseAccountScope: "syn" } : {}),
        ...(e.meetingMessageType ? { meetingMessageType: e.meetingMessageType } : {}),
      },
    })),
  }));
  const views = resourceViews(store, store.resources());
  const byExt = new Map(views.map((v) => [v.externalId, v]));
  const nowIso = iso(now);
  const levelOf = (v: ResourceView, triage: Record<string, MessageTriageJudgment>, mailTriage: Record<string, MailTriageJudgment>, i: number): Level =>
    buildNotifications({ changes: [newChange(v, iso(now - 20 * 60e3), i)], resources: views, sources: [], baselineReadIds: [], included: () => true, triage, mailTriage, triageStatus: quiet, state: emptyNotificationState, now: nowIso, timeZone: TZ }).items.find((n) => n.resourceId === v.id)?.level ?? "suppressed";
  const upcomingFor = (cid: string) =>
    views.filter((v) => v.kind === "assignment" && v.courseId === cid && v.deadline.planningAt && Date.parse(v.deadline.planningAt) >= now && Date.parse(v.deadline.planningAt) <= now + 21 * DAY)
      .sort((a, b) => a.deadline.planningAt!.localeCompare(b.deadline.planningAt!)).slice(0, 10);
  const annRows: Record<string, unknown>[] = [];
  for (const [i, a] of anns.entries()) {
    const v = byExt.get(a.id)!;
    const code = levelOf(v, {}, {}, i);
    const row: Record<string, unknown> = { id: a.id, label: a.label, code_level: code };
    if (jev) {
      const up = upcomingFor(v.courseId);
      const state: MessageTriageState = { course: a.course, title: redactPii(a.title).text.slice(0, 500) || "Announcement", text: redactPii(a.text).text.slice(0, 4000), upcoming: up.map((u, k) => ({ key: `a${k}`, title: u.title, due: fmtDue(Date.parse(u.deadline.planningAt!)) })) };
      const t = performance.now();
      try {
        const result = await jev.triage(state);
        const { top, margin } = topOf(result.kindProbabilities);
        Object.assign(row, { latency_ms: Math.round(performance.now() - t), jev_kind: result.kind, jev_top: +top.toFixed(3), jev_margin: +margin.toFixed(3), jev_action: +result.actionRequired.toFixed(3),
          final_level: levelOf(v, { [v.id]: { result, upcoming: up.map((u, k) => ({ key: `a${k}`, resourceId: u.id, title: u.title })) } }, {}, i) });
      } catch (e) { row.jev_error = e instanceof Error ? e.message.slice(0, 80) : "error"; }
    }
    annRows.push(row);
  }
  const ROLE: Record<string, MailTriageState["role"]> = { course: "course staff", advisor: "academic advisor", admin: "university office", org: "student organization or mailing list", meeting: "meeting invitation", general: "unknown sender" };
  const mailRows: Record<string, unknown>[] = [];
  for (const [i, e] of mails.entries()) {
    const v = byExt.get(`mail:${e.id}`)!;
    const code = levelOf(v, {}, {}, 1000 + i);
    const row: Record<string, unknown> = { id: e.id, category: e.category, label: e.label, code_level: code };
    // Core only sends unread mail in these categories that isn't a Canvas copy or a meeting message.
    const eligible = ["course", "admin", "org", "general"].includes(e.category) && !e.canvasNotification && !e.meetingMessageType;
    row.sent_to_jev = !!jev && eligible;
    if (jev && eligible) {
      const cid = e.courseCode ? courseId(e.courseCode) : undefined;
      const up = cid ? upcomingFor(cid) : [];
      const state: MailTriageState = { role: ROLE[e.category] ?? "unknown sender", subject: redactPii(e.subject).text.slice(0, 500) || "(no subject)", preview: redactPii(String(e.preview)).text.slice(0, 255), ...(e.courseCode ? { course: e.courseCode } : {}), upcoming: up.map((u, k) => ({ key: `a${k}`, title: u.title, due: fmtDue(Date.parse(u.deadline.planningAt!)) })) };
      const t = performance.now();
      try {
        const result = await jev.mail(state);
        const { top, margin } = topOf(result.kindProbabilities);
        Object.assign(row, { latency_ms: Math.round(performance.now() - t), jev_kind: result.kind, jev_top: +top.toFixed(3), jev_margin: +margin.toFixed(3), jev_action: +result.actionRequired.toFixed(3),
          final_level: levelOf(v, {}, { [v.id]: { result, upcoming: up.map((u, k) => ({ key: `a${k}`, resourceId: u.id, title: u.title })) } }, 1000 + i) });
      } catch (err) { row.jev_error = err instanceof Error ? err.message.slice(0, 80) : "error"; }
    } else row.final_level = code;
    mailRows.push(row);
  }
  writeCsv("b5_synthetic_announcements.csv", annRows);
  writeCsv("b6_synthetic_email.csv", mailRows);
  const matrixRows = (name: string, c: ReturnType<typeof confusion>) =>
    Object.entries(c.matrix).flatMap(([truth, row]) => Object.entries(row).map(([got, count]) => ({ corpus: name, truth, predicted: got, count })));
  const aCode = confusion(annRows.map((r) => [String(r.label), String(r.code_level)]));
  const mCode = confusion(mailRows.map((r) => [String(r.label), String(r.code_level)]));
  const result: Record<string, unknown> = { announcements: { n: anns.length, code: aCode }, email: { n: mails.length, code: mCode } };
  const matrices = [...matrixRows("announcements · code", aCode), ...matrixRows("email · code", mCode)];
  if (jev) {
    const aJ = confusion(annRows.filter((r) => r.final_level).map((r) => [String(r.label), String(r.final_level)]));
    const mJ = confusion(mailRows.filter((r) => r.final_level).map((r) => [String(r.label), String(r.final_level)]));
    (result.announcements as any).codeJev = aJ;
    (result.email as any).codeJev = mJ;
    matrices.push(...matrixRows("announcements · code+Jev", aJ), ...matrixRows("email · code+Jev", mJ));
  }
  writeCsv("b7_confusion_matrices.csv", matrices);
  rmSync(dir, { recursive: true, force: true });
  return result;
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
if (useJev) await startJev();
if (capturesDir) summary.real = await realData(resolve(capturesDir));
summary.synthetic = await synthetic();
summary.jevCalls = calls;
summary.rules = { windowDays: NOTIFICATION_RULES.windowDays, soonHours: NOTIFICATION_RULES.soonHours };
writeFileSync(join(outAbs, "summary.json"), JSON.stringify(summary, null, 2));
await jev?.close();
console.log(`Wrote aggregates to ${outAbs} · Jev calls ${calls}${useJev ? ` of ${maxCalls}` : ""}`);
