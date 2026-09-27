import type { LocalAnswer, ResourceSummary, ResourceView, SourceHealth } from "@magic/contracts";
import { courseKey, isDone, whenDue, type CourseCard, type CoursePage } from "../../../../../packages/domain/src/course-page";

// owner: chat lane. Pure code: scope, routing and projections for a chat.
// No model call decides scope, dates or actions; the only generated text is the local answer.

export type Freshness = CoursePage["freshness"];
export interface ChatCourse {
  key: string;
  accountScope: string;
  courseId: string;
  /** Conservative display label from the shared course projection. */
  label: string;
  /** Short course code for compact rows, when the source has one. */
  code: string | null;
  /** Raw source title, kept for inspection. */
  rawName: string;
  freshness: Freshness;
  lastSuccessAt: string | null;
}
export interface ChatItem {
  id: string;
  contentHash: string;
  title: string;
  kindLabel: string | null;
  courseKey: string | null;
  url: string;
  observedAt: string;
  policyMode: ResourceView["policy"]["mode"];
}
/** The page the chat was opened from. The chat may narrow this, never widen it. */
export type ChatScope =
  | { kind: "workspace"; page: string; courses: ChatCourse[] }
  | { kind: "course"; page: string; course: ChatCourse }
  | { kind: "item"; page: string; course: ChatCourse | null; item: ChatItem };

export function chatCourse(card: Pick<CourseCard, "key" | "courseId" | "courseName" | "rawCourseName" | "code" | "freshness">, lastSuccessAt: string | null = null): ChatCourse {
  const [accountScope] = splitKey(card.key);
  return {
    key: card.key,
    accountScope,
    courseId: card.courseId,
    label: card.code && card.code !== card.courseName ? `${card.code} · ${card.courseName}` : card.courseName,
    code: card.code || null,
    rawName: card.rawCourseName,
    freshness: card.freshness,
    lastSuccessAt,
  };
}
export function chatCourseFromPage(page: CoursePage): ChatCourse {
  return chatCourse({ ...page, courseName: page.courseName }, page.lastSuccessAt);
}
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf(":");
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
}
export function chatItem(r: Pick<ResourceView, "id" | "contentHash" | "title" | "kindLabel" | "courseId" | "url" | "observedAt" | "policy" | "sourceId"> | ResourceSummary, sources: Pick<SourceHealth, "id" | "accountScope">[]): ChatItem {
  const scope = sources.find((s) => s.id === r.sourceId)?.accountScope ?? r.sourceId;
  return {
    id: r.id,
    contentHash: r.contentHash,
    title: r.title,
    kindLabel: r.kindLabel ?? null,
    courseKey: courseKey(scope, r.courseId),
    url: r.url,
    observedAt: r.observedAt,
    policyMode: r.policy.mode,
  };
}

/**
 * Scope for the page the student is on. App passes what the page itself shows:
 * an item view gives its resource, a course page gives its course, anything else
 * gives the included courses. Nothing is added beyond that.
 */
export function chatScopeForPage(input: {
  page: string;
  resource?: ResourceView | null;
  course?: CoursePage | null;
  cards: CourseCard[];
  sources: Pick<SourceHealth, "id" | "accountScope">[];
}): ChatScope {
  const courses = input.cards.map((c) => chatCourse(c));
  if (input.resource) {
    const item = chatItem(input.resource, input.sources);
    const course = input.course && input.course.key === item.courseKey ? chatCourseFromPage(input.course) : courses.find((c) => c.key === item.courseKey) ?? null;
    return { kind: "item", page: input.page, course, item };
  }
  if (input.course) return { kind: "course", page: input.page, course: chatCourseFromPage(input.course) };
  return { kind: "workspace", page: input.page, courses };
}
/** Short scope name for meta lines and placeholders. Raw names stay on the course objects. */
export function scopeLabel(scope: ChatScope): string {
  if (scope.kind === "item") return scope.item.title;
  if (scope.kind === "course") return scope.course.label;
  return scope.courses.length === 1 ? scope.courses[0]!.label : `${scope.courses.length} included courses`;
}
/** Narrowing keeps the originating course; an item outside it is refused. */
export function narrowTo(scope: ChatScope, item: ChatItem): ChatScope | null {
  if (scope.kind === "course" && item.courseKey !== scope.course.key) return null;
  if (scope.kind === "item") return null;
  if (scope.kind === "workspace" && !scope.courses.some((c) => c.key === item.courseKey)) return null;
  const course = scope.kind === "course" ? scope.course : scope.courses.find((c) => c.key === item.courseKey) ?? null;
  return { kind: "item", page: scope.page, course, item };
}
export function scopeCourses(scope: ChatScope): ChatCourse[] {
  return scope.kind === "workspace" ? scope.courses : scope.course ? [scope.course] : [];
}

