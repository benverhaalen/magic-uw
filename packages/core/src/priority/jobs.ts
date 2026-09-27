/**
 * The agenda's background work, as one job kind in the pipeline drain: `agenda.estimate`, a course
 * job (enqueued at the course's inventory hash whenever the course is saved). It writes code's
 * estimates with the linked material sizes, asks the student's AI once per item text hash (one
 * batched call per course), then refreshes the agenda's "why now" lines if the top items changed.
 * Everything that sends goes through `sendAgendaPack` (consent, scrub, receipt, cache, ledger).
 */
import type { Job, Resource, Store } from "@magic/contracts";
import type { CourseRef } from "../../../contracts/src/course-core";
import type { ModelRunner } from "../../../runner/src/index";
import { buildPrompt, packCacheKey, type CourseFrame } from "../../../packs/core/src/index";
import { estimatePack, type EstimateInput, type EstimateItemInput } from "../../../packs/estimate/src/index";
import { narratePack, type NarrateInput } from "../../../packs/narrate/src/index";
import { effectiveCoursePolicy } from "../../../domain/src/course-intelligence";
import { payloadHash } from "../egress";
import { payloadScrubber } from "../identity";
import { isPipelineStore } from "../graph/course-index";
import { references } from "../graph/references";
import type { JobHandler, JobOutcome, JobRegistry } from "../jobs/registry";
import { AGENDA_CONFIG, type AgendaConfig } from "./config";
import { clampMinutes, codeEstimate, correctEstimate, featuresOf, putEstimate, storedEstimates } from "./estimate";
import { readAgendaFacts, type AgendaFact } from "./items";
import { checkLine, localParts, narrationFact, narrationHash, type NarrationFact } from "./narrate";
import { invalidateAgenda, NARRATION_CHECKED, rankedAgenda, systemTimeZone } from "./query";
import { putChecked, readChecked, sendAgendaPack, type AgendaStore } from "./send";

export const AGENDA_ESTIMATE_JOB = "agenda.estimate";
const ESTIMATE_ARTIFACT = "agenda.estimate.pack.v1";
const NARRATION_ARTIFACT = "agenda.why.pack.v1";
const PROFILE_CHARS = 1200;
const WORDS_PER_TOKEN = 0.75;

