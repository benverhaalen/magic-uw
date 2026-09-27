import type {
  CourseClaim,
  CourseIntelligenceView,
  ResourceView,
  SourceHealth,
} from "@magic/contracts";

/**
 * The course page's read model. Pure code over saved evidence: no model call, no network.
 * It groups exact Canvas records and surfaces course-intelligence claims with their sources.
 * Missing evidence stays visibly missing; weights are listed values, never a grade formula.
 * The notebook (T43) later fills the materials section from the same course identity.
 */
export type CourseFactKind = "ai_policy" | "grading" | "assessment" | "topic";
export interface CourseFactEvidence {
  resourceId: string;
  title: string;
  url: string;
  quote: string;
}
export interface CourseFactItem {
  text: string;
  method: CourseClaim["method"];
  policyMode?: CourseClaim["policyMode"];
  assignmentTitle?: string;
  evidence: CourseFactEvidence[];
}
export interface CourseFact {
  kind: CourseFactKind;
  state: "found" | "not_found" | "conflict";
  items: CourseFactItem[];
}
export interface CourseWeight {
  groupId: string;
  name: string;
  weight: number | null;
  dropLowest?: number;
  dropHighest?: number;
}
export interface CourseWorkGroup {
  id: string | null;
  name: string;
  weight: number | null;
  upcoming: ResourceView[];
  undated: ResourceView[];
  past: ResourceView[];
}
export interface CourseModule {
  id: string;
  name: string;
  position: number;
  items: ResourceView[];
}
export interface CoursePage {
  key: string;
  accountScope: string;
  courseId: string;
  courseName: string;
  code: string | null;
  term: string | null;
  freshness: "current_capture" | "partial" | "stale" | "unknown";
  lastSuccessAt: string | null;
  sourceProblems: number;
  needsSignIn: boolean;
  syllabus:
    | { state: "canvas"; resource: ResourceView }
    | { state: "file"; resource: ResourceView }
    | { state: "missing" };
  facts: Record<CourseFactKind, CourseFact>;
  weights: CourseWeight[];
  groups: CourseWorkGroup[];
  /** Null when saved module items predate module ids; the page then lists materials flat. */
  modules: CourseModule[] | null;
  materials: ResourceView[];
  counts: { assignments: number; upcoming: number; dueThisWeek: number };
}
export interface CourseCard {
  key: string;
  courseId: string;
  courseName: string;
  code: string | null;
  cue: string;
  next: ResourceView | null;
  freshness: CoursePage["freshness"];
  syllabusMissing: boolean;
}
export interface CoursePageInput {
  resources: ResourceView[];
  sources: SourceHealth[];
  courseIntelligence?: CourseIntelligenceView[];
  now: string;
}

