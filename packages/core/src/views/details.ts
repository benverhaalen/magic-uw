/**
 * An assessment's posted details (owner: page-views): date and time, location, duration, format,
 * allowed materials and weight, each with every source that states it. Code reads them from the
 * Canvas fields, the course map, the course profile (syllabus brief), and the lines of the
 * syllabus, announcements and pages that name the assessment. Two sources that disagree are both
 * kept and the detail is a conflict; an announced change supersedes an earlier value, and both show.
 */
import type {
  Assessment,
  DeadlineEvidenceClaim,
  PageDetail,
  PageEvidence,
  Resource,
} from "@magic/contracts";
import { resolveDeadline, zonedTimeToUtc } from "@magic/domain";
import { examKind } from "../../../learning/src/analytics/references";
import { canonicalAssessment } from "../graph/references";
import type { Res } from "../graph/course-index";
import {
  PageViewError,
  claimEvidence,
  copiesOf,
  deadlineClaims,
  fieldEvidence,
  isDateOnly,
  namer,
  proseFor,
  showDate,
  textEvidence,
  type ViewContext,
} from "./common";

export interface Subject {
  id: string;
  title: string;
  kind: string;
  resource: Res | null;
  row: Assessment | null;
  copies: Res[];
}

/** An assessment by stored row ID, or by the resource ID of a Canvas exam, quiz or assignment. */
export function subjectFor(ctx: ViewContext, assessmentId: string, row?: Assessment | null): Subject {
  const stored = row ?? ctx.store.assessments(ctx.course).find((a) => a.id === assessmentId) ?? null;
  const res = stored?.resourceId ? ctx.index.resources.get(stored.resourceId) : ctx.index.resources.get(assessmentId);
  const resource = res ? canonicalAssessment(ctx.index, res) : null;
  if (!stored && !resource) throw new PageViewError("That assessment isn't in this course.");
  const title = stored?.title ?? resource!.title;
  const types = resource?.submissionTypes ?? [];
  const kind = stored?.kind ?? examKind(title, types) ?? (resource?.scope.startsWith("quizzes") ? "quiz" : resource ? "assignment" : "other");
  return { id: stored?.id ?? resource!.id, title, kind, resource, row: stored, copies: resource ? copiesOf(ctx, resource) : [] };
}

export interface Window {
  r: Resource;
  /** Offsets of the line in `r.text`. */
  start: number;
  end: number;
  line: string;
  statedAt: string | null;
  announcement: boolean;
}
/** The lines that speak about the assessment: its own text, and lines elsewhere that name it. */
export function windowsFor(ctx: ViewContext, s: Subject): Window[] {
  const out: Window[] = [];
  const names = namer(ctx, s.title, s.resource?.externalId ?? null);
  const own = new Set(s.copies.map((c) => c.id));
  const push = (r: Resource, all: boolean, statedAt: string | null, announcement: boolean) => {
    let at = 0;
    for (const raw of r.text.split("\n")) {
      const line = raw.trim();
      if (line && (all || names.text(line))) {
        const lead = raw.length - raw.trimStart().length;
        out.push({ r, start: at + lead, end: at + lead + line.length, line, statedAt, announcement });
      }
      at += raw.length + 1;
    }
  };
  for (const c of s.copies) if (c.text) push(c, true, null, false);
  for (const r of ctx.index.resources.values()) {
    if (own.has(r.id) || !r.text) continue;
    const scope = r.scope.split(":")[0];
    const announcement = scope === "announcements" || scope === "discussions";
    const syllabus = r === ctx.index.syllabus || r.externalId === "syllabus";
    const page = scope === "page" || scope === "pages" || scope === "linked-page" || scope === "document" || scope === "files";
    if (!announcement && !syllabus && !page) continue;
    const titled = !syllabus && names.text(r.title);
    push(r, titled, announcement ? r.createdAt ?? null : null, announcement);
  }
  return out;
}

const CHANGE = /\b(moved|changed|rescheduled|postponed|now (?:be|in|at|on)|instead|new (?:room|location|time|date)|update[ds]?)\b/i;
/** Wording that says an event's date was changed (the deadline extractor's change words, for events). */
const EVENT_CHANGE = /\b(?:moved?|postpon(?:ed|ing)|pushed(?:\s+back)?|reschedul(?:ed|ing)|delayed|changed?|instead\s+of)\b/i;
interface Claim {
  key: string;
  display: string;
  evidence: PageEvidence;
  statedAt: string | null;
  change: boolean;
}
function lineEvidence(ctx: ViewContext, w: Window): PageEvidence {
  return textEvidence(ctx, w.r, w.start, Math.min(w.end, w.start + 300), w.statedAt)!;
}

