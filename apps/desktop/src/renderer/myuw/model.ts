import type { AuditNode, PlanningSourceHealth, Snapshot, StoredPlanningRecord } from "@magic/contracts";
import { decodeUwTerm } from "../../../../../packages/domain/src/planning";

// owner: My UW lane. Pure projection from saved planning evidence to the page's facts.
// Unknown, stale and partial evidence stay visibly distinct; nothing here implies a requirement,
// enrollment or schedule is settled beyond what a current, complete source reported.

export const DAY = 86_400_000;
// Mirrors core `planningHorizon`/`planningEvidenceKind` from main a337daf, which Compare uses:
// enrollment stays fresh 7 days (add/drop is assumed while its dates aren't saved) and every other
// planning scope for a term. Replace with the core export once the renderer can import it.
export const ENROLLMENT_HORIZON = 7 * DAY, TERM_HORIZON = 120 * DAY;
export const horizonFor = (scopeKind: PlanningSourceHealth["scope"]["kind"]) => scopeKind === "enrollment_term" ? ENROLLMENT_HORIZON : TERM_HORIZON;
// Holds and enrollment windows can change any day; core files them under the term horizon, so the
// page keeps its own shorter limit before calling one confirmed. See backend-findings.md.
export const ATTENTION_HORIZON = ENROLLMENT_HORIZON;
type Row<K extends StoredPlanningRecord["kind"]> = Extract<StoredPlanningRecord, { kind: K }>;
export type Service = "myuw" | "enroll";
export type SourceState = "current" | "partial" | "stale" | "failed" | "blocked" | "unsupported";
export interface SourceSummary {
  id: string; label: string; state: SourceState; observedAt: string; lastSuccessAt: string | null;
  url: string; notes: string[]; privateSource: boolean; service: Service | null;
}
export type PageState = "not_connected" | "multiple_accounts" | "partial" | "current";
export type AttentionItem =
  | { kind: "hold"; key: string; record: Row<"hold">; blocks: boolean | null; stale: boolean }
  | { kind: "appointment"; key: string; record: Row<"appointment">; termLabel: string; opensAt: string | null; closesAt: string | null; open: boolean; stale: boolean };
export type RequirementTone = "open" | "progress" | "planned" | "met" | "unknown";
export interface RequirementView {
  node: AuditNode; tone: RequirementTone; label: string; needs: string | null;
  subjects: { code: string; name: string; count: number }[]; optionCount: number; childCount: number;
}
export interface AuditView {
  record: Row<"audit">; title: string; generatedAt: string | null; coverage: Row<"audit">["coverage"]; stale: boolean;
  /** "old": the run itself is past the term horizon; "unconfirmed": the source didn't reconfirm it. */
  staleReason: "old" | "unconfirmed" | null;
  counts: Record<RequirementTone, number>; remaining: RequirementView[]; met: RequirementView[];
}
export interface EnrolledView { record: Row<"enrollment_package">; label: string; meetings: string[] }
export interface TermOption { code: string; label: string; past: boolean | null }
/** Prose, an in-page object link (section plus optional object id), or a static time chip. */
export type BriefPart = string
  | { text: string; target: "attention" | "degree" | "plan" | "term" | "sources"; ref?: string }
  | { time: string };
export interface MyUwModel {
  state: PageState; now: number;
  sources: SourceSummary[]; privateSources: SourceSummary[]; checkedAt: string | null;
  signIn: Service[];
  summary: Row<"student_summary"> | null;
  attention: AttentionItem[];
  audits: AuditView[];
  thisTerm: { code: string; label: string; courses: EnrolledView[]; complete: boolean } | null;
  terms: TermOption[]; defaultPlanTerm: string;
  history: Row<"course_history">[]; advisors: Row<"advisor">[]; catalog: Row<"catalog_course">[];
  subjects: Row<"subject">[];
  brief: BriefPart[][];
  courseLabel: (key: string) => string;
  courseCode: (key: string) => string;
}

