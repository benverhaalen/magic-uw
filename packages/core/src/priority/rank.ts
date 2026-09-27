/**
 * The critical-action order (D49), decided by code: latest start = due (or lock) − estimate −
 * buffer; slack = latest start − now; least slack first (earliest-deadline-first with durations).
 * Items whose slack falls in the same window tie, and ties break on weight, then readiness (weak
 * topics for an upcoming exam), then availability (not yet unlocked sinks).
 */
import type { AgendaBand, AgendaCounts, AgendaEstimate, AgendaItem } from "@magic/contracts";
import { AGENDA_CONFIG, type AgendaConfig } from "./config";
import type { AgendaFact } from "./items";

const MIN = 60_000;
const DAY = 86_400_000;

export interface RankedItem {
  fact: AgendaFact;
  estimate: AgendaEstimate;
  dueMs: number;
  dateKind: "due" | "closes";
  latestStartMs: number;
  slackMinutes: number;
  band: AgendaBand;
  flags: AgendaItem["flags"];
}
export interface RankResult {
  ranked: RankedItem[];
  /** Flagged, not ranked: closed without a submission, or overdue past the window. */
  missing: RankedItem[];
  counts: AgendaCounts;
}
export interface RankOptions {
  now: number;
  estimate: (fact: AgendaFact) => AgendaEstimate;
  /** Share of the exam's topics still weak (0–1), or null; called only to break a tie. */
  readiness?: (fact: AgendaFact) => number | null;
  /** The student's local day boundaries, for the today and this-week counts. */
  todayEnd?: number;
  weekEnd?: number;
  config?: AgendaConfig;
}

function bandOf(slackMinutes: number, dueMs: number, now: number): AgendaBand {
  if (dueMs < now) return "overdue";
  if (slackMinutes < 0) return "start_now";
  if (slackMinutes < 24 * 60) return "today";
  if (slackMinutes < 3 * 24 * 60) return "soon";
  if (slackMinutes < 7 * 24 * 60) return "week";
  return "later";
}

/** Weight compares like with like: two computed shares, or two listed weights; otherwise points. */
function byWeight(a: AgendaFact, b: AgendaFact): number {
  if (a.grade && b.grade && a.grade.basis === b.grade.basis && a.grade.percent !== b.grade.percent) return b.grade.percent - a.grade.percent;
  return (b.points ?? -1) - (a.points ?? -1);
}

export function rankAgenda(facts: AgendaFact[], options: RankOptions): RankResult {
  const config = options.config ?? AGENDA_CONFIG;
  const now = options.now;
  const counts: AgendaCounts = {
    open: 0, ranked: 0, overdue: 0, missing: 0, dueToday: 0, dueThisWeek: 0, undated: 0, notYetOpen: 0,
    estimatedBy: { code: 0, model: 0, student: 0 },
  };
  const ranked: RankedItem[] = [];
  const missing: RankedItem[] = [];
  for (const fact of facts) {
    if (fact.done) continue;
    const due = fact.dueAt ?? fact.lockAt;
    const dueMs = due ? Date.parse(due) : NaN;
    if (!Number.isFinite(dueMs)) {
      counts.undated++;
      continue;
    }
    const estimate = options.estimate(fact);
    const latestStartMs = dueMs - (estimate.minutes + config.bufferMinutes) * MIN;
    const slackMinutes = Math.round((latestStartMs - now) / MIN);
    const lockMs = fact.lockAt ? Date.parse(fact.lockAt) : NaN;
    const past = dueMs < now;
    const closed = Number.isFinite(lockMs) && lockMs <= now;
    const unlockMs = fact.unlockAt ? Date.parse(fact.unlockAt) : NaN;
    const flags = {
      // Canvas's own flag, or past due with nothing submitted where Canvas expects a submission.
      missing: fact.canvasMissing || (past && fact.needsSubmission),
      late: past && !closed,
      notYetOpen: Number.isFinite(unlockMs) && unlockMs > now,
    };
    const item: RankedItem = {
      fact,
      estimate,
      dueMs,
      dateKind: fact.dueAt ? "due" : "closes",
      latestStartMs,
      slackMinutes,
      band: bandOf(slackMinutes, dueMs, now),
      flags,
    };
    // Past with nothing expected online and no Canvas missing flag (an exam, paper work): it's over.
    if (past && !flags.missing) continue;
    counts.open++;
    counts.estimatedBy[estimate.method]++;
    if (flags.notYetOpen) counts.notYetOpen++;
    if (past && (closed || dueMs < now - config.overdueWindowDays * DAY)) {
      // Missing and can't be submitted any more, or long overdue: flagged, never hidden, not ranked.
      counts.missing++;
      missing.push(item);
      continue;
    }
    if (past) counts.overdue++;
    if (flags.missing) counts.missing++;
    if (options.todayEnd !== undefined && dueMs >= now && dueMs < options.todayEnd) counts.dueToday++;
    if (options.weekEnd !== undefined && dueMs >= now && dueMs < options.weekEnd) counts.dueThisWeek++;
    ranked.push(item);
  }
  const window = config.tieWindowMinutes;
  const readiness = new Map<string, number | null>();
  const ready = (f: AgendaFact) => {
    if (!readiness.has(f.id)) readiness.set(f.id, f.kind === "exam" || f.kind === "quiz" ? (options.readiness?.(f) ?? null) : null);
    return readiness.get(f.id)!;
  };
  const bySlack = (a: RankedItem, b: RankedItem) => a.slackMinutes - b.slackMinutes || a.dueMs - b.dueMs || a.fact.id.localeCompare(b.fact.id);
  const tieBreak = (a: RankedItem, b: RankedItem) => {
    const weight = byWeight(a.fact, b.fact);
    if (weight) return weight;
    const ra = ready(a.fact), rb = ready(b.fact);
    if (ra !== rb) return (rb ?? -1) - (ra ?? -1);
    if (a.flags.notYetOpen !== b.flags.notYetOpen) return a.flags.notYetOpen ? 1 : -1;
    return bySlack(a, b);
  };
  // Least slack first. A tie group starts at the least-slack item not yet placed and takes every
  // item within the window of it (no fixed clock boundaries splitting near-equal items).
  ranked.sort(bySlack);
  const ordered: RankedItem[] = [];
  for (let i = 0; i < ranked.length; ) {
    let j = i + 1;
    while (j < ranked.length && ranked[j]!.slackMinutes < ranked[i]!.slackMinutes + window) j++;
    ordered.push(...ranked.slice(i, j).sort(tieBreak));
    i = j;
  }
  counts.ranked = ordered.length;
  missing.sort((a, b) => b.dueMs - a.dueMs || a.fact.id.localeCompare(b.fact.id));
  return { ranked: ordered, missing, counts };
}
