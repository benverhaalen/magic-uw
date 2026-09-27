/**
 * The grade bank and study offers (owner: page-views). Code only, 0 tokens, never a grade prediction.
 *
 * Grade bank: each Canvas assignment group's weight (or the syllabus's, when Canvas lists none that
 * add up), the student's captured standing in it, and each item's share of the final grade. The
 * coverage rule (FDB-001): everything is account- and course-scoped (the course index is), and an
 * item's own share is computed only when the course's assignments were read completely, the weights
 * total 100%, the group drops nothing and every sibling has points. Otherwise the group's listed
 * weight is the most that's said (an upper bound on how far the item can move the grade), or the
 * share is `unknown` with its reason.
 *
 * Critical factor: grade impact × time until due × weakness of the item's linked topics. Impact is
 * the share (or the listed upper bound); urgency is the knowledge model's exam-proximity term
 * (1 + A·e^(−d/τ), the same constants `conceptPriority` uses); weakness comes from the topic states.
 * Tests rank higher by weight because their weight is higher, not by a rule about tests.
 */
import type {
  GradeBank,
  GradeGroupRow,
  GradeShare,
  OfferItem,
  PageEvidence,
  PageMissing,
  PageTopic,
  StudyOffer,
  StudyOffers,
} from "@magic/contracts";
import { learningRequestSchema, packScopeSchema } from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import { CONFIG, params } from "../../../learning/src/config";
import { examKind } from "../../../learning/src/analytics/references";
import { references } from "../graph/references";
import type { Res } from "../graph/course-index";
import {
  PageViewError,
  contextFor,
  copiesOf,
  deadlineClaims,
  fieldEvidence,
  included,
  namer,
  textEvidence,
  type ViewContext,
  type ViewStore,
} from "./common";
import { postedDetails, sheetRule, subjectFor } from "./details";
import { topicReader } from "./readiness";

const NOTE = "Shares of the final grade from Canvas groups and the syllabus, worked out on this device. Not a grade prediction.";
/** Weakness by topic state: starting values, not validated (the knowledge model's bands, coarsely). */
export const WEAKNESS: Record<string, number> = { not_seen: 1, iffy: 1, getting_there: 0.5, solid: 0.1 };
/** Stakes thresholds (percent of the final grade): starting values, not validated. */
export const STAKES = { lowBelow: 10, highFrom: 15 };
const round = (n: number) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface Bank {
  bank: GradeBank;
  complete: boolean;
  shareOf(r: Res): GradeShare;
  /** A syllabus-only assessment's share (its stated weight), by title. */
  shareOfRow(title: string, weight: number | null, evidence: PageEvidence | null): GradeShare;
}