const fresh = (stamp: string | null, now: number, maximum: number) => {
  const age = stamp === null ? Number.NaN : now - Date.parse(stamp);
  return Number.isFinite(age) && age >= 0 && age <= maximum;
};
function accounts(records: StoredPlanningRecord[]) {
  return new Set(records.filter((record) => !record.deleted && record.accountScope !== "public").map((record) => record.accountScope));
}
/** Same account rule as the comparison: more than one student record hides personal planning. */
export function visibleRecords(snapshot: Snapshot) {
  const records = snapshot.planning?.records ?? [];
  const separate = accounts(records).size > 1;
  return records.filter((record) => !record.deleted && (!separate || record.accountScope === "public"));
}
export function recordNeedsVerification(record: StoredPlanningRecord, sources: PlanningSourceHealth[], now: number) {
  const source = sources.find((item) => item.id === record.sourceId);
  if (!source) return true;
  const horizon = horizonFor(source.scope.kind);
  return source.status !== "complete" || source.completeness !== "complete" || !fresh(source.observedAt, now, horizon) ||
    !fresh(record.provenance.observedAt, now, record.kind === "enrollment_package" ? ENROLLMENT_HORIZON : horizon);
}
/** Holds and enrollment windows: the source rule plus the page's shorter confirmation limit. */
export function attentionNeedsVerification(record: StoredPlanningRecord, sources: PlanningSourceHealth[], now: number) {
  return recordNeedsVerification(record, sources, now) || !fresh(record.provenance.observedAt, now, ATTENTION_HORIZON);
}
const termLabel = (code: string | null) => {
  if (!code) return "Term unknown";
  try { return decodeUwTerm(code).label; } catch { return code; }
};

export function sourceLabel(source: Pick<PlanningSourceHealth, "source" | "scope">): string {
  const { kind, key } = source.scope;
  if (source.source === "uw_myuw") return "My UW sign-in";
  if (source.source === "madgrades") return "Madgrades grade history";
  if (source.source === "normalized_import") return `Local import · ${kind.replaceAll("_", " ")}`;
  if (kind === "student_record") return key === "connection:canvas-account" ? "Canvas account match" : key === "connection:student-info" ? "Course Search & Enroll sign-in" : "Student record";
  if (kind === "enrollment_term") return `Enrollment · ${termLabel(/^1\d{2}[246]$/.test(key) ? key : null)}`;
  if (kind === "degree_plan") return key.startsWith("current-enrollment:") ? "Current enrollment history" : "Course history";
  if (kind === "audit_program") return "Degree audit";
  if (kind === "catalog_term") { const term = key.match(/1\d{2}[246]/)?.[0]; return `Course offerings${term ? ` · ${termLabel(term)}` : ""}`; }
  if (kind === "terms") return "UW term list";
  if (kind === "subjects") return "UW subject list";
  if (kind === "grade_course") return "Grade history";
  if (kind === "policy" || kind === "academic_calendar") return "UW policy";
  return source.source === "uw_public" ? "Public catalog" : "Planning source";
}
export function summarizeSource(source: PlanningSourceHealth, now: number): SourceSummary {
  const recent = fresh(source.observedAt, now, horizonFor(source.scope.kind));
  const state: SourceState = source.status === "complete" && source.completeness === "complete"
    ? recent ? "current" : "stale"
    : source.status === "complete" || source.status === "partial" ? recent ? "partial" : "stale"
      : source.status;
  const privateSource = source.accountScope !== "public";
  return {
    id: source.id, label: sourceLabel(source), state, observedAt: source.observedAt, lastSuccessAt: source.lastSuccessAt,
    url: source.sourceUrl, notes: source.diagnostics.map((item) => item.message), privateSource,
    service: !privateSource ? null : source.source === "uw_myuw" ? "myuw" : source.source === "uw_enroll" || source.source === "uw_dars" ? "enroll" : null,
  };
}

const statusTone: Record<AuditNode["status"], RequirementTone> = { incomplete: "open", in_progress: "progress", planned: "planned", completed: "met", unknown: "unknown" };
const toneLabel: Record<RequirementTone, string> = { open: "Open", progress: "In progress", planned: "Planned", met: "Met in audit", unknown: "Not interpreted" };
export const requirementToneLabel = (tone: RequirementTone) => toneLabel[tone];

