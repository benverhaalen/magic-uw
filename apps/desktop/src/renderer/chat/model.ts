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
  /** Course name without the code, for matching the student's wording. */
  name: string;
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
/**
 * The page the chat was opened from. It is the default evidence, not a limit: the student can name or
 * pick another included course. Nothing outside the permitted course list is ever read.
 */
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
    name: card.courseName,
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
export function scopeCourses(scope: ChatScope): ChatCourse[] {
  return scope.kind === "workspace" ? scope.courses : scope.course ? [scope.course] : [];
}
/**
 * Courses a chat may read: what the origin page showed plus the included courses, keyed by account
 * and course so a same-numbered course in an account that is not included never matches.
 */
export function permittedCourses(origin: ChatScope, included: ChatCourse[]): ChatCourse[] {
  const all = new Map<string, ChatCourse>();
  for (const c of [...scopeCourses(origin), ...included]) if (!all.has(c.key)) all.set(c.key, c);
  return [...all.values()];
}
/** An item may be used when its course is permitted, or when it is the item the chat was opened on. */
export function permits(permitted: ChatCourse[], item: ChatItem, origin?: ChatScope): boolean {
  if (origin?.kind === "item" && origin.item.id === item.id) return true;
  return !!item.courseKey && permitted.some((c) => c.key === item.courseKey);
}

export type CourseMention =
  | { kind: "none" }
  | { kind: "one"; course: ChatCourse; text: string }
  /** Two or more permitted courses fit, for example the same code in two accounts. */
  | { kind: "ambiguous"; text: string; courses: ChatCourse[] }
  /** Looks like a course code, but no permitted course has it. */
  | { kind: "unknown"; text: string };

const NOT_SUBJECTS = new Set("a an and at about by ch chapter due ex exercise fig figure for from hw homework in item lab lec lecture module no number of on or p page pages part pp problem q question room rule sec section slide slides step table the to unit v version week".split(" "));
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function codeParts(course: ChatCourse): { subject: string; number: string } | null {
  const match = /([a-z][a-z &]*?)\s*(\d{3})/i.exec(course.code ?? course.rawName);
  return match ? { subject: match[1]!.toLowerCase().replace(/[^a-z]/g, ""), number: match[2]! } : null;
}
function subjectFits(said: string, subject: string): boolean {
  if (said === subject) return true;
  if (said === "cs" || said === "cse") return /^(comp|cs|cmsc)/.test(subject);
  return said.length >= 3 && subject.startsWith(said);
}
/**
 * Code-first course resolution from the student's words: "BIOLOGY 120", "bio 120", "comp sci 220",
 * "CS 220" or a distinctive course name. Only permitted courses can match. No model guesses the course.
 */
export function resolveCourseMention(prompt: string, permitted: ChatCourse[]): CourseMention {
  const text = words(prompt);
  const subjects = permitted.map(codeParts).filter((p) => !!p).map((p) => p!.subject);
  const caps = new Set([...prompt.matchAll(/\b([A-Z]{2,})[\s-]?(\d{3})\b/g)].map((m) => `${m[1]!.toLowerCase()} ${m[2]}`));
  const hits = new Map<string, ChatCourse>();
  let said = "", unknown = "";
  for (const m of text.matchAll(/(?:\b([a-z]+) )?\b([a-z]+) ?(\d{3})\b/g)) {
    const [, before, last, number] = m as unknown as [string, string | undefined, string, string];
    const fits = (said: string) => permitted.filter((c) => { const p = codeParts(c); return !!p && p.number === number && subjectFits(said, p.subject); });
    const joined = before ? fits(before + last) : [];
    const found = joined.length ? joined : fits(last);
    if (found.length) {
      for (const c of found) hits.set(c.key, c);
      said ||= joined.length ? `${before} ${last} ${number}` : `${last} ${number}`;
    } else if (!unknown && !NOT_SUBJECTS.has(last) && (subjects.some((s) => subjectFits(last, s)) || caps.has(`${last} ${number}`))) {
      // Unknown only when it plainly reads as a course code: an included subject with another number,
      // or an all-caps code like "ECON 101". Lowercase words before a number ("top 100") are left alone.
      unknown = `${last} ${number}`;
    }
  }
  for (const c of permitted) {
    const name = words(c.name);
    if ((name.length >= 7 || name.includes(" ")) && new RegExp(`\\b${name}\\b`).test(text)) { hits.set(c.key, c); said ||= name; }
  }
  const courses = [...hits.values()];
  if (courses.length === 1) return { kind: "one", course: courses[0]!, text: said };
  if (courses.length > 1) return { kind: "ambiguous", text: said, courses };
  return unknown ? { kind: "unknown", text: unknown.toUpperCase() } : { kind: "none" };
}
/** The prompt without the course words, so saved-text search looks for the item itself. */
export function withoutMention(prompt: string, mention: CourseMention): string {
  if (mention.kind !== "one" || !mention.text) return prompt;
  const pattern = mention.text.split(" ").map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).join("[^a-z0-9]*");
  const rest = prompt.replace(new RegExp(`\\b(?:for |in |about |from )?${pattern}\\b`, "i"), " ").replace(/\s+/g, " ").trim();
  return rest || prompt;
}

