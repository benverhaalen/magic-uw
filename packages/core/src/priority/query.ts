/**
 * The instant views (D49): `agenda.ranked` and `workspace.bootstrap`, served from the local
 * database through scoped reads. No network, no model call: the ranking, estimates and fallback
 * lines are code's, and a "why now" line appears only if a background job already wrote and
 * checked it. They work at launch before any sync, on whatever was last captured.
 *
 * The expensive part (decoding the dated items) is cached per store and rebuilt when any source is
 * read again, a course override or setting changes, or `memoMaxAgeMs` passes; the ranking itself
 * is recomputed on every call, since slack moves with the clock.
 */
import type { AgendaClassMeeting, AgendaItem, AgendaNarration, AgendaQueryResult, Assessment, BootstrapCourse, Store } from "@magic/contracts";
import { payloadHash } from "../egress";
import { addDays, dayStart, localDate } from "../graph/agenda";
import { isPipelineStore } from "../graph/course-index";
import { createPipelineReferences } from "../graph/references-port";
import { courseAnalytics } from "../../../learning/src/analytics/rollup";
import type { LearningStore } from "../../../learning/src/store";
import { AGENDA_CONFIG, type AgendaConfig } from "./config";
import { calibrations, resolveEstimate, storedEstimates } from "./estimate";
import { readAgendaFacts, type AgendaFact, type AgendaFacts } from "./items";
import { codeLine, narrationHash } from "./narrate";
import { rankAgenda, type RankedItem, type RankResult } from "./rank";
import { readChecked } from "./send";

export const NARRATION_CHECKED = "agenda.why.checked.v1";