export interface AgendaJobDeps {
  /** The student's own client, or null (code estimates and code lines only). */
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  now?: () => Date;
  timeZone?: () => string;
  config?: AgendaConfig;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function courseOf(store: Store, subjectId: string): CourseRef | undefined {
  const s = store.sources().find((x) => `${x.accountScope}:${x.courseId}` === subjectId);
  return s ? { accountScope: s.accountScope, courseId: s.courseId } : undefined;
}

/** The course frame: name, profile claims and policy, as the guide packs build it (D52). */
function frameFor(store: AgendaStore, course: CourseRef, label: string, sample: Resource | undefined, scrub: (v: string) => string): CourseFrame {
  const profile = store
    .courseIntelligence()
    .filter((ci) => ci.accountScope === course.accountScope && ci.courseId === course.courseId)
    .sort((a, b) => b.version - a.version)[0];
  const lines: string[] = [];
  let used = 0;
  for (const c of profile?.claims ?? []) {
    if (c.kind === "ai_policy") continue;
    const line = `- ${c.kind}: ${clip(collapse(c.label), 120)}${c.value === null || c.value === "" ? "" : `: ${clip(collapse(String(c.value)), 200)}`}`;
    if (used + line.length > PROFILE_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  const policy = sample ? effectiveCoursePolicy(profile, sample) : undefined;
  return {
    courseId: `${course.accountScope}:${course.courseId}`,
    course: scrub(label),
    skeleton: scrub([`Course: ${label}`, ...(lines.length ? ["Course profile:", ...lines] : [])].join("\n")),
    policy: scrub(policy && policy.mode !== "unknown" ? `${policy.mode}: ${policy.evidence}` : ""),
  };
}

/** Linked material sizes from the reference graph and passages. */
function materialsOf(store: AgendaStore, resourceId: string): { tokens: number; list: { title: string; words: number }[] } {
  let tokens = 0;
  const list: { title: string; words: number }[] = [];
  for (const ref of references(store, resourceId)) {
    if (!ref.resourceId) continue;
    const t = store.passages(ref.resourceId).filter((p) => !p.redacted).reduce((n, p) => n + p.tokEst, 0);
    if (!t) continue;
    tokens += t;
    list.push({ title: ref.title, words: Math.round(t * WORDS_PER_TOKEN) });
  }
  return { tokens, list };
}

/** `current`: the why-now lines match the agenda now (stored, cached or nothing to narrate). */
type Outcome = { status: "done" | "retry"; modelCalls: number; message: string; current?: boolean };

/** One narration send per store and fact hash at a time: the sync tick and the drain share it. */
const narrationsInFlight = new WeakMap<object, Map<string, Promise<Outcome>>>();

/**
 * Estimates one course's open items: code's (stored), then one batched model call for items that
 * have no model estimate at their current text hash. A repeat is a cache hit: 0 tokens.
 */
export async function estimateCourse(store: AgendaStore, course: CourseRef, deps: AgendaJobDeps, signal?: AbortSignal): Promise<Outcome> {
  const config = deps.config ?? AGENDA_CONFIG;
  const now = deps.now ?? (() => new Date());
  const at = () => now().toISOString();
  const timeZone = deps.timeZone?.() ?? systemTimeZone();
  const nowMs = now().getTime();
  const horizon = nowMs - config.overdueWindowDays * 86_400_000;
  const open = readAgendaFacts(store, timeZone, course).facts.filter((f) => {
    const due = Date.parse(f.dueAt ?? f.lockAt ?? "");
    return f.resourceId && !f.done && Number.isFinite(due) && due >= horizon;
  });
  const stored = storedEstimates(store.judgments().filter((j) => open.some((f) => f.resourceId === j.resourceId)));
  const materials = new Map<string, ReturnType<typeof materialsOf>>();
  for (const f of open) {
    const m = materialsOf(store, f.resourceId!);
    materials.set(f.id, m);
    const code = codeEstimate(featuresOf(f, m.tokens || null), config);
    const had = stored.get(f.resourceId!)?.code;
    if (!had || had.minutes !== code.minutes) putEstimate(store, "code", f.resourceId!, { minutes: code.minutes, parts: code.parts }, at());
  }
  // Soonest due first, in batches of modelBatchMax: the items due soonest get the model's estimate
  // first, and every open item gets one in this pass (the job is only re-enqueued when the course's
  // inventory changes, so a single capped batch would leave the rest on code-only estimates).
  const dueOf = (f: AgendaFact) => Date.parse(f.dueAt ?? f.lockAt ?? "");
  const unestimated = open
    .filter((f) => !stored.get(f.resourceId!)?.model && !stored.get(f.resourceId!)?.student)
    .sort((a, b) => dueOf(a) - dueOf(b));
  if (!unestimated.length) return { status: "done", modelCalls: 0, message: "Estimates are current." };
  const runner = await deps.runner();
  if (!runner) return { status: "done", modelCalls: 0, message: "Code estimates only: no AI client is connected." };

  const hosted = runner.client !== "local";
  const scrubber = payloadScrubber(store, hosted, course.accountScope);
  const scrub = (v: string) => scrubber.field(v, course.courseId);
  let modelCalls = 0;
  let refined = 0;
  for (let start = 0; start < unestimated.length; start += config.estimate.modelBatchMax) {
    if (signal?.aborted) return { status: "retry", modelCalls, message: "Interrupted." };
    const pending = unestimated.slice(start, start + config.estimate.modelBatchMax);
    const resources = pending.map((f) => store.resource(f.resourceId!)).filter((r): r is Resource => !!r && !r.deleted);
    if (resources.length !== pending.length) return { status: "done", modelCalls, message: "Items changed; estimates wait for the next pass." };
    const byLocal = new Map<string, AgendaFact>();
    const items: EstimateItemInput[] = pending.map((f, i) => {
      const r = resources[i]!;
      const id = `e${i + 1}`;
      byLocal.set(id, f);
      const code = codeEstimate(featuresOf(f, materials.get(f.id)?.tokens || null), config);
      return {
        id,
        kind: f.kind,
        title: scrub(f.title),
        points: f.points,
        questions: f.features.questionCount,
        rubricCriteria: f.features.rubricCriteria,
        materials: (materials.get(f.id)?.list ?? []).slice(0, 8).map((m) => `${scrub(m.title)} (about ${m.words} words)`),
        codeMinutes: code.minutes,
        codeBasis: code.parts,
        instructions: scrub(clip(collapse(r.text), config.estimate.modelTextChars)),
      };
    });
    const input: EstimateInput = { items };
    const label = pending[0]!.courseName;
    const frame = frameFor(store, course, label, resources[0], scrub);
    const prompt = buildPrompt(estimatePack, frame, input, []);
    const cacheKey = payloadHash({ v: "agenda-estimate-projection-v1", route: runner.client, key: packCacheKey(estimatePack, prompt.systemPrompt, input, []) });
    const anchorHash = store.resourceTextHash(pending[0]!.resourceId!);
    if (!anchorHash) return { status: "done", modelCalls, message: "Items changed; estimates wait for the next pass." };
    const result = await sendAgendaPack(
      { store, runner, now, lane: "background", ...(signal ? { signal } : {}) },
      {
        pack: estimatePack,
        frame,
        input,
        resources,
        purpose: "Estimate how long your upcoming coursework takes",
        cacheKey,
        anchor: { resourceId: pending[0]!.resourceId!, inputHash: anchorHash },
        artifactQuestion: ESTIMATE_ARTIFACT,
        course,
      },
    );
    if (result.status === "paused") return { status: "retry", modelCalls, message: result.message };
    if (result.status !== "done") return { status: "done", modelCalls, message: result.status === "blocked" ? result.reason : result.status === "needs_student" ? result.question : result.message };
    for (const row of result.artifact.output.items) {
      const f = byLocal.get(row.id);
      if (!f) continue;
      putEstimate(store, "model", f.resourceId!, { minutes: clampMinutes(row.minutes, config), model: result.artifact.model, basis: row.basis ? clip(row.basis, 200) : null }, at());
    }
    invalidateAgenda(store);
    if (!result.cached) modelCalls++;
    refined += result.artifact.output.items.length;
  }
  return { status: "done", modelCalls, message: `${refined} estimates refined.` };
}

/**
 * Writes the "why now" lines for the current top items, once per agenda change (the fact hash
 * covers the top items' facts and the local day). Code checks every line; failures are dropped.
 */
export async function narrateAgenda(store: AgendaStore, deps: AgendaJobDeps, signal?: AbortSignal): Promise<Outcome> {
  const config = deps.config ?? AGENDA_CONFIG;
  const now = deps.now ?? (() => new Date());
  const timeZone = deps.timeZone?.() ?? systemTimeZone();
  const nowMs = now().getTime();
  const { result } = rankedAgenda(store, timeZone, nowMs, config);
  const top = result.ranked.slice(0, config.narrationTopN);
  if (!top.length) return { status: "done", modelCalls: 0, message: "Nothing to narrate.", current: true };
  const factHash = narrationHash(top, nowMs, timeZone);
  if (readChecked(store, NARRATION_CHECKED, factHash)) return { status: "done", modelCalls: 0, message: "The why-now lines are current.", current: true };
  let inFlight = narrationsInFlight.get(store);
  if (!inFlight) narrationsInFlight.set(store, (inFlight = new Map()));
  const shared = inFlight.get(factHash);
  if (shared) return shared;
  const run = (async (): Promise<Outcome> => {
    const anchorItem = top.find((r) => r.fact.resourceId);
    const anchorHash = anchorItem && store.resourceTextHash(anchorItem.fact.resourceId!);
    if (!anchorItem || !anchorHash) return { status: "done", modelCalls: 0, message: "No captured item to keep the lines with." };
    const runner = await deps.runner();
    if (!runner) return { status: "done", modelCalls: 0, message: "Code lines only: no AI client is connected." };

    const hosted = runner.client !== "local";
    const scrubbers = new Map<string, ReturnType<typeof payloadScrubber>>();
    const scrubFor = (accountScope: string, courseId: string) => {
      let s = scrubbers.get(accountScope);
      if (!s) scrubbers.set(accountScope, (s = payloadScrubber(store, hosted, accountScope)));
      return (v: string) => s!.field(v, courseId);
    };
    const resources: Resource[] = [];
    const facts: NarrationFact[] = [];
    const byLocal = new Map<string, (typeof top)[number]>();
    top.forEach((item, i) => {
      const f = item.fact;
      const scrub = scrubFor(f.accountScope, f.courseId);
      const r = f.resourceId ? store.resource(f.resourceId) : undefined;
      if (r) resources.push(r);
      const covers = f.resourceId ? references(store, f.resourceId).filter((x) => x.resourceId).slice(0, 3).map((x) => scrub(x.title)) : [];
      const id = `n${i + 1}`;
      byLocal.set(id, item);
      facts.push(narrationFact(item, id, nowMs, timeZone, { course: scrub(f.courseName), title: scrub(f.title), covers }));
    });
    const today = localParts(nowMs, timeZone);
    const input: NarrateInput = { today: `${today.weekdayLong}, ${today.monthLong} ${today.day}, ${today.year}`, items: facts };
    const frame: CourseFrame = {
      courseId: "agenda",
      course: "Your agenda",
      skeleton: `Courses: ${[...new Set(facts.map((f) => f.course))].join("; ")}`,
      policy: "Planning only: this call writes no coursework.",
    };
    const prompt = buildPrompt(narratePack, frame, input, []);
    const cacheKey = payloadHash({ v: "agenda-why-projection-v1", factHash, key: packCacheKey(narratePack, prompt.systemPrompt, input, []) });
    const anchor = { resourceId: anchorItem.fact.resourceId!, inputHash: anchorHash };
    const sent = await sendAgendaPack(
      { store, runner, now, lane: "background", ...(signal ? { signal } : {}) },
      { pack: narratePack, frame, input, resources, purpose: "Write why-now lines for your agenda", cacheKey, anchor, artifactQuestion: NARRATION_ARTIFACT, course: null },
    );
    if (sent.status === "paused") return { status: "retry", modelCalls: 0, message: sent.message };
    if (sent.status !== "done") return { status: "done", modelCalls: 0, message: sent.status === "blocked" ? sent.reason : sent.status === "needs_student" ? sent.question : sent.message };
    const lines: Record<string, string> = {};
    let dropped = 0;
    for (const line of sent.artifact.output.lines) {
      const item = byLocal.get(line.id);
      const fact = facts.find((f) => f.id === line.id);
      if (!item || !fact) continue;
      const verdict = checkLine(line.text, fact, item, nowMs, timeZone, config);
      if (verdict.ok) lines[item.fact.id] = line.text.trim();
      else dropped++;
    }
    putChecked(store, NARRATION_CHECKED, factHash, anchor, { lines, dropped, model: sent.artifact.model }, now().toISOString());
    return { status: "done", modelCalls: sent.cached ? 0 : 1, current: true, message: `${Object.keys(lines).length} why-now lines${dropped ? `; ${dropped} dropped by the checks` : ""}.` };
  })().finally(() => inFlight!.delete(factHash));
  inFlight.set(factHash, run);
  return run;
}

/** The `agenda.estimate` course job for the pipeline drain. */
export function agendaEstimateJob(deps: AgendaJobDeps): JobHandler {
  return {
    kind: AGENDA_ESTIMATE_JOB,
    subject: "course",
    ready: true,
    owner: "agenda",
    async run(job: Job, context): Promise<JobOutcome> {
      const store = context.store;
      if (!isPipelineStore(store)) return { status: "done" };
      const subjectId = (job as Job & { subjectId?: string }).subjectId ?? "";
      const course = courseOf(store, subjectId);
      if (!course) return { status: "done" };
      const estimated = await estimateCourse(store, course, deps, context.signal);
      if (estimated.status === "retry") return { status: "retry", error: estimated.message };
      const narrated = await narrateAgenda(store, deps, context.signal);
      invalidateAgenda(store);
      return narrated.status === "retry" ? { status: "retry", error: narrated.message } : { status: "done" };
    },
  };
}

/** Registers the agenda's job on the registry the drain leases from (the worker calls this). */
export function registerAgendaJobs(registry: JobRegistry, deps: AgendaJobDeps): void {
  registry.register(agendaEstimateJob(deps));
}

/**
 * The `correct` command's `estimate` subject (the worker's `seams.correct` routes it here). The
 * student's number wins and updates the course's calibration.
 */
export function correctAgendaEstimate(store: Store, value: { resourceId: string; minutes: number }, at: string, timeZone: string = systemTimeZone()): string {
  if (!isPipelineStore(store)) return "Estimates aren't available in this workspace.";
  const r = store.resource(value.resourceId);
  if (!r || r.deleted) return "This item is no longer available; nothing was saved.";
  const s = store.sources().find((x) => x.id === r.sourceId);
  const fact = s && readAgendaFacts(store, timeZone, { accountScope: s.accountScope, courseId: r.courseId }).facts.find((f) => f.resourceId === r.id);
  if (!fact) return "Only a dated assignment, quiz, exam or discussion has an estimate to correct.";
  const message = correctEstimate(store, value, fact, at);
  invalidateAgenda(store);
  return message;
}