export function gradeBank(ctx: ViewContext): Bank {
  const { course, index } = ctx;
  const groups = [...index.resources.values()].filter((r) => r.scope.startsWith("assignment-groups"));
  const items = [...index.assignmentById.values()];
  const read = (scope: string) =>
    [...ctx.sources.values()].find((s) => s.accountScope === course.accountScope && s.courseId === course.courseId && s.scope.split(":")[0] === scope);
  const assignments = read("assignments");
  const complete = !!assignments && assignments.complete && assignments.status === "ok";

  // Weights: Canvas's; else the syllabus brief's grading rows that name each group, when those add up.
  const brief = ctx.store.courseBrief(course);
  const syllabus = brief ? index.resources.get(brief.syllabusResourceId) : undefined;
  const canvasTotal = groups.reduce((n, g) => n + (g.assignmentGroup?.weight ?? 0), 0);
  const canvasWeighted = canvasTotal >= 99 && canvasTotal <= 101;
  const syllabusWeight = new Map<string, { weight: number; evidence: PageEvidence }>();
  if (!canvasWeighted && brief)
    for (const g of groups) {
      const row = brief.brief.grading.find((x) => {
        const label = norm(x.label);
        return label && (label.includes(norm(g.title)) || norm(g.title).includes(label)) && /\d\s*%/.test(x.value);
      });
      const pct = row ? Number(/(\d{1,3}(?:\.\d+)?)\s*%/.exec(row.value)?.[1]) : NaN;
      if (row && Number.isFinite(pct)) {
        const ev = syllabus && syllabus.text.slice(row.start, row.end) === row.quote ? textEvidence(ctx, syllabus, row.start, row.end) : null;
        syllabusWeight.set(g.externalId, { weight: pct, evidence: ev ? { ...ev, origin: "course_profile" } : fieldEvidence(ctx, null, "brief.grading", row.quote, "course_profile", "Course profile") });
      }
    }
  const syllabusTotal = [...syllabusWeight.values()].reduce((n, x) => n + x.weight, 0);
  const weighting: GradeBank["weighting"] = canvasWeighted || (syllabusTotal >= 99 && syllabusTotal <= 101) ? "weighted" : groups.length && groups.every((g) => !g.assignmentGroup?.weight) ? "unweighted" : "unknown";
  const weightOf = (g: Res) => (canvasWeighted ? g.assignmentGroup?.weight ?? null : syllabusWeight.get(g.externalId)?.weight ?? null);

  const siblings = (groupId: string) => items.filter((x) => x.assignmentGroupId === groupId);
  const rows: GradeGroupRow[] = groups.map((g) => {
    const members = siblings(g.externalId);
    const graded = members.filter((x) => x.submission?.score != null && !x.submission.excused && (x.points ?? 0) > 0);
    const earned = graded.reduce((n, x) => n + (x.submission!.score ?? 0), 0);
    const possible = graded.reduce((n, x) => n + (x.points ?? 0), 0);
    const weight = weightOf(g);
    return {
      groupId: g.externalId,
      title: g.title,
      weight,
      weightBasis: weight === null ? "none" : canvasWeighted ? "canvas" : "syllabus",
      drops: { lowest: g.assignmentGroup?.rules?.dropLowest ?? 0, highest: g.assignmentGroup?.rules?.dropHighest ?? 0 },
      standing: possible > 0 ? { earned, possible, percent: round((100 * earned) / possible), graded: graded.length, items: members.length } : null,
      evidence: canvasWeighted
        ? [fieldEvidence(ctx, g, "assignmentGroup.weight", g.assignmentGroup?.weight ?? null)]
        : syllabusWeight.has(g.externalId) ? [syllabusWeight.get(g.externalId)!.evidence] : [],
    };
  });
  const courseRes = [...index.resources.values()].find((r) => r.kind === "course");
  const score = courseRes?.course?.gradeEvidence?.[0];
  const status: GradeBank["status"] = weighting === "unknown" || !groups.length ? "unknown" : complete ? "complete" : "partial";
  const reason =
    !groups.length ? "No assignment groups were captured for this course."
    : weighting === "unknown" ? "The group weights don't add up to 100%, so Canvas may not apply them."
    : !complete ? "Not every assignment of this course is known to be captured, so only group weights are listed."
    : null;

  const unknown = (r: { id: string | null; title: string }, why: string, text: string, groupId: string | null = null, evidence: PageEvidence[] = []): GradeShare => ({
    resourceId: r.id,
    title: r.title,
    basis: "unknown",
    sharePercent: null,
    maxMovePercent: null,
    groupId,
    reason: why,
    text,
    evidence,
  });
  // A syllabus row that states this item's own weight ("Midterm 1 ... 20%").
  const statedWeight = (title: string): { weight: number; evidence: PageEvidence } | null => {
    const names = namer(ctx, title, null);
    const row = brief?.brief.assessments.find((a) => a.weight != null && names.text(a.title));
    if (!row) return null;
    const ev = syllabus && syllabus.text.slice(row.start, row.end) === row.quote ? textEvidence(ctx, syllabus, row.start, row.end) : null;
    return { weight: row.weight!, evidence: ev ? { ...ev, origin: "course_profile" } : fieldEvidence(ctx, null, "brief.assessments", row.quote, "course_profile", "Course profile") };
  };
  const syllabusShare = (r: { id: string | null; title: string }, stated: { weight: number; evidence: PageEvidence }): GradeShare => ({
    resourceId: r.id,
    title: r.title,
    basis: "syllabus",
    sharePercent: stated.weight,
    maxMovePercent: stated.weight,
    groupId: null,
    reason: null,
    text: `${stated.weight}% of the final grade, as the syllabus states.`,
    evidence: [stated.evidence],
  });

  function shareOf(r: Res): GradeShare {
    const stated = statedWeight(r.title);
    if (stated) return syllabusShare(r, stated);
    if (!r.assignmentGroupId) return unknown(r, "no_group", "Not in an assignment group, so its share of the grade isn't known.");
    const g = groups.find((x) => x.externalId === r.assignmentGroupId);
    if (!g) return unknown(r, "group_not_captured", "Its assignment group wasn't captured, so its share isn't known.", r.assignmentGroupId);
    const members = siblings(g.externalId);
    if (weighting === "unweighted") {
      const all = items.filter((x) => (x.points ?? 0) > 0);
      if (!complete || !r.points || items.some((x) => !x.points && x.submissionTypes?.some((t) => t !== "not_graded")))
        return unknown(r, complete ? "no_points" : "partial_capture", "The course isn't weighted by group and not every item's points are known, so its share isn't known.", g.externalId);
      const total = all.reduce((n, x) => n + x.points!, 0);
      const share = round((100 * r.points) / total);
      return { resourceId: r.id, title: r.title, basis: "computed", sharePercent: share, maxMovePercent: share, groupId: g.externalId, reason: null, text: `About ${share}% of the final grade (${r.points} of the course's ${total} points).`, evidence: [fieldEvidence(ctx, r, "points", r.points)] };
    }
    if (weighting === "unknown") return unknown(r, "weights_do_not_total_100", "The group weights don't add up to 100%, so its share isn't known.", g.externalId);
    const weight = weightOf(g);
    const evidence = rows.find((x) => x.groupId === g.externalId)?.evidence ?? [];
    if (!weight) return unknown(r, "zero_weight_group", `${g.title} counts 0% of the grade.`, g.externalId, evidence);
    const listed = (why: string): GradeShare => ({
      resourceId: r.id,
      title: r.title,
      basis: "listed",
      sharePercent: null,
      maxMovePercent: weight,
      groupId: g.externalId,
      reason: why,
      text: `Counts in ${g.title}, ${weight}% of the grade as listed; this item's own share isn't known (${why.replaceAll("_", " ")}).`,
      evidence,
    });
    if (!complete) return listed("partial_capture");
    const rules = g.assignmentGroup?.rules;
    if ((rules?.dropLowest ?? 0) > 0 || (rules?.dropHighest ?? 0) > 0) return listed("drop_rules");
    if (members.some((x) => x.submission?.excused)) return listed("excused");
    if (!r.points || members.some((x) => !x.points)) return listed("no_points");
    const pts = members.reduce((n, x) => n + x.points!, 0);
    const share = round((weight * r.points) / pts);
    return {
      resourceId: r.id,
      title: r.title,
      basis: "computed",
      sharePercent: share,
      maxMovePercent: share,
      groupId: g.externalId,
      reason: null,
      text: `About ${share}% of the final grade (${g.title} is ${weight}%, split by points across its ${members.length} items).`,
      evidence: [...evidence, fieldEvidence(ctx, r, "points", r.points)],
    };
  }
  function shareOfRow(title: string, weight: number | null, evidence: PageEvidence | null): GradeShare {
    const stated = statedWeight(title) ?? (weight != null && evidence ? { weight, evidence } : null);
    return stated ? syllabusShare({ id: null, title }, stated) : unknown({ id: null, title }, "no_weight", "No weight is stated for it.");
  }

  return {
    complete,
    shareOf,
    shareOfRow,
    bank: {
      status,
      reason,
      weighting,
      groups: rows,
      canvasScore: score ? { currentScore: score.currentScore ?? null, currentGrade: score.currentGrade ?? null, note: "Canvas's own calculation from what's graded so far; not an official grade." } : null,
      note: NOTE,
    },
  };
}