const FILLER = new Set(("about after again also answer assignment before could does exam explain file first focus from have help homework important into item just last lecture main mean means more need next page point points quiz reading should show start summarize summary tell than that their them then there these they this understand what when where which with work would your").split(" "));
/** Title words the student used. Used only to tell whether a follow-up names a different saved item. */
export function titleTerms(prompt: string): string[] {
  return [...new Set(words(prompt).split(" ").filter((t) => t.length > 3 && !FILLER.has(t)))];
}
function titleScore(title: string, terms: string[]): number {
  const t = words(title);
  return terms.filter((term) => new RegExp(`\\b${term}`).test(t)).length;
}
/**
 * A remembered item is the default for a follow-up, not a lock. When another saved item in scope
 * matches the student's words better, the follow-up is about that one and the student chooses.
 */
export function namesAnotherItem(prompt: string, current: Pick<ChatItem, "id" | "title">, candidates: Pick<ChatItem, "id" | "title">[]): boolean {
  const terms = titleTerms(prompt);
  if (!terms.length) return false;
  const own = titleScore(current.title, terms);
  return candidates.some((c) => c.id !== current.id && titleScore(c.title, terms) > own);
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

/** Calendar-day windows in the device's time zone. "week" is today and the six days after it. */
export type DueSpan = "today" | "tomorrow" | "week" | "fortnight";
/** Visible cue only when coverage could change the answer; a current check is routine detail. */
export function coverageBlocker(courses: ChatCourse[]): string | null {
  if (courses.some((c) => c.freshness === "unknown")) return "Freshness unknown";
  if (courses.some((c) => c.freshness === "stale")) return "May be out of date";
  if (courses.some((c) => c.freshness === "partial")) return "Partly checked";
  return null;
}

export type Intent =
  | { kind: "due"; span: DueSpan }
  | { kind: "open" }
  | { kind: "ask"; question: string };
/** Code-first routing. Language code cannot resolve stays a question. */
export function routeIntent(text: string): Intent {
  // Typed prompts often carry smart quotes ("What’s"); they read the same as straight ones.
  const t = text.trim().replace(/[\u2018\u2019\u02bc]/g, "'");
  // Only a bare "open it" style request opens directly; "Open the rubric for the essay" is a search.
  if (/^(please )?open( it| this| that| in canvas| the source| the (page|reading|assignment|item|link))?[.!]?$/i.test(t) || /\bopen (it|this) in canvas\b/i.test(t)) return { kind: "open" };
  const asksList = /\b(what'?s|what is|what are|anything|show|list)\b.*\b(due|deadlines?)\b|^(due|deadlines?)\b|\bdue (today|tomorrow|this week|next week|soon)\b/i.test(t);
  if (asksList && t.length <= 120 && !/\b(policy|policies|late|extension|rubric|grad(e|ed|ing)|why|how)\b/i.test(t)) {
    const span: DueSpan = /\btoday\b|\btonight\b/i.test(t) ? "today" : /\btomorrow\b/i.test(t) ? "tomorrow" : /\b(two weeks|next week|14 days)\b/i.test(t) ? "fortnight" : "week";
    return { kind: "due", span };
  }
  return { kind: "ask", question: t };
}
/** A range settled by the intent router: local calendar days, both ends included. */
export interface DayRange { from: string; to: string; label?: string }
export type DueWindow = DueSpan | DayRange;
export function dueWindow(span: DueWindow, now: string): { start: number; end: number } {
  if (typeof span !== "string") {
    const [fy, fm, fd] = span.from.split("-").map(Number), [ty, tm, td] = span.to.split("-").map(Number);
    return { start: new Date(fy!, fm! - 1, fd!).getTime(), end: new Date(ty!, tm! - 1, td! + 1).getTime() };
  }
  const base = new Date(now);
  const day = (offset: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset).getTime();
  const [from, to] = span === "today" ? [0, 1] : span === "tomorrow" ? [1, 2] : span === "week" ? [0, 7] : [0, 14];
  return { start: day(from), end: day(to) };
}
export function spanLabel(span: DueWindow): string {
  if (typeof span !== "string") return span.label?.trim() || (span.from === span.to ? span.from : `${span.from} to ${span.to}`);
  return span === "today" ? "today" : span === "tomorrow" ? "tomorrow" : span === "week" ? "the next 7 days" : "the next 14 days";
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
  /** Due before now and not submitted. Kept in the list, never dropped. */
  pastDue: boolean;
}
/**
 * Due work in scope from the same saved deadline projection the course page uses, by calendar day.
 * Unsubmitted work due earlier in the window stays listed as past due.
 * Account and course both match, so same-numbered courses in two accounts stay apart.
 */
export function dueInScope(scope: ChatScope, resources: ResourceView[], sources: Pick<SourceHealth, "id" | "accountScope">[], now: string, span: DueWindow): DueRow[] {
  const courses = new Map(scopeCourses(scope).map((c) => [c.key, c]));
  const accounts = new Map(sources.map((s) => [s.id, s.accountScope]));
  const { start, end } = dueWindow(span, now), current = Date.parse(now);
  const rows: DueRow[] = [];
  for (const r of resources) {
    if (r.deleted || r.kind !== "assignment" || r.completed) continue;
    const key = courseKey(accounts.get(r.sourceId) ?? r.sourceId, r.courseId);
    const course = courses.get(key);
    const inScope = scope.kind === "item" ? (scope.course ? key === scope.course.key : r.id === scope.item.id) : !!course;
    if (!inScope) continue;
    const due = whenDue(r), at = due ? Date.parse(due) : NaN;
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const submitted = isDone(r);
    rows.push({ id: r.id, title: r.title, courseKey: key, toneKey: `${r.sourceId}:${r.courseId}`, courseLabel: course?.label ?? "", courseCode: course?.code ?? null, kindLabel: r.kindLabel ?? null, dueAt: due!, submitted, pastDue: !submitted && at < current });
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
/** The shared on-device runtime is busy with another request (for example the item panel). Not a setup problem. */
export function localErrorIsBusy(message: string): boolean {
  return /already running/i.test(message);
}
export function localErrorNeedsSetup(message: string): boolean {
  return /ollama|llmfit|installed model|local (ai|model|runtime|inference|status)|disabled in/i.test(message) && !/restricts|excluded/i.test(message) && !localErrorIsBusy(message);
}

/**
 * One short, recoverable sentence for the student; the raw text stays available as technical detail.
 * Raw IPC and validation errors never become the body. Recovery owns the app-wide error contract.
 */
export function studentError(raw: string, fallback: string): { text: string; detail: string | null } {
  const text = raw.trim();
  if (!text) return { text: fallback, detail: null };
  const technical = /Error invoking remote method|ZodError|invalid_(type|union|enum)|^\s*[[{]|\n\s+at |ECONN|ETIMEDOUT|EPIPE|worker (exited|crashed)/i.test(text) || text.length > 180;
  return technical ? { text: fallback, detail: text.slice(0, 4000) } : { text, detail: null };
}