interface Memo {
  key: string;
  builtAt: number;
  data: AgendaFacts;
}
const memos = new WeakMap<Store, Memo>();
const generations = new WeakMap<Store, number>();
/** Drop the cached facts (after a correction, an estimate job or a completion change). */
export function invalidateAgenda(store: Store): void {
  generations.set(store, (generations.get(store) ?? 0) + 1);
  memos.delete(store);
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function facts(store: Store, timeZone: string, nowMs: number, config: AgendaConfig): AgendaFacts {
  const sources = store.sources();
  const assessments = (store as Store & { assessments?: () => Assessment[] }).assessments?.() ?? [];
  const key = payloadHash({
    s: sources.map((s) => [s.id, s.lastAttemptAt, s.lastSuccessAt, s.status, s.resourceCount, s.complete]),
    o: store.courseOverrides(),
    i: store.ingestionSettings(),
    a: assessments.map((a) => [a.id, a.updatedAt]),
    tz: timeZone,
    g: generations.get(store) ?? 0,
  });
  const hit = memos.get(store);
  if (hit && hit.key === key && nowMs - hit.builtAt < config.memoMaxAgeMs && nowMs >= hit.builtAt) return hit.data;
  const data = readAgendaFacts(store, timeZone, undefined, sources);
  memos.set(store, { key, builtAt: nowMs, data });
  return data;
}

type LearningCapable = Store & { learning?: LearningStore };
/** Weak share of each upcoming exam's topics, from practice analytics; read only to break a tie. */
function readiness(store: Store, nowMs: number): (fact: AgendaFact) => number | null {
  const learning = (store as LearningCapable).learning;
  if (!learning || !isPipelineStore(store)) return () => null;
  const byCourse = new Map<string, Map<string, number | null>>();
  let references: ReturnType<typeof createPipelineReferences> | undefined;
  return (fact) => {
    const ref = `${fact.accountScope}:${fact.courseId}`;
    let exams = byCourse.get(ref);
    if (!exams) {
      exams = new Map();
      if (learning.concepts(ref).some((c) => c.kind === "concept" && c.status === "active")) {
        const data = courseAnalytics({ store: learning, ref, courseId: fact.courseId, references: (references ??= createPipelineReferences(store)), now: new Date(nowMs) });
        for (const e of data.exams) {
          const d = e.distribution;
          const total = d.solid + d.getting_there + d.iffy + d.not_seen;
          exams.set(e.assessmentId, total ? (d.iffy + d.not_seen) / total : null);
        }
      }
      byCourse.set(ref, exams);
    }
    return exams.get(fact.resourceId ?? fact.id.replace(/^assessment:/, "")) ?? null;
  };
}

/** Class meetings from the planning enrollment, for display only. */
function classes(store: Store, timeZone: string, nowMs: number, config: AgendaConfig): AgendaClassMeeting[] {
  const today = localDate(nowMs, timeZone);
  const out: AgendaClassMeeting[] = [];
  for (const record of store.planningRecords()) {
    if (record.deleted || record.kind !== "enrollment_package" || record.enrollmentState !== "enrolled") continue;
    for (const meeting of record.meetings) {
      if (meeting.kind !== "class" || meeting.mode !== "scheduled" || meeting.startMinute === null) continue;
      for (let d = 0; d < config.classWindowDays; d++) {
        const date = addDays(today, d);
        if ((meeting.startDate && date < meeting.startDate) || (meeting.endDate && date > meeting.endDate)) continue;
        const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
        if (!meeting.days.includes(weekday)) continue;
        const at = dayStart(date, meeting.timezone) + meeting.startMinute * 60_000;
        if (at < nowMs) continue;
        out.push({ key: `C:${record.localId}:${date}:${meeting.startMinute}`, courseKey: record.courseKey, title: `${record.courseKey} ${record.sections.join(", ")}`, startsAt: new Date(at).toISOString() });
      }
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

interface Ranked {
  result: RankResult;
  narration: AgendaNarration;
  lines: Record<string, string>;
  data: AgendaFacts;
  /** The same ranking over a subset (a course), with the same estimates and readiness. */
  rank(keep: (f: AgendaFact) => boolean): RankResult;
}
/** The global ranking and its cached narration. Pure reads. */
export function rankedAgenda(store: Store, timeZone: string, nowMs: number, config: AgendaConfig = AGENDA_CONFIG): Ranked {
  const data = facts(store, timeZone, nowMs, config);
  const stored = storedEstimates(store.judgments());
  const cal = calibrations(data.facts, stored, config);
  const today = localDate(nowMs, timeZone);
  const ready = readiness(store, nowMs);
  const checkedDone = new Set<string>();
  const rank = (keep: (f: AgendaFact) => boolean = () => true): RankResult => {
    const run = () =>
      rankAgenda(data.facts.filter((f) => keep(f) && !checkedDone.has(f.id)), {
        now: nowMs,
        estimate: (f) => resolveEstimate(f, f.resourceId ? stored.get(f.resourceId) : undefined, cal.get(`${f.accountScope}\n${f.courseId}`) ?? 1, config),
        readiness: ready,
        todayEnd: dayStart(addDays(today, 1), timeZone),
        weekEnd: dayStart(addDays(today, 7), timeZone),
        config,
      });
    let result = run();
    // A completion the student marked here isn't a re-read of any source: check the items shown.
    for (let pass = 0; pass < 3; pass++) {
      const shown = result.ranked.slice(0, config.topN).filter((r) => r.fact.resourceId);
      const finished = shown.filter((r) => store.resource(r.fact.resourceId!)?.completed === true);
      if (!finished.length) break;
      for (const r of finished) checkedDone.add(r.fact.id);
      result = run();
    }
    return result;
  };
  const result = rank();
  const top = result.ranked.slice(0, config.narrationTopN);
  const factHash = narrationHash(top, nowMs, timeZone);
  const checked = top.length ? readChecked(store, NARRATION_CHECKED, factHash) : undefined;
  const body = checked?.result as { lines?: Record<string, string>; dropped?: number } | undefined;
  const lines = body?.lines && typeof body.lines === "object" ? body.lines : {};
  const narrated = top.filter((r) => typeof lines[r.fact.id] === "string").length;
  return {
    result,
    lines,
    data,
    rank,
    narration: {
      status: !top.length || !narrated ? "code" : narrated === top.length ? "model" : "partial",
      factHash,
      dropped: typeof body?.dropped === "number" ? body.dropped : 0,
    },
  };
}

export function toItem(r: RankedItem, rank: number, lines: Record<string, string>, nowMs: number, timeZone: string): AgendaItem {
  const f = r.fact;
  const line = lines[f.id];
  return {
    id: f.id,
    resourceId: f.resourceId,
    kind: f.kind,
    title: f.title,
    accountScope: f.accountScope,
    courseId: f.courseId,
    courseName: f.courseName,
    url: f.url,
    dueAt: new Date(r.dueMs).toISOString(),
    dateKind: r.dateKind,
    lockAt: f.lockAt,
    unlockAt: f.unlockAt,
    estimate: r.estimate,
    latestStartAt: new Date(r.latestStartMs).toISOString(),
    slackMinutes: r.slackMinutes,
    band: r.band,
    weight: { points: f.points, grade: f.grade },
    flags: r.flags,
    why: typeof line === "string" ? { text: line, source: "model" } : { text: codeLine(r, nowMs, timeZone), source: "code" },
    rank,
  };
}

export function agendaRankedView(
  store: Store,
  request: { limit?: number; accountScope?: string; courseId?: string; timeZone?: string },
  now: string,
  config: AgendaConfig = AGENDA_CONFIG,
): Extract<AgendaQueryResult, { view: "agenda.ranked" }> {
  const timeZone = request.timeZone ?? systemTimeZone();
  const nowMs = Date.parse(now);
  const global = rankedAgenda(store, timeZone, nowMs, config);
  // A course view ranks that course's items; the narration stays the global top's.
  const scoped = request.courseId || request.accountScope
    ? global.rank((f) => (!request.courseId || f.courseId === request.courseId) && (!request.accountScope || f.accountScope === request.accountScope))
    : global.result;
  return {
    view: "agenda.ranked",
    generatedAt: now,
    timeZone,
    items: scoped.ranked.slice(0, request.limit ?? config.topN).map((r, i) => toItem(r, i + 1, global.lines, nowMs, timeZone)),
    total: scoped.ranked.length,
    missing: scoped.missing.map((r) => toItem(r, 0, global.lines, nowMs, timeZone)),
    counts: scoped.counts,
    classes: classes(store, timeZone, nowMs, config),
    narration: global.narration,
    modelCalls: 0,
  };
}

const ATTENTION = new Set(["needs_sign_in", "error", "inaccessible", "needs_attention"]);

export function workspaceBootstrapView(
  store: Store,
  request: { top?: number; timeZone?: string },
  now: string,
  config: AgendaConfig = AGENDA_CONFIG,
): Extract<AgendaQueryResult, { view: "workspace.bootstrap" }> {
  const timeZone = request.timeZone ?? systemTimeZone();
  const nowMs = Date.parse(now);
  const { result, lines, narration, data } = rankedAgenda(store, timeZone, nowMs, config);
  const courses = new Map<string, BootstrapCourse>();
  for (const c of data.courses)
    courses.set(`${c.accountScope}\n${c.courseId}`, { ...c, open: 0, missing: 0, nextDueAt: null });
  for (const r of [...result.ranked, ...result.missing]) {
    const key = `${r.fact.accountScope}\n${r.fact.courseId}`;
    const row = courses.get(key) ?? { accountScope: r.fact.accountScope, courseId: r.fact.courseId, courseName: r.fact.courseName, included: true, open: 0, missing: 0, nextDueAt: null };
    row.open++;
    if (r.flags.missing) row.missing++;
    const due = new Date(r.dueMs).toISOString();
    if (r.dueMs >= nowMs && (!row.nextDueAt || due < row.nextDueAt)) row.nextDueAt = due;
    courses.set(key, row);
  }
  const sources = data.sources;
  const lastSyncAt = sources.reduce<string | null>((max, s) => (s.lastSuccessAt && (!max || s.lastSuccessAt > max) ? s.lastSuccessAt : max), null);
  return {
    view: "workspace.bootstrap",
    generatedAt: now,
    timeZone,
    fixtureMode: sources.some((s) => s.kind === "fixture"),
    lastSyncAt,
    sources: { total: sources.length, ok: sources.filter((s) => s.status === "ok").length, attention: sources.filter((s) => ATTENTION.has(s.status)).length },
    courses: [...courses.values()]
      .sort((a, b) => Number(b.included) - Number(a.included) || a.courseName.localeCompare(b.courseName))
      .slice(0, 100),
    agenda: {
      items: result.ranked.slice(0, request.top ?? config.topN).map((r, i) => toItem(r, i + 1, lines, nowMs, timeZone)),
      total: result.ranked.length,
      missing: result.missing.length,
      counts: result.counts,
      classes: classes(store, timeZone, nowMs, config),
      narration,
    },
    modelCalls: 0,
  };
}