/** The critical factor: impact × urgency × weakness, with the knowledge model's urgency constants. */
export function critical(ctx: ViewContext, grade: GradeShare, dueAt: string | null, topics: PageTopic[]): OfferItem["critical"] {
  const p = params(CONFIG);
  const impact = grade.sharePercent ?? grade.maxMovePercent ?? 1;
  const days = dueAt ? Math.max(0, (Date.parse(dueAt) - Date.parse(ctx.now)) / 86_400_000) : Infinity;
  const urgency = Number.isFinite(days) ? 1 + p.urgencyAmplitude * Math.exp(-days / p.urgencyTauDays) : 1;
  const weakness = topics.length ? topics.reduce((n, t) => n + (WEAKNESS[t.state] ?? 1), 0) / topics.length : 1;
  const open = topics.filter((t) => t.state !== "solid").length;
  const worth = grade.basis === "computed" || grade.basis === "syllabus" ? `${grade.sharePercent}% of the grade` : grade.basis === "listed" ? `up to ${grade.maxMovePercent}% of the grade (its group)` : "an unknown share of the grade";
  const when = Number.isFinite(days) ? (days < 1 ? "due within a day" : `due in ${Math.round(days)} days`) : "no date";
  const text = `${worth}, ${when}; ${topics.length ? `${open} of ${topics.length} linked topics not yet solid` : "no linked topics yet"}.`;
  return { score: Math.round(impact * urgency * weakness * 1000) / 1000, impact, urgency: Math.round(urgency * 1000) / 1000, weakness: Math.round(weakness * 1000) / 1000, text };
}