const DAY = 24 * 60 * 60 * 1000;
const syllabusTitle = /\bsyllabus\b/i;
const meaningfulText = (text: string | undefined) =>
  (text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length >= 80;

export function courseKey(accountScope: string, courseId: string): string {
  return `${accountScope}:${courseId}`;
}
export function whenDue(r: ResourceView): string | null {
  return r.deadline?.dueAt ?? r.deadline?.planningAt ?? r.dueAt ?? null;
}
export function isDone(r: ResourceView): boolean {
  return r.completed || r.submitted === true;
}
function scopeOf(r: ResourceView, sources: Map<string, SourceHealth>) {
  return sources.get(r.sourceId)?.accountScope ?? r.sourceId;
}
function courseCode(r: ResourceView | undefined): string | null {
  const code = r?.course?.courseCode?.trim();
  return code && code !== r?.courseName ? code : null;
}
function byDue(a: ResourceView, b: ResourceView) {
  return Date.parse(whenDue(a)!) - Date.parse(whenDue(b)!) || a.title.localeCompare(b.title);
}

/** Every course the student can see, keyed by account and course so same-named courses stay apart. */
export function courseKeys(input: Pick<CoursePageInput, "resources" | "sources">): string[] {
  const sources = new Map(input.sources.map((s) => [s.id, s]));
  return [...new Set(input.resources.map((r) => courseKey(scopeOf(r, sources), r.courseId)))];
}

export function buildCoursePage(input: CoursePageInput, key: string): CoursePage | null {
  const sources = new Map(input.sources.map((s) => [s.id, s]));
  const resources = input.resources.filter(
    (r) => !r.deleted && courseKey(scopeOf(r, sources), r.courseId) === key,
  );
  if (!resources.length) return null;
  const first = resources.find((r) => r.kind === "course") ?? resources[0]!;
  const accountScope = scopeOf(first, sources);
  const courseId = first.courseId;
  const now = Date.parse(input.now);
  const byId = new Map(resources.map((r) => [r.id, r]));

  // Freshness from this course's own sources. An area the instructor closed or never published
  // ("inaccessible", "not_published") was still checked; it is not staleness. (The compiled view's
  // freshness treats it as stale, which would label every real course out of date.)
  const courseSources = input.sources.filter(
    (s) => s.accountScope === accountScope && s.courseId === courseId,
  );
  const profile = input.courseIntelligence?.find(
    (p) => p.accountScope === accountScope && p.courseId === courseId,
  );
  const settled = (s: SourceHealth) => s.status === "inaccessible" || s.status === "not_published";
  const checkedAt = (s: SourceHealth) => (settled(s) ? s.lastAttemptAt : s.lastSuccessAt);
  const lastSuccessAt =
    courseSources
      .map(checkedAt)
      .filter((v): v is string => !!v)
      .sort()
      .at(0) ?? null;
  const failing = courseSources.filter((s) => s.status === "needs_sign_in" || s.status === "error");
  const incomplete = courseSources.filter(
    (s) => !settled(s) && (s.status === "partial" || s.status === "needs_attention" || !s.complete),
  );
  const sourceProblems = failing.length + incomplete.length;
  const freshness: CoursePage["freshness"] = !courseSources.length
    ? "unknown"
    : failing.length ||
        courseSources.some((s) => !checkedAt(s)) ||
        !lastSuccessAt ||
        now - Date.parse(lastSuccessAt) > DAY
      ? "stale"
      : incomplete.length
        ? "partial"
        : "current_capture";

  // Syllabus: the Canvas syllabus body, else a file clearly titled as a syllabus.
  const body = resources.find((r) => r.externalId === "syllabus" && meaningfulText(r.text));
  const file = resources
    .filter((r) => r.kind === "material" && r.externalId !== "syllabus" && syllabusTitle.test(r.title))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  const syllabus: CoursePage["syllabus"] = body
    ? { state: "canvas", resource: body }
    : file
      ? { state: "file", resource: file }
      : { state: "missing" };

  // Facts: course-scoped claims plus assignment-scoped AI policies (which can restrict one assignment).
  const facts = {} as Record<CourseFactKind, CourseFact>;
  for (const kind of ["ai_policy", "grading", "assessment", "topic"] as const) {
    const claims = (profile?.claims ?? []).filter(
      (c) =>
        c.kind === kind &&
        (c.scope === "course" || kind === "ai_policy") &&
        // Per-group structured weights are shown in the weights table from exact records instead.
        !(kind === "grading" && c.method === "structured"),
    );
    const seen = new Set<string>();
    const items: CourseFactItem[] = [];
    for (const c of claims) {
      const text = String(c.value ?? "").trim();
      const dedupe = `${c.assignmentId ?? ""}|${text.toLowerCase()}`;
      if (!text || seen.has(dedupe)) continue;
      seen.add(dedupe);
      items.push({
        text,
        method: c.method,
        policyMode: c.policyMode,
        assignmentTitle: c.assignmentId ? byId.get(c.assignmentId)?.title : undefined,
        evidence: c.evidence.map((e) => ({
          resourceId: e.resourceId,
          title: byId.get(e.resourceId)?.title ?? "Captured source",
          url: e.url,
          quote: e.quote,
        })),
      });
    }
    // Course-wide statements first; assignment exceptions after.
    items.sort((a, b) => Number(!!a.assignmentTitle) - Number(!!b.assignmentTitle));
    const conflict = profile?.conflicts.some((x) => x.kind === kind) ?? false;
    facts[kind] = { kind, state: conflict ? "conflict" : items.length ? "found" : "not_found", items };
  }

  // Assignment groups carry Canvas's listed weight and drop rules.
  const groupResources = resources
    .filter((r) => r.assignmentGroup)
    .sort((a, b) => (a.assignmentGroup!.position ?? 0) - (b.assignmentGroup!.position ?? 0));
  const weights: CourseWeight[] = groupResources.map((g) => ({
    groupId: g.externalId,
    name: g.title,
    weight: g.assignmentGroup!.weight ?? null,
    dropLowest: g.assignmentGroup!.rules?.dropLowest || undefined,
    dropHighest: g.assignmentGroup!.rules?.dropHighest || undefined,
  }));

  const assignments = resources.filter((r) => r.kind === "assignment");
  const groupFor = new Map<string | null, CourseWorkGroup>();
  for (const w of weights)
    groupFor.set(w.groupId, { id: w.groupId, name: w.name, weight: w.weight, upcoming: [], undated: [], past: [] });
  for (const a of assignments) {
    const id = a.assignmentGroupId && groupFor.has(a.assignmentGroupId) ? a.assignmentGroupId : null;
    if (!groupFor.has(id))
      groupFor.set(id, { id, name: "Other coursework", weight: null, upcoming: [], undated: [], past: [] });
    const group = groupFor.get(id)!;
    const due = whenDue(a);
    if (!due) (isDone(a) ? group.past : group.undated).push(a);
    else if (Date.parse(due) >= now && !isDone(a)) group.upcoming.push(a);
    else group.past.push(a);
  }
  const groups = [...groupFor.values()].filter(
    (g) => g.upcoming.length || g.undated.length || g.past.length,
  );
  for (const g of groups) {
    g.upcoming.sort(byDue);
    g.past.sort((a, b) => -byDue(a, b) || 0);
    g.undated.sort((a, b) => a.title.localeCompare(b.title));
  }
  // Groups with upcoming work first, then by the order Canvas lists them.
  const order = new Map(weights.map((w, i) => [w.groupId, i]));
  groups.sort(
    (a, b) =>
      Number(!b.upcoming.length) - Number(!a.upcoming.length) ||
      (order.get(a.id ?? "") ?? 1e6) - (order.get(b.id ?? "") ?? 1e6),
  );

  // Modules, in Canvas order, with their items. Assignment/group/module records are not "materials".
  const moduleResources = resources
    .filter((r) => r.module && !r.moduleItem)
    .sort((a, b) => (a.module!.position ?? 0) - (b.module!.position ?? 0));
  const items = resources.filter((r) => r.moduleItem);
  const hasModuleIds = items.some((r) => r.moduleItem!.moduleId);
  const modules: CourseModule[] | null =
    moduleResources.length && hasModuleIds
      ? moduleResources
          .map((m, index) => ({
            id: m.externalId,
            name: m.title,
            position: m.module!.position ?? index,
            items: items
              .filter((r) => r.moduleItem!.moduleId === m.externalId)
              .sort((a, b) => (a.moduleItem!.position ?? 0) - (b.moduleItem!.position ?? 0)),
          }))
          .filter((m) => m.items.length)
      : null;
  const materials = resources
    .filter(
      (r) =>
        r.kind === "material" &&
        !r.assignmentGroup &&
        !(r.module && !r.moduleItem) &&
        (modules ? !r.moduleItem : true) &&
        r.externalId !== "syllabus",
    )
    .sort((a, b) => a.title.localeCompare(b.title));

  const upcoming = assignments.filter((a) => {
    const due = whenDue(a);
    return due && Date.parse(due) >= now && !isDone(a);
  });
  return {
    key,
    accountScope,
    courseId,
    courseName: first.courseName,
    code: courseCode(first),
    term: first.course?.termName ?? null,
    freshness,
    lastSuccessAt,
    sourceProblems,
    needsSignIn: courseSources.some((s) => s.status === "needs_sign_in"),
    syllabus,
    facts,
    weights,
    groups,
    modules,
    materials,
    counts: {
      assignments: assignments.length,
      upcoming: upcoming.length,
      dueThisWeek: upcoming.filter((a) => Date.parse(whenDue(a)!) - now <= 7 * DAY).length,
    },
  };
}

/** One card per course with a single current cue, per the Courses contract. No grade or progress ring. */
export function buildCourseCards(input: CoursePageInput): CourseCard[] {
  return courseKeys(input)
    .map((key) => buildCoursePage(input, key))
    .filter((p): p is CoursePage => !!p)
    .map((page) => {
      const next =
        page.groups
          .flatMap((g) => g.upcoming)
          .sort(byDue)
          .at(0) ?? null;
      const cue = next
        ? `Next: ${next.title}`
        : page.counts.assignments
          ? "No upcoming dated work"
          : "No assignments captured";
      return {
        key: page.key,
        courseId: page.courseId,
        courseName: page.courseName,
        code: page.code,
        cue,
        next,
        freshness: page.freshness,
        syllabusMissing: page.syllabus.state === "missing",
      };
    })
    .sort((a, b) => a.courseName.localeCompare(b.courseName));
}