function requirement(node: AuditNode, nodes: AuditNode[], subjectName: (code: string) => string): RequirementView {
  // A partially read node cannot be called met; the audit's word stands only with complete coverage.
  const tone = node.status === "completed" && node.coverage !== "complete" ? "unknown" : statusTone[node.status];
  const needs = [node.needsCourses !== null ? `${node.needsCourses} ${node.needsCourses === 1 ? "course" : "courses"}` : null,
    node.needsCredits !== null ? `${node.needsCredits} ${node.needsCredits === 1 ? "credit" : "credits"}` : null].filter(Boolean).join(" · ");
  const bySubject = new Map<string, number>();
  const keys = new Set(node.acceptableCourseKeys);
  for (const child of nodes) if (child.parentId === node.nodeId) for (const key of child.acceptableCourseKeys) keys.add(key);
  for (const key of keys) { const code = key.split(":")[1]; bySubject.set(code, (bySubject.get(code) ?? 0) + 1); }
  return {
    node, tone, label: tone === "unknown" && node.status === "completed" ? "Partly read" : toneLabel[tone],
    needs: needs ? `${needs} still needed` : null,
    subjects: [...bySubject].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => ({ code, name: subjectName(code), count })),
    optionCount: keys.size, childCount: nodes.filter((child) => child.parentId === node.nodeId).length,
  };
}

function meetingLabel(meeting: Row<"enrollment_package">["meetings"][number]) {
  const minute = (value: number | null) => {
    if (value === null) return "time unknown";
    const hour = Math.floor(value / 60) % 24;
    return `${hour % 12 || 12}:${String(value % 60).padStart(2, "0")}${hour >= 12 ? "pm" : "am"}`;
  };
  if (meeting.mode === "asynchronous") return meeting.kind === "exam" ? "Exam · asynchronous" : "Asynchronous";
  if (meeting.mode === "unknown") return meeting.kind === "exam" ? "Exam time not confirmed" : "Meeting time not confirmed";
  const days = meeting.days.map((day) => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]).join(" ");
  return `${meeting.kind === "exam" ? `Exam${meeting.startDate ? ` ${meeting.startDate}` : ""} · ` : ""}${days ? `${days} ` : ""}${minute(meeting.startMinute)}–${minute(meeting.endMinute)}${meeting.location ? ` · ${meeting.location}` : ""}`;
}