const command = (value: Record<string, unknown>) => value;
function packCommand(pack: string, scope: Record<string, unknown>): Record<string, unknown> | null {
  return packScopeSchema.safeParse(scope).success ? command({ type: "pack", pack, scope }) : null;
}

/** Offers by stakes; each carries the exact command it would run and its scope. Nothing runs here. */
export function offersFor(
  ctx: ViewContext,
  item: { id: string; resourceId: string | null; kind: string | null; stakes: OfferItem["stakes"] },
  scope: { resourceIds: string[]; topicIds: string[] },
  sheet: ReturnType<typeof sheetRule> | null,
): StudyOffer[] {
  const courseId = ctx.course.courseId;
  const packScope = { courseId, ...(scope.resourceIds.length ? { resourceIds: scope.resourceIds.slice(0, 200) } : {}), ...(scope.topicIds.length ? { topicIds: scope.topicIds.slice(0, 50) } : {}) };
  const linked = scope.resourceIds.length ? `from its ${scope.resourceIds.length} linked materials` : "from the course (no linked materials yet)";
  if (item.stakes === "low")
    return [
      { id: "cards", label: "Quick card set (10)", status: "ready", reason: `Ten flashcards ${linked}.`, command: packCommand("cards", packScope), scope },
      { id: "review_sheet", label: "One-page review sheet", status: "ready", reason: `A short briefing ${linked}.`, command: packCommand("briefing", packScope), scope },
    ];
  if (item.stakes !== "high") return [];
  const page = { type: "query", query: { view: "assessment.page", assessmentId: item.id } };
  const exam = { op: "study.exam", courseId, assessmentId: item.id, length: 20, lean: false, timed: true };
  return [
    { id: "study_plan", label: "Study plan to exam day", status: "ready", reason: "A day-by-day plan to the exam date, worked out by code on the assessment page (0 tokens).", command: page, scope },
    {
      id: "practice_exam",
      label: "Practice exam",
      status: "not_built",
      reason: "The practice exam (exam prep) isn't on this build; the learning channel answers it as not built.",
      command: learningRequestSchema.safeParse(exam).success ? { type: "learning", request: exam } : null,
      scope,
    },
    {
      id: "formula_sheet",
      label: "Formula sheet",
      status: sheet?.status === "allowed" ? "ready" : sheet?.status === "not_allowed" ? "not_allowed" : "not_stated",
      reason: sheet?.text ?? "No posted rule on notes or sheets was found.",
      command: sheet?.status === "allowed" ? page : null,
      scope,
    },
  ];
}

/** Stakes apply to tests (a Canvas quiz, or an exam by name or syllabus row); other graded work is medium. */
export function stakesOf(kind: string | null, grade: GradeShare): OfferItem["stakes"] {
  const weight = grade.sharePercent ?? grade.maxMovePercent;
  if (kind === "final" || kind === "midterm" || kind === "exam") return "high";
  if (kind === "quiz") return weight !== null && weight >= STAKES.highFrom ? "high" : weight === null || weight < STAKES.lowBelow ? "low" : "medium";
  return "medium";
}