const LOCATION = [
  /\b(?:location|room|where|place)\s*[:\-–]\s*([A-Za-z0-9][^\n;]{1,79}?)(?=[.;,]\s|[.;]?$)/i,
  /\b(?:in|at)\s+((?:room|rm\.?)\s+\d{1,4}[A-Z]?(?:\s+[A-Z][A-Za-z]+){0,3}|\d{2,4}[A-Z]?\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s+(?:Hall|Building|Auditorium|Center|Centre|Library|Theater|Theatre|Gym|Fieldhouse)(?:\s+(?:room\s+)?\d{1,4}[A-Z]?)?)/,
];
const DURATION = /\b(\d{1,3}(?:\.\d)?)[\s-]*(minutes?|mins?|hours?|hrs?)\b/i;
const TIME_RANGE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const PERCENT = /(\d{1,2}(?:\.\d+)?)\s*%/;
const FORMAT_WORDS: [RegExp, string][] = [
  [/\bmultiple[- ]choice\b/i, "multiple choice"],
  [/\bshort[- ]answer\b/i, "short answer"],
  [/\bfree[- ]response\b/i, "free response"],
  [/\btrue\s*\/\s*false\b/i, "true/false"],
  [/\btake[- ]home\b/i, "take-home"],
  [/\bin[- ](?:person|class)\b/i, "in person"],
  [/\bonline\b/i, "online"],
  [/\bon paper\b/i, "on paper"],
  [/\bcumulative\b/i, "cumulative"],
  [/\boral\b/i, "oral"],
];
const OPPOSING_FORMAT: [string, string][] = [["take-home", "in person"], ["online", "in person"], ["online", "on paper"]];
const ALLOWED: [RegExp, string][] = [
  [/\b(?:one|1|two|2|a single)\s+(?:double[- ]sided\s+|single[- ]sided\s+|handwritten\s+|8\.5\s*x\s*11\s+)*(?:page|sheet|index card)s?\s+of\s+(?:handwritten\s+)?notes\b/i, "a notes sheet"],
  [/\b(?:cheat|crib)\s*sheets?\b/i, "a cheat sheet"],
  [/\bformula sheets?\s+(?:is|are|will be)\s+provided\b/i, "a provided formula sheet"],
  [/\bopen[- ]notes?\b/i, "open notes"],
  [/\bopen[- ]book\b/i, "open book"],
  [/\bclosed[- ]book\b/i, "closed book"],
  [/\bno\s+(?:notes|cheat sheets?|notes or books)\b|\bnotes?\s+(?:are|is)\s+not\s+(?:allowed|permitted)\b/i, "no notes"],
  [/\bcalculators?\s+(?:are\s+|is\s+)?(?:allowed|permitted)\b|\bmay use a calculator\b/i, "calculator allowed"],
  [/\bno\s+calculators?\b|\bcalculators?\s+(?:are|is)\s+not\s+(?:allowed|permitted)\b/i, "no calculator"],
];
const OPPOSING_ALLOWED: [string, string][] = [["a notes sheet", "no notes"], ["a cheat sheet", "no notes"], ["open notes", "no notes"], ["open book", "closed book"], ["calculator allowed", "no calculator"]];
export const SHEET_ALLOWED = new Set(["a notes sheet", "a cheat sheet", "open notes", "open book"]);

function settle(field: PageDetail["field"], claims: Claim[], none: string, show: (key: string) => string): PageDetail {
  const unique = new Map<string, Claim[]>();
  for (const c of claims) unique.set(c.key, [...(unique.get(c.key) ?? []), c]);
  const rows = (superseded: (c: Claim) => boolean) =>
    claims
      .filter((c, i) => claims.findIndex((x) => x.key === c.key && x.evidence.quote === c.evidence.quote) === i)
      .slice(0, 8)
      .map((c) => ({ value: c.display, evidence: c.evidence, superseded: superseded(c) }));
  if (!claims.length) return { field, status: "missing", value: null, claims: [], text: none };
  if (unique.size === 1) {
    const key = [...unique.keys()][0]!;
    return { field, status: "found", value: show(key), claims: rows(() => false), text: show(key) };
  }
  // A later announced change supersedes: the latest change line wins only if it is the only one that late.
  const changes = claims.filter((c) => c.change && c.statedAt).sort((a, b) => b.statedAt!.localeCompare(a.statedAt!));
  const latest = changes[0];
  if (latest && !changes.some((c) => c !== latest && c.statedAt === latest.statedAt && c.key !== latest.key)) {
    return {
      field,
      status: "changed",
      value: show(latest.key),
      claims: rows((c) => c.key !== latest.key),
      text: `${show(latest.key)} (changed by "${latest.evidence.source}"; the earlier value is shown too)`,
    };
  }
  return { field, status: "conflict", value: null, claims: rows(() => false), text: `Sources disagree: ${[...unique.keys()].map(show).join(" vs ")}. Both are shown with their sources.` };
}