export function projectMyUw(snapshot: Snapshot, now = Date.now()): MyUwModel {
  const all = snapshot.planning?.records ?? [];
  const multiple = accounts(all).size > 1;
  const records = visibleRecords(snapshot);
  const rawSources = snapshot.planning?.sources ?? [];
  const sources = rawSources.map((source) => summarizeSource(source, now));
  const privateSources = sources.filter((source) => source.privateSource);
  const ofKind = <K extends StoredPlanningRecord["kind"]>(kind: K) => records.filter((row): row is Row<K> => row.kind === kind);
  const needsVerification = (record: StoredPlanningRecord) => recordNeedsVerification(record, rawSources, now);
  const attentionStale = (record: StoredPlanningRecord) => attentionNeedsVerification(record, rawSources, now);

  const subjects = [...new Map(ofKind("subject").sort((a, b) => a.provenance.observedAt.localeCompare(b.provenance.observedAt)).map((row) => [row.code, row])).values()]
    .sort((a, b) => a.shortName.localeCompare(b.shortName));
  const subjectName = (code: string) => subjects.find((row) => row.code === code)?.shortName ?? `Subject ${code}`;
  const catalog = ofKind("catalog_course");
  // Display labels only. The canonical key stays attached for source identity and comparison.
  const courseCode = (key: string) => { const match = key.match(/^uw:(\d+):(.+)$/); return match ? `${subjectName(match[1])} ${match[2]}` : key; };
  const courseLabel = (key: string) => catalog.find((course) => course.courseKey === key)?.title || courseCode(key);

  const state: PageState = multiple ? "multiple_accounts"
    : !privateSources.length ? "not_connected"
      // The Canvas account match only gates cross-source grade comparison, not planning itself.
      : privateSources.some((source) => source.state !== "current" && source.label !== "Canvas account match") ? "partial" : "current";
  const connected = (label: string) => privateSources.some((source) => source.label === label && source.state === "current");
  const signIn: Service[] = state === "multiple_accounts" ? [] : [
    ...(!connected("My UW sign-in") ? ["myuw" as const] : []),
    ...(!connected("Course Search & Enroll sign-in") ? ["enroll" as const] : []),
  ];
  const checkedAt = privateSources.map((source) => source.observedAt).sort().at(-1) ?? null;

  const holds = ofKind("hold").map((record): AttentionItem => ({ kind: "hold", key: record.localId, record, blocks: record.blocksEnrollment, stale: attentionStale(record) }));
  const windows = ofKind("appointment").filter((record) => !record.endsAt || Date.parse(record.endsAt) >= now).map((record): AttentionItem => ({
    kind: "appointment", key: record.localId, record, termLabel: termLabel(record.termCode), opensAt: record.startsAt, closesAt: record.endsAt,
    open: record.startsAt !== null && Date.parse(record.startsAt) <= now, stale: attentionStale(record),
  }));
  const holdRank = (item: AttentionItem) => item.kind === "hold" ? item.blocks === true ? 0 : item.blocks === null ? 1 : 2 : 3;
  const attention = [...holds, ...windows].sort((a, b) => holdRank(a) - holdRank(b) ||
    (a.kind === "appointment" && b.kind === "appointment" ? (a.opensAt ?? "9").localeCompare(b.opensAt ?? "9") : 0));

  const summary = ofKind("student_summary").sort((a, b) => a.provenance.observedAt.localeCompare(b.provenance.observedAt)).at(-1) ?? null;
  // Display only: a program key that spells a saved program name shows that name; the key stays in the title attribute.
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const programName = (key: string) => summary?.programNames.find((name) => slug(name) === slug(key)) ?? key.replace(/[-_:]+/g, " ");
  const audits = ofKind("audit").map((record): AuditView => {
    const roots = record.nodes.filter((node) => node.parentId === null).sort((a, b) => a.index - b.index);
    const views = roots.map((node) => requirement(node, record.nodes, subjectName));
    const counts: Record<RequirementTone, number> = { open: 0, progress: 0, planned: 0, met: 0, unknown: 0 };
    for (const view of views) counts[view.tone] += 1;
    const order: Record<RequirementTone, number> = { open: 0, unknown: 1, progress: 2, planned: 3, met: 4 };
    return {
      record, title: roots.length === 1 && roots[0].title ? roots[0].title : programName(record.programKey),
      generatedAt: record.generatedAt, coverage: record.coverage, stale: needsVerification(record) || !fresh(record.generatedAt, now, TERM_HORIZON),
      staleReason: !fresh(record.generatedAt, now, TERM_HORIZON) ? "old" : needsVerification(record) ? "unconfirmed" : null,
      counts, remaining: views.filter((view) => view.tone !== "met").sort((a, b) => order[a.tone] - order[b.tone] || a.node.index - b.node.index),
      met: views.filter((view) => view.tone === "met"),
    };
  });

  const enrolled = ofKind("enrollment_package").filter((row) => row.enrollmentState === "enrolled" && row.provenance.scope.kind === "enrollment_term");
  const enrollmentSources = rawSources.filter((source) => source.scope.kind === "enrollment_term").sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const currentTermCode = enrollmentSources.at(-1)?.scope.key ?? enrolled.map((row) => row.termCode).sort().at(-1) ?? null;
  const thisTerm = currentTermCode && /^1\d{2}[246]$/.test(currentTermCode) ? {
    code: currentTermCode, label: termLabel(currentTermCode),
    courses: enrolled.filter((row) => row.termCode === currentTermCode).map((record) => ({ record, label: courseCode(record.courseKey), meetings: record.meetings.map(meetingLabel) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    complete: enrollmentSources.filter((source) => source.scope.key === currentTermCode).every((source) => summarizeSource(source, now).state === "current") &&
      enrolled.filter((row) => row.termCode === currentTermCode).every((row) => !needsVerification(row)),
  } : null;

  const terms = [...new Map(ofKind("term").sort((a, b) => a.provenance.observedAt.localeCompare(b.provenance.observedAt)).map((term) => [term.code, term])).values()]
    .sort((a, b) => a.code.localeCompare(b.code)).map((term): TermOption => ({ code: term.code, label: term.label || termLabel(term.code), past: term.past }));
  const upcoming = terms.filter((term) => term.past === false);
  const defaultPlanTerm = (thisTerm ? upcoming.find((term) => term.code > thisTerm.code) : undefined)?.code ?? upcoming[0]?.code ?? "";

  const brief = state === "multiple_accounts" || state === "not_connected" ? []
    : briefing({ summary, thisTerm, audit: audits[0] ?? null, attention, planTerm: defaultPlanTerm ? termLabel(defaultPlanTerm) : null });

  return {
    state, now, sources, privateSources, checkedAt, signIn, summary, attention, audits, thisTerm, terms, defaultPlanTerm,
    history: ofKind("course_history"), advisors: ofKind("advisor"), catalog, subjects, brief, courseLabel, courseCode,
  };
}

export const partText = (part: BriefPart) => typeof part === "string" ? part : "time" in part ? part.time : part.text;
export const requirementDomId = (id: string) => `myuw-req-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
export const attentionDomId = (key: string) => `myuw-attn-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
export const courseDomId = (key: string) => `myuw-course-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
export const dayChip =(iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const timeChip = (iso: string) => `${dayChip(iso)} · ${new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
/** "A, B and 2 more": the first names as object links, the rest counted. */
function named(items: { text: string; target: "degree" | "term" | "attention"; ref?: string }[], max: number, more: (count: number) => string): BriefPart[] {
  const shown: BriefPart[] = items.slice(0, max), rest = items.length - shown.length;
  if (rest > 0) shown.push(more(rest));
  return shown.flatMap((part, index) => index === 0 ? [part] : [index === shown.length - 1 ? " and " : ", ", part]);
}

/**
 * The briefing says what the sources add up to. Each fact appears once: holds and windows are
 * detailed in Needs attention, so the briefing carries only their consequence for enrollment.
 * Requirement status uses the audit's own words per requirement; a part the parser couldn't read
 * is named separately and never counted as open, in progress or met.
 */
function briefing({ summary, thisTerm, audit, attention, planTerm }: {
  summary: Row<"student_summary"> | null; thisTerm: MyUwModel["thisTerm"]; audit: AuditView | null; attention: AttentionItem[]; planTerm: string | null;
}): BriefPart[][] {
  const lines: BriefPart[][] = [];
  const program = summary?.programNames.join(" and ");
  if (summary) lines.push([program ? `You’re in ${program}` : "Your student record is saved", summary.earnedCredits !== null ? `, with ${summary.earnedCredits} earned credits reported` : "", "."]);

  if (thisTerm) {
    const courses = named(thisTerm.courses.map((course) => ({ text: course.label, target: "term" as const, ref: course.record.localId })), 3, (count) => `${count} more ${count === 1 ? "course" : "courses"}`);
    const saved = thisTerm.courses.map((course) => course.record.provenance.observedAt).sort()[0];
    lines.push(!thisTerm.courses.length
      ? [thisTerm.complete ? `No enrolled courses are saved for ${thisTerm.label}.` : `Enrollment for ${thisTerm.label} couldn’t be confirmed.`]
      : thisTerm.complete ? ["You’re enrolled in ", ...courses, ` for ${thisTerm.label}.`]
        : ["Your last saved ", thisTerm.label, " enrollment lists ", ...courses, ...(saved ? [" as of ", { time: dayChip(saved) }] : []), ". Refresh to confirm it before planning around it."]);
  }

  if (audit) {
    const ref = (view: RequirementView) => ({ text: view.node.title || "an untitled requirement", target: "degree" as const, ref: `${audit.record.localId}:${view.node.nodeId}` });
    const group = (tone: RequirementTone) => audit.remaining.filter((view) => view.tone === tone).map(ref);
    const more = (count: number) => `${count} more`;
    const open = group("open"), progress = group("progress"), planned = group("planned"), unknown = group("unknown");
    const clauses = [
      open.length ? [...named(open, 2, more), " still open"] : null,
      progress.length ? [...named(progress, 1, more), " in progress"] : null,
      planned.length ? [...named(planned, 1, more), " planned"] : null,
    ].filter((clause): clause is BriefPart[] => clause !== null);
    const when: BriefPart[] = audit.generatedAt ? ["Your audit from ", { time: dayChip(audit.generatedAt) }] : ["Your saved audit"];
    lines.push(clauses.length
      ? [...when, " shows ", ...clauses.flatMap((clause, index) => index === 0 ? clause : [index === clauses.length - 1 ? " and " : ", ", ...clause]), "."]
      : [...when, " shows no open requirement it could read. That isn’t a graduation check."]);
    if (unknown.length) lines.at(-1)!.push(" ", ...named(unknown, 2, (count) => `${count} more ${count === 1 ? "part" : "parts"}`),
      unknown.length === 1 ? " couldn’t be fully read, so it isn’t counted as met." : " couldn’t be fully read, so they aren’t counted as met.");
    if (audit.staleReason === "old") lines.at(-1)!.push(" Run a fresh audit in UW’s degree audit tool before relying on it.");
    else if (audit.staleReason === "unconfirmed") lines.at(-1)!.push(" The last refresh couldn’t reconfirm this audit, so refresh before relying on it.");
  } else lines.push(["No degree audit is saved yet, so what remains for your degree isn’t shown."]);

  // Enrollment consequence only; the hold's detail, resolution link and source live in Needs attention.
  const hold = attention.find((item): item is Extract<AttentionItem, { kind: "hold" }> => item.kind === "hold" && item.blocks === true)
    ?? attention.find((item): item is Extract<AttentionItem, { kind: "hold" }> => item.kind === "hold" && item.blocks === null);
  const window = attention.find((item): item is Extract<AttentionItem, { kind: "appointment" }> => item.kind === "appointment");
  const holdLink: BriefPart | null = hold ? { text: hold.record.title || "A hold", target: "attention", ref: hold.key } : null;
  const opens: BriefPart[] = window?.opensAt ? [{ time: timeChip(window.opensAt) }] : [];
  const closes: BriefPart[] = window?.closesAt ? [" until ", { time: timeChip(window.closesAt) }] : [];
  const consequence: BriefPart[] | null = hold && holdLink && hold.blocks ? !window ? [holdLink, " blocks enrollment until it’s resolved."]
    : window.open ? [holdLink, ` blocks enrollment while your ${window.termLabel} window is open`, ...closes, "."]
      : window.opensAt ? [holdLink, ` blocks enrollment, so it needs to be cleared before your ${window.termLabel} window opens `, ...opens, "."]
        : [holdLink, ` blocks enrollment, and no opening time is saved for your ${window.termLabel} window.`]
    : hold && holdLink ? ["UW lists ", holdLink, " without saying whether it blocks enrollment."]
      : window && window.termLabel === planTerm ? window.open ? [`Your ${window.termLabel} enrollment window is open`, ...closes, "."]
        : window.opensAt ? [`Your ${window.termLabel} enrollment window opens `, ...opens, ", so you can compare options below before then."] : null
        : null;
  const basis = hold ?? window;
  if (consequence && basis?.stale) consequence.push(" UW reported this on ", { time: dayChip(basis.record.provenance.observedAt) }, "; refresh to confirm it still applies.");
  if (consequence) lines.push(consequence);
  return lines;
}

/** Subjects that could satisfy open requirements and have no saved offerings for the chosen term. */
export function offeringsToLoad(model: MyUwModel, termCode: string, limit = 4) {
  if (!termCode) return [];
  const loaded = new Set(model.catalog.filter((course) => course.termCode === termCode).map((course) => course.courseKey.split(":")[1]));
  const counts = new Map<string, number>();
  for (const audit of model.audits) for (const view of audit.remaining) for (const subject of view.subjects) counts.set(subject.code, (counts.get(subject.code) ?? 0) + subject.count);
  return [...counts].filter(([code]) => !loaded.has(code) && /^\d{1,6}$/.test(code)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
    .map(([code, count]) => ({ code, name: model.subjects.find((row) => row.code === code)?.shortName ?? `Subject ${code}`, count }));
}
export function offeringsLoaded(model: MyUwModel, termCode: string) {
  const bySubject = new Map<string, number>();
  for (const course of model.catalog) if (course.termCode === termCode) { const code = course.courseKey.split(":")[1]; bySubject.set(code, (bySubject.get(code) ?? 0) + 1); }
  return [...bySubject].map(([code, count]) => ({ code, name: model.subjects.find((row) => row.code === code)?.shortName ?? `Subject ${code}`, count }));
}

/** What changed after a refresh request, judged from source health rather than a success message. */
export function refreshOutcome(before: Record<string, string>, after: SourceSummary[]) {
  const touched = after.filter((source) => source.privateSource || source.label.startsWith("UW ")).filter((source) => before[source.id] !== source.observedAt);
  return { checked: touched.length, current: touched.filter((source) => source.state === "current").length, problems: touched.filter((source) => source.state !== "current") };
}