/** One graded item's offer row (shared by the study.offers query and the two pages). */
export function offerRow(ctx: ViewContext, bank: Bank, r: Res, topicsOf: (id: string) => PageTopic[]): OfferItem {
  const copies = copiesOf(ctx, r);
  const kind = examKind(r.title, r.submissionTypes ?? []) ?? (r.scope.startsWith("quizzes") ? "quiz" : null);
  // A test is dated by its posted details (an announced move of the exam counts); other work by its deadline.
  const posted = kind ? postedDetails(ctx, subjectFor(ctx, r.id), null) : null;
  const { claims, unresolved } = deadlineClaims(ctx, r, copies);
  const dueAt = posted?.date ?? resolveDeadline(claims, unresolved).dueAt ?? r.dueAt ?? copies.find((c) => c.moduleItem?.dueAt)?.moduleItem?.dueAt ?? null;
  const grade = bank.shareOf(r);
  const topics = topicsOf(r.id);
  const stakes = stakesOf(kind, grade);
  // Only items with offers need their material scope (other graded work carries none).
  const resourceIds =
    stakes === "medium"
      ? []
      : [...new Set(references(ctx.store, r.id).flatMap((x) => (x.resourceId && ctx.index.resources.get(x.resourceId)?.text ? [x.resourceId] : [])))].slice(0, 50);
  const topicIds = topics.map((t) => t.conceptId).slice(0, 50);
  const sheet = stakes === "high" && posted ? sheetRule(posted.details.find((d) => d.field === "allowed_materials")) : null;
  return {
    resourceId: r.id,
    assessmentId: r.id,
    title: r.title,
    kind,
    dueAt,
    stakes,
    grade,
    critical: critical(ctx, grade, dueAt, topics),
    offers: offersFor(ctx, { id: r.id, resourceId: r.id, kind, stakes }, { resourceIds, topicIds }, sheet),
  };
}

export interface OffersRequest {
  courseId: string;
  accountScope?: string;
  days?: number;
}
export function studyOffers(store: ViewStore, request: OffersRequest, now: string): StudyOffers {
  const sources = store.sources();
  const accountScope =
    request.accountScope ?? sources.filter((s) => s.courseId === request.courseId && s.kind === "canvas").map((s) => s.accountScope).sort()[0];
  if (!accountScope) throw new PageViewError("This course isn't in your workspace.");
  const ctx = contextFor(store, { accountScope, courseId: request.courseId }, now, sources);
  if (!ctx.index.resources.size) throw new PageViewError("This course isn't in your workspace.");
  const courseRes = [...ctx.index.resources.values()].find((r) => r.kind === "course");
  if (courseRes && !included(ctx)(courseRes)) throw new PageViewError("This course is excluded. Include it in Sources to see its offers.");
  const missing: PageMissing[] = [];
  const bank = gradeBank(ctx);
  if (bank.bank.reason) missing.push({ field: "gradeBank", text: bank.bank.reason });
  const topicsOf = topicReader(ctx);
  const until = Date.parse(now) + (request.days ?? 21) * 86_400_000;
  const graded = [...ctx.index.assignmentById.values(), ...[...ctx.index.quizById.values()].filter((q) => q.scope.startsWith("quizzes") && ![...ctx.index.assignmentById.values()].some((a) => a.title === q.title))];
  const items: OfferItem[] = [];
  for (const r of graded) {
    if (r.completed || r.submitted === true || r.submission?.submittedAt) continue;
    if ((r.submissionTypes ?? []).every((t) => t === "not_graded") && r.submissionTypes?.length) continue;
    const row = offerRow(ctx, bank, r, topicsOf);
    if (!row.dueAt || Date.parse(row.dueAt) < Date.parse(now) || Date.parse(row.dueAt) > until) continue;
    items.push(row);
  }
  // Syllabus-only assessments (the course map's rows with no Canvas item), dated in the window.
  for (const a of store.assessments(ctx.course)) {
    if (a.resourceId || !a.date) continue;
    const at = Date.parse(a.date);
    if (!(at >= Date.parse(now) && at <= until)) continue;
    const grade = bank.shareOfRow(a.title, a.weight, a.weight != null ? fieldEvidence(ctx, null, "assessments.weight", a.weight, "course_map", `Course map: ${a.title}`) : null);
    const kind = a.kind;
    const stakes = stakesOf(kind, grade);
    const scope = { resourceIds: [] as string[], topicIds: [] as string[] };
    const sheet = stakes === "high" ? sheetRule(postedDetails(ctx, subjectFor(ctx, a.id, a), null).details.find((d) => d.field === "allowed_materials")) : null;
    items.push({ resourceId: null, assessmentId: a.id, title: a.title, kind, dueAt: a.date, stakes, grade, critical: critical(ctx, grade, a.date, []), offers: offersFor(ctx, { id: a.id, resourceId: null, kind, stakes }, scope, sheet) });
  }
  items.sort((x, y) => y.critical.score - x.critical.score || (x.dueAt ?? "").localeCompare(y.dueAt ?? ""));
  if (!items.length) missing.push({ field: "items", text: `No graded item is due in the next ${request.days ?? 21} days.` });
  return { view: "study.offers", generatedAt: now, course: { accountScope, courseId: request.courseId, courseName: ctx.courseName, url: ctx.courseUrl }, gradeBank: bank.bank, items, missing };
}