/** Tokens detail (format, allowed materials): the union, unless two sources say opposite things. */
function settleTokens(field: PageDetail["field"], claims: Claim[], opposing: [string, string][], none: string): PageDetail {
  if (!claims.length) return { field, status: "missing", value: null, claims: [], text: none };
  const tokens = [...new Set(claims.map((c) => c.key))];
  const clash = opposing.filter(([a, b]) => tokens.includes(a) && tokens.includes(b));
  const rows = claims
    .filter((c, i) => claims.findIndex((x) => x.key === c.key && x.evidence.quote === c.evidence.quote) === i)
    .slice(0, 8)
    .map((c) => ({ value: c.display, evidence: c.evidence, superseded: false }));
  if (clash.length)
    return { field, status: "conflict", value: null, claims: rows, text: `Sources disagree: ${clash.map(([a, b]) => `${a} vs ${b}`).join("; ")}. Both are shown with their sources.` };
  return { field, status: "found", value: tokens.join(", "), claims: rows, text: tokens.join(", ") };
}

const collapse = (s: string) => s.toLowerCase().replace(/^(?:room|rm\.?)\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
function minutesOf(m: RegExpExecArray): number {
  const n = Number(m[1]);
  return /^h/i.test(m[2]!) ? Math.round(n * 60) : Math.round(n);
}
function rangeMinutes(m: RegExpExecArray): number | null {
  const toMin = (h: string, mm: string | undefined, ap: string | undefined) => ((Number(h) % 12) + (ap?.toLowerCase() === "pm" ? 12 : 0)) * 60 + Number(mm ?? 0);
  const end = toMin(m[4]!, m[5], m[6]);
  const start = toMin(m[1]!, m[2], m[3] ?? m[6]);
  const d = end - start;
  return d > 0 && d <= 360 ? d : null;
}

export interface PostedDetails {
  details: PageDetail[];
  windows: Window[];
  /** The resolved date (ISO), when not in conflict. */
  date: string | null;
}
/** Every posted detail. `share` is the grade bank's share for this item (computed or syllabus). */
export function postedDetails(ctx: ViewContext, s: Subject, share: { percent: number; evidence: PageEvidence[] } | null): PostedDetails {
  const windows = windowsFor(ctx, s);
  const brief = ctx.store.courseBrief(ctx.course);
  const briefSyllabus = brief ? ctx.index.resources.get(brief.syllabusResourceId) : undefined;
  const briefRows = (brief?.brief.assessments ?? []).filter((a) => namer(ctx, s.title, null).text(a.title));
  const briefEvidence = (q: { quote: string; start: number; end: number }) =>
    briefSyllabus && briefSyllabus.text.slice(q.start, q.end) === q.quote
      ? { ...textEvidence(ctx, briefSyllabus, q.start, q.end)!, origin: "course_profile" as const }
      : fieldEvidence(ctx, briefSyllabus ?? null, "brief.assessments", q.quote, "course_profile", "Course profile");

  // ---------- Date: the app's deadline evidence (Canvas, calendar, announcements, syllabus, pages) ----------
  const target: Resource =
    s.resource ??
    ({
      id: `assessment:${s.id}`,
      externalId: `assessment:${s.id}`,
      sourceId: s.row!.sourceId,
      kind: "assignment",
      courseId: ctx.course.courseId,
      courseName: ctx.courseName,
      title: s.title,
      url: ctx.courseUrl ?? "https://canvas.wisc.edu/",
      text: "",
      deadlines: [],
      points: null,
      submitted: null,
      policy: { mode: "unknown", evidence: "" },
      contentHash: s.id,
      version: 1,
      observedAt: ctx.now,
      capturedAt: ctx.now,
      deleted: false,
      completed: false,
    } satisfies Resource);
  const { claims: raw, unresolved } = s.resource ? deadlineClaims(ctx, s.resource, s.copies) : { ...proseFor(ctx)(target) };
  const dayValue = (d: string) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    return zonedTimeToUtc(y, m, day, 0, 0);
  };
  const extra: { claim: DeadlineEvidenceClaim; evidence: PageEvidence }[] = [];
  if (s.row?.date) {
    const value = isDateOnly(s.row.date) ? dayValue(s.row.date) : new Date(s.row.date).toISOString();
    extra.push({
      claim: { value, kind: "due", quote: `${s.row.title}: ${s.row.date}`, authority: "structured", scopeConfirmed: true, origin: s.row.origin === "syllabus" ? "syllabus" : "canvas", ...(isDateOnly(s.row.date) ? { precision: "day" as const } : {}) },
      evidence: fieldEvidence(ctx, null, "assessments.date", s.row.date, "course_map", `Course map: ${s.row.title}`),
    });
  }
  for (const b of briefRows)
    if (b.date)
      extra.push({
        claim: { value: isDateOnly(b.date) ? dayValue(b.date) : new Date(b.date).toISOString(), kind: "due", quote: b.quote, authority: "document", scopeConfirmed: true, origin: "syllabus", ...(isDateOnly(b.date) ? { precision: "day" as const } : {}) },
        evidence: briefEvidence(b),
      });
  // An exam's date is an event as often as a due date: both count, a lock (close) time doesn't.
  // An announced move of an exam is an event claim; the extractor marks changes on due claims only.
  const moved = (c: DeadlineEvidenceClaim) => c.kind === "event" && c.origin === "announcement" && EVENT_CHANGE.test(c.quote);
  const dated = [
    ...raw
      .filter((c) => c.kind !== "lock")
      .map((c) => ({ claim: { ...c, kind: "due" as const, ...(moved(c) ? { authority: "explicit_change" as const } : {}) }, evidence: claimEvidence(ctx, c) })),
    ...extra,
  ];
  const resolution = resolveDeadline(
    dated.map((d) => d.claim),
    unresolved,
  );
  const sameDay = (a: string, b: string) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
  const agree = (c: DeadlineEvidenceClaim, at: string) => Date.parse(c.value) === Date.parse(at) || ((c.precision === "day") && sameDay(c.value, at));
  const dateRows = dated
    .filter((d, i) => dated.findIndex((x) => x.claim.value === d.claim.value && x.evidence.quote === d.evidence.quote) === i)
    .slice(0, 8);
  let dateDetail: PageDetail;
  if (!dateRows.length)
    dateDetail = { field: "date", status: "missing", value: null, claims: [], text: unresolved.length ? "A date is mentioned but can't be pinned down from the source." : "No posted date found." };
  else if (resolution.conflict || !resolution.dueAt)
    dateDetail = {
      field: "date",
      status: "conflict",
      value: null,
      claims: dateRows.map((d) => ({ value: d.claim.value, evidence: d.evidence, superseded: false })),
      text: `Sources disagree on the date: ${[...new Set(dateRows.map((d) => showDate(d.claim.value)))].join(" vs ")}. Both are shown with their sources.`,
    };
  else {
    const at = resolution.dueAt;
    const superseded = dateRows.filter((d) => !agree(d.claim, at));
    dateDetail = {
      field: "date",
      status: superseded.length ? "changed" : "found",
      value: at,
      claims: dateRows.map((d) => ({ value: d.claim.value, evidence: d.evidence, superseded: !agree(d.claim, at) })),
      text: superseded.length ? `${showDate(at)} (an announced change replaces ${[...new Set(superseded.map((d) => showDate(d.claim.value)))].join(", ")})` : showDate(at),
    };
  }

  // ---------- Text details from the lines that name it ----------
  const location: Claim[] = [];
  const duration: Claim[] = [];
  const format: Claim[] = [];
  const allowed: Claim[] = [];
  const weight: Claim[] = [];
  for (const w of windows) {
    const ev = () => lineEvidence(ctx, w);
    const change = w.announcement && CHANGE.test(w.line);
    for (const re of LOCATION) {
      const m = re.exec(w.line);
      if (m?.[1] && !/\b(canvas|class|lecture|the exam|person)\b/i.test(m[1])) {
        const value = m[1].trim().replace(/[.,;:]+$/, "");
        location.push({ key: collapse(value), display: value, evidence: ev(), statedAt: w.statedAt, change });
        break;
      }
    }
    const d = DURATION.exec(w.line);
    const range = TIME_RANGE.exec(w.line);
    const minutes = d && !/\blate\b/i.test(w.line) ? minutesOf(d) : range ? rangeMinutes(range) : null;
    if (minutes) duration.push({ key: String(minutes), display: `${minutes} minutes`, evidence: ev(), statedAt: w.statedAt, change });
    for (const [re, token] of FORMAT_WORDS) if (re.test(w.line)) format.push({ key: token, display: token, evidence: ev(), statedAt: w.statedAt, change: false });
    for (const [re, token] of ALLOWED) if (re.test(w.line)) allowed.push({ key: token, display: token, evidence: ev(), statedAt: w.statedAt, change: false });
    const p = PERCENT.exec(w.line);
    if (p && !/\blate|penalt|deduct|curve|drop/i.test(w.line)) weight.push({ key: String(Number(p[1])), display: `${Number(p[1])}%`, evidence: ev(), statedAt: w.statedAt, change });
  }
  for (const c of s.copies)
    if (c.calendar?.location) location.push({ key: collapse(c.calendar.location), display: c.calendar.location, evidence: fieldEvidence(ctx, c, "calendar.location", c.calendar.location), statedAt: null, change: false });
  for (const r of ctx.index.resources.values())
    if (r.calendar?.location && !s.copies.includes(r) && namer(ctx, s.title, null).text(r.title))
      location.push({ key: collapse(r.calendar.location), display: r.calendar.location, evidence: fieldEvidence(ctx, r, "calendar.location", r.calendar.location), statedAt: null, change: false });
  const types = s.resource?.submissionTypes ?? [];
  if (types.includes("online_quiz") || s.resource?.scope.startsWith("quizzes")) format.push({ key: "online", display: "online (Canvas quiz)", evidence: fieldEvidence(ctx, s.resource, types.length ? "submissionTypes" : "scope", types.length ? types : "quizzes"), statedAt: null, change: false });
  if (types.includes("on_paper")) format.push({ key: "on paper", display: "on paper", evidence: fieldEvidence(ctx, s.resource, "submissionTypes", types), statedAt: null, change: false });
  if (s.row?.format) format.push({ key: s.row.format.toLowerCase(), display: s.row.format, evidence: fieldEvidence(ctx, null, "assessments.format", s.row.format, "course_map", `Course map: ${s.row.title}`), statedAt: null, change: false });
  if (s.row?.weight != null) weight.push({ key: String(s.row.weight), display: `${s.row.weight}%`, evidence: fieldEvidence(ctx, null, "assessments.weight", s.row.weight, "course_map", `Course map: ${s.row.title}`), statedAt: null, change: false });
  for (const b of briefRows) if (b.weight != null) weight.push({ key: String(b.weight), display: `${b.weight}%`, evidence: briefEvidence(b), statedAt: null, change: false });
  if (share) weight.push({ key: String(share.percent), display: `${share.percent}%`, evidence: share.evidence[0] ?? fieldEvidence(ctx, s.resource, "assignmentGroup.weight", share.percent), statedAt: null, change: false });

  const details: PageDetail[] = [
    dateDetail,
    settle("location", location, "No posted location found.", (k) => location.find((c) => c.key === k)!.display),
    settle("duration", duration, "No posted duration found.", (k) => `${k} minutes`),
    settleTokens("format", format, OPPOSING_FORMAT, "No posted format found."),
    settleTokens("allowed_materials", allowed, OPPOSING_ALLOWED, "No posted rule on allowed materials found."),
    settle("weight", weight, "No posted weight found.", (k) => `${k}%`),
  ];
  return { details, windows, date: dateDetail.status === "found" || dateDetail.status === "changed" ? dateDetail.value : null };
}

/** Whether a notes or formula sheet is allowed, from the posted allowed-materials detail. */
export function sheetRule(detail: PageDetail | undefined): { status: "allowed" | "not_allowed" | "not_stated"; text: string } {
  if (!detail || detail.status === "missing") return { status: "not_stated", text: "No posted rule on notes or sheets was found, so no sheet is built." };
  if (detail.status === "conflict") return { status: "not_stated", text: "Sources disagree on notes or sheets, so no sheet is built." };
  const tokens = (detail.value ?? "").split(", ");
  if (tokens.some((t) => SHEET_ALLOWED.has(t))) return { status: "allowed", text: `Allowed: ${detail.value}.` };
  if (tokens.includes("no notes") || tokens.includes("closed book")) return { status: "not_allowed", text: `A notes or formula sheet isn't allowed (${detail.value}).` };
  return { status: "not_stated", text: "The posted rules don't say whether a notes sheet is allowed, so no sheet is built." };
}