/** Compact date and time; the year appears only when it is not the current one. */
export function when(value: string | null, withYear = false): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const year = withYear && date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year, hour: "numeric", minute: "2-digit" }).format(date);
}
/** Day and time for a due row, relative to the snapshot time: "Today", "Tomorrow" or "Mon, Sep 28". */
export function dueParts(value: string, now: string): { day: string; time: string } {
  const date = new Date(value), base = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(date) - day(base)) / 86_400_000);
  return {
    day: diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date),
    time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date),
  };
}
/** Coverage line for the scope. Unknown, partial and stale never read as complete. */
export function coverageLine(courses: ChatCourse[]): string {
  if (!courses.length) return "No courses are included yet";
  const worst = courses.some((c) => c.freshness === "unknown") ? "unknown" : courses.some((c) => c.freshness === "stale") ? "stale" : courses.some((c) => c.freshness === "partial") ? "partial" : "current_capture";
  const latest = courses.map((c) => c.lastSuccessAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
  if (worst === "current_capture") return latest ? `Checked ${when(latest, true)}` : "Checked";
  if (worst === "partial") return latest ? `Partly checked ${when(latest, true)}` : "Partly checked";
  if (worst === "stale") return latest ? `May be out of date · last checked ${when(latest, true)}` : "Not checked yet";
  return "Freshness unknown";
}

export type Intent =
  | { kind: "due"; days: number }
  | { kind: "open" }
  | { kind: "ask"; question: string };
/** Code-first routing. Language code cannot resolve stays a question. */
export function routeIntent(text: string): Intent {
  const t = text.trim();
  if (/^open\b|\bopen (it|this|in canvas|the source)\b/i.test(t) && t.length <= 60) return { kind: "open" };
  if (/\b(what'?s|what is|anything|show|list)\b.*\b(due|deadlines?)\b|^(due|deadlines?)\b|\bdue (today|tomorrow|this week|next week|soon)\b/i.test(t) && t.length <= 120) {
    const days = /\btoday\b/i.test(t) ? 1 : /\btomorrow\b/i.test(t) ? 2 : /\b(two weeks|next week|14 days)\b/i.test(t) ? 14 : 7;
    return { kind: "due", days };
  }
  return { kind: "ask", question: t };
}

export interface DueRow {
  id: string;
  title: string;
  courseKey: string;
  /** Source and course id, the key Home uses for the course identity color. */
  toneKey: string;
  courseLabel: string;
  courseCode: string | null;
  kindLabel: string | null;
  dueAt: string;
  submitted: boolean;
}
/**
 * Due work in scope from the same saved deadline projection the course page uses.
 * Account and course both match, so same-numbered courses in two accounts stay apart.
 */
export function dueInScope(scope: ChatScope, resources: ResourceView[], sources: Pick<SourceHealth, "id" | "accountScope">[], now: string, days: number): DueRow[] {
  const courses = new Map(scopeCourses(scope).map((c) => [c.key, c]));
  const accounts = new Map(sources.map((s) => [s.id, s.accountScope]));
  const start = Date.parse(now), end = start + days * 86_400_000;
  const rows: DueRow[] = [];
  for (const r of resources) {
    if (r.deleted || r.kind !== "assignment" || r.completed) continue;
    const key = courseKey(accounts.get(r.sourceId) ?? r.sourceId, r.courseId);
    const course = courses.get(key);
    const inScope = scope.kind === "item" ? (scope.course ? key === scope.course.key : r.id === scope.item.id) : !!course;
    if (!inScope) continue;
    const due = whenDue(r), at = due ? Date.parse(due) : NaN;
    if (!Number.isFinite(at) || at < start || at > end) continue;
    rows.push({ id: r.id, title: r.title, courseKey: key, toneKey: `${r.sourceId}:${r.courseId}`, courseLabel: course?.label ?? "", courseCode: course?.code ?? null, kindLabel: r.kindLabel ?? null, dueAt: due!, submitted: isDone(r) });
  }
  return rows.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title));
}
/** Honest caveat for a due list: never "nothing due" when coverage is incomplete. */
export function dueCaveat(courses: ChatCourse[]): string | null {
  const incomplete = courses.filter((c) => c.freshness !== "current_capture");
  if (!incomplete.length) return null;
  return incomplete.length === 1
    ? `${incomplete[0]!.label} is ${incomplete[0]!.freshness === "partial" ? "only partly checked" : incomplete[0]!.freshness === "stale" ? "possibly out of date" : "not confirmed"}, so more work may be due.`
    : `${incomplete.length} courses are not fully checked, so more work may be due.`;
}

export function safeWebLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

/** An answer is tied to the item version it read. */
export function answerIsStale(answer: Pick<LocalAnswer, "resourceId" | "inputHash">, current: Pick<ChatItem, "id" | "contentHash"> | null): boolean {
  return !!current && current.id === answer.resourceId && current.contentHash !== answer.inputHash;
}
export function localErrorNeedsSetup(message: string): boolean {
  return /ollama|llmfit|installed model|local (ai|model|runtime|inference|status)|disabled in/i.test(message) && !/restricts|excluded/i.test(message);
}
