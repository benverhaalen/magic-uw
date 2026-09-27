import { createHash } from "node:crypto";
import type {
  CourseClaim,
  CourseEvidence,
  CourseExtractionBatch,
  CourseIntelligence,
  CourseIntelligenceView,
  CourseSyllabusSource,
  EffectiveCoursePolicy,
  Resource,
  SourceHealth,
} from "@magic/contracts";

// v2: syllabus selection (D34 tiers) and the wider literal headings; bumping it recompiles saved profiles.
export const COURSE_COMPILER_VERSION = "course-intelligence.v2";
/** Extractor versions starting with this are the student's own client (method `client_model`). */
export const CLIENT_EXTRACTOR_PREFIX = "course-facts.client";
export const courseExtractionHash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const hash = courseExtractionHash;
export const courseIntelligenceId = (account: string, course: string) =>
  hash([account, course]);
export function courseInputHash(resources: Resource[]) {
  return hash([
    COURSE_COMPILER_VERSION,
    resources
      .map((r) => [r.sourceId, r.id, r.contentHash, r.version])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  ]);
}
function textEvidence(r: Resource, start: number, end: number): CourseEvidence {
  return {
    resourceId: r.id,
    sourceId: r.sourceId,
    contentHash: r.contentHash,
    version: r.version,
    url: r.url,
    field: "text",
    quote: r.text.slice(start, end),
    start,
    end,
  };
}
function fieldEvidence(
  r: Resource,
  field: string,
  value: unknown,
): CourseEvidence {
  return {
    resourceId: r.id,
    sourceId: r.sourceId,
    contentHash: r.contentHash,
    version: r.version,
    url: r.url,
    field,
    quote: JSON.stringify(value),
  };
}
function scope(r: Resource): Pick<CourseClaim, "scope" | "assignmentId"> {
  return r.kind === "assignment"
    ? { scope: "assignment", assignmentId: r.id }
    : { scope: "course" };
}
/** Only narrow declarative prohibitions are actionable automatically; all permission prose stays unresolved. */
export function literalPolicyMode(text: string): CourseClaim["policyMode"] {
  const normalized = text.trim().replace(/[.!]$/, "").toLowerCase();
  if (
    /^(?:the use of )?(?:generative ai|artificial intelligence|ai tools|chatgpt) (?:is|are) (?:strictly )?(?:prohibited|not permitted|not allowed)(?: (?:in this course|on this assignment|for this assignment))?$/.test(
      normalized,
    )
  )
    return "restricted";
  return "unknown";
}
// ---- Literal headings and lines (code path, 0 tokens) ----
/** Optional markdown hashes or numbering before a heading: "## Grading", "3. Exams", "IV) Grading". */
const HEADING_PREFIX = String.raw`(?:#{1,6}\s*|(?:\d{1,2}(?:\.\d{1,2})*|[IVX]{1,5}|[A-H])[.)]\s+)?`;
const heading = (body: string) =>
  new RegExp(`^${HEADING_PREFIX}(?:${body})\\s*:?$`, "i");
const TOPIC_HEADING = heading(
  "topics|course topics|learning objectives|learning outcomes|course content|course objectives",
);
const ASSESSMENT_HEADING = heading(
  "assessments?|exams?|examinations?|exam format|exam scope|allowed materials|midterms?(?: and finals?)?(?: exams?)?|final exams?|quizzes and exams|exams and quizzes",
);
const GRADING_HEADING = heading(
  "grading(?: breakdown| policy| policies| scale| criteria)?|grade breakdown|grades|course grades?|evaluation",
);
const AI_HEADING = heading(
  "(?:(?:the )?use of )?(?:ai|generative ai|gen ?ai|artificial intelligence|llms?)(?: tools?)?(?: use| usage| policy)?(?: policy)?",
);
const INTEGRITY_HEADING = heading(
  "academic (?:integrity|honesty|misconduct)",
);
/** Any other heading ends the current section: "Office Hours:", "OFFICE HOURS", "## Office hours". */
const OTHER_HEADING =
  /^(?:[A-Z][A-Za-z ]{2,50}:|[A-Z][A-Z &/,'-]{2,50}|#{1,6}\s+\S.{0,60})$/;
const AI_TERMS =
  /\b(?:generative ai|gen ?ai|artificial intelligence|chatgpt|ai tools?|llms?|large language models?|copilot)\b/i;
/** A line that talks about AI. Bare "AI" counts only in capitals, so "ai" inside words never does. */
export function isAiLine(line: string) {
  return AI_TERMS.test(line) || /\bAI\b/.test(line);
}
type Section = CourseClaim["kind"] | "integrity";
/**
 * A heading-shaped line: short, few words, no digits (so "Essays 40%" stays body text), no sentence
 * punctuation at the end. Real syllabi title sections "Course Grading Overview" or "Grading Scale for
 * Individual Assignments", so these are matched by keyword, after the exact forms above.
 */
const headingShaped = (t: string) =>
  t.length <= 60 && !/\d/.test(t) && !/[.?!,;]$/.test(t) && t.split(/\s+/).length <= 8;
/** Title Case lines of 2–6 words ("Classroom Expectations") end a section; single words don't. */
const TITLE_CASE =
  /^(?:[A-Z][\w'’&/-]*|and|or|of|for|the|a|an|to|in|on|with|&)(?:\s+(?:[A-Z][\w'’&/-]*|and|or|of|for|the|a|an|to|in|on|with|&)){1,5}:?$/;
/** The section a heading line opens, `null` for another heading, or undefined for body text. */
export function headingSection(trimmed: string): Section | null | undefined {
  const t = trimmed.replace(/^[^\p{L}\p{N}#]+/u, ""); // leading bullets or symbols ("☞ Key Details")
  if (TOPIC_HEADING.test(t)) return "topic";
  if (ASSESSMENT_HEADING.test(t)) return "assessment";
  if (GRADING_HEADING.test(t)) return "grading";
  if (AI_HEADING.test(t)) return "ai_policy";
  if (INTEGRITY_HEADING.test(t)) return "integrity";
  if (headingShaped(t)) {
    if (isAiLine(t)) return "ai_policy";
    if (/\bacademic (?:integrity|honesty|misconduct)\b/i.test(t)) return "integrity";
    if (/\bgrad(?:ing|es?)\b|\bgrade breakdown\b/i.test(t)) return "grading";
    if (/\bexam(?:s|inations?)?\b|\bmidterms?\b|\bfinal exams?\b|\bquizzes\b|\bassessments?\b/i.test(t)) return "assessment";
    if (/\blearning (?:outcomes|objectives)\b|\bcourse (?:topics|content|objectives)\b|\btopics covered\b/i.test(t)) return "topic";
  }
  if (OTHER_HEADING.test(t) || (headingShaped(t) && TITLE_CASE.test(t))) return null;
  return undefined;
}
/** Headings that make a page a policy page (grading, exams, AI, academic integrity). */
function policySignals(text: string) {
  let headings = 0,
    ai = false;
  for (const match of text.matchAll(/[^\n]+/g)) {
    const trimmed = match[0].trim();
    if (!trimmed || trimmed.length > 4000) continue;
    const section = trimmed.length <= 80 ? headingSection(trimmed) : undefined;
    if (section && section !== "topic") headings++;
    if (isAiLine(trimmed)) ai = true;
  }
  return { headings, ai };
}

// ---- Syllabus selection (D34), by code ----
type SourceRole = Pick<SourceHealth, "id" | "kind" | "scope">;
type Season = "spring" | "summer" | "fall" | "winter";
interface Term {
  year: number;
  season?: Season;
}
/** Letters-only boundaries, so file names count: "PHIL101_Syllabus_F26.pdf". */
const SYLLABUS_WORD = /(?<![A-Za-z])(?:syllabus|syllabi|course[\s_-](?:outline|overview))(?![A-Za-z])/i;
const FRONT_PAGE_TITLE =
  /^(?:home|home ?page|front page|welcome\b.*|course home|start here|course info(?:rmation)?)$/i;
const FRONT_PAGE_SLUG =
  /\/pages\/(?:front-page|home|homepage|welcome[^/?#]*|start-here|course-home|course-info(?:rmation)?)(?:[/?#]|$)/i;
/** Canvas chrome that can surround an otherwise empty syllabus tab. */
const BOILERPLATE_LINE =
  /^(?:course summary:?|date|details|due|jump to today|edit|syllabus|course syllabus|show more|show less)$/i;
const NOT_A_DOCUMENT =
  /^(?:folders|modules|details|announcements|discussions|assignments|assignment-groups|quizzes|submissions|account-|activity|calendar|courses|connection)/;
/** A syllabus tab counts as the syllabus only with at least this much text after boilerplate. */
export const SYLLABUS_MIN_CHARACTERS = 400;
const seasonOf: Record<string, Season> = {
  fall: "fall", fa: "fall", f: "fall",
  spring: "spring", sp: "spring", s: "spring",
  summer: "summer", su: "summer",
  winter: "winter", wi: "winter",
};
const SEASON_TERM =
  /(?<![A-Za-z0-9])(fall|spring|summer|winter|fa|sp|su|wi)[\s_'’-]?(\d{4}|\d{2})(?![0-9])/gi;
const LETTER_TERM = /(?<![A-Za-z0-9])([fs])(\d{2})(?![A-Za-z0-9])/gi;
/** UW's Canvas term names carry the academic year: "Spring 2025-2026" is spring 2026. */
const ACADEMIC_TERM =
  /(?<![A-Za-z0-9])(fall|spring|summer|winter)\s+(20\d{2})\s*[-–/]\s*(?:20)?(\d{2})(?![0-9])/gi;
const YEAR = /(?<![0-9])(20\d{2})(?:\s*[-–/]\s*(?:20)?(\d{2}))?(?![0-9])/g;
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
/** Terms a title, file name or URL names: "Fall 2026", "fa26", "_F26", "S26", "2025-26". */
export function termsNamed(label: string): Term[] {
  const out: Term[] = [];
  let rest = label;
  for (const m of rest.matchAll(ACADEMIC_TERM)) {
    const season = seasonOf[m[1]!.toLowerCase()]!;
    out.push({ season, year: season === "fall" ? Number(m[2]) : 2000 + Number(m[3]!.slice(-2)) });
  }
  rest = rest.replace(ACADEMIC_TERM, " ");
  for (const re of [SEASON_TERM, LETTER_TERM]) {
    for (const m of rest.matchAll(re))
      out.push({ season: seasonOf[m[1]!.toLowerCase()], year: fullYear(m[2]!) });
    rest = rest.replace(re, " ");
  }
  for (const m of rest.matchAll(YEAR)) {
    out.push({ year: Number(m[1]) });
    if (m[2]) out.push({ year: 2000 + Number(m[2].slice(-2)) });
  }
  return out;
}
const seasonOfMonth = (month: number): Season =>
  month <= 4 ? "spring" : month <= 6 ? "summer" : "fall";
/** The course's own term: Canvas term name, then the course name, then its start date. */
function courseTerm(resources: Resource[]): Term | undefined {
  for (const r of resources) {
    const named = r.course?.termName ? termsNamed(r.course.termName) : [];
    const t = named.find((n) => n.season) ?? named[0];
    if (t) return t;
  }
  for (const r of resources) {
    const t = termsNamed(r.courseName).find((n) => n.season);
    if (t) return t;
  }
  for (const r of resources) {
    const start = r.course?.startAt ? new Date(r.course.startAt) : undefined;
    if (start && !Number.isNaN(start.getTime()))
      return { year: start.getUTCFullYear(), season: seasonOfMonth(start.getUTCMonth()) };
  }
  return undefined;
}
/** A candidate naming only other terms is last year's (or another term's) copy. */
function otherTerm(label: string, term: Term | undefined, at: string): string | undefined {
  const named = termsNamed(label);
  if (!named.length) return undefined;
  const now = new Date(at);
  const matches = (t: Term) =>
    term
      ? t.year === term.year && (!t.season || !term.season || t.season === term.season)
      : // No term on record: only the year is checked, and early in a year last year's fall still counts.
        t.year === now.getUTCFullYear() ||
        (now.getUTCMonth() <= 5 && t.year === now.getUTCFullYear() - 1);
  if (named.some(matches)) return undefined;
  const t = named[0]!;
  return `names another term (${t.season ? `${t.season} ` : ""}${t.year})`;
}
const COURSE_CODE =
  /(?<![A-Za-z])([A-Z]{2,}(?:[ &/][A-Z]{2,})*|[A-Z][a-z]{1,3})[ _.-]?(\d{3})(?![0-9])/g;
function courseNumbers(resources: Resource[]) {
  const numbers = new Set<string>();
  for (const r of resources)
    for (const text of [r.courseName, r.course?.courseCode ?? ""])
      for (const m of text.matchAll(/(?<![0-9])(\d{3})(?![0-9])/g)) numbers.add(m[1]!);
  return numbers;
}
/** A candidate naming a course code whose number isn't this course's is another course's syllabus. */
function otherCourse(label: string, numbers: Set<string>): string | undefined {
  if (!numbers.size) return undefined;
  const codes = [...label.matchAll(COURSE_CODE)];
  if (!codes.length || codes.some((m) => numbers.has(m[2]!))) return undefined;
  return `names another course (${codes[0]![1]} ${codes[0]![2]})`;
}
const meaningfulLength = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !BOILERPLATE_LINE.test(l))
    .join("\n").length;
function normaliseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
const hostOf = (value: string) => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
const linkUrls = (r: Resource) =>
  (r.links ?? []).map((l) => (typeof l === "string" ? { url: l, text: "" } : { url: l.url, text: l.text ?? "" }));
const fileIdsOf = (r: Resource) =>
  [r.file?.id, r.file?.fileId, r.document?.fileId, /\/files\/(\d+)/.exec(r.url)?.[1]].filter(
    (v): v is string => !!v,
  );
const firstLine = (text: string) => text.trimStart().split("\n", 1)[0]!.slice(0, 120);
const newestVersion = (title: string) => Number(/\bv(?:er(?:sion)?)?\.?\s?(\d{1,2})\b/i.exec(title)?.[1] ?? 0);

export interface SyllabusRejection {
  resourceId: string;
  reason: string;
}
export interface SyllabusSelectionResult {
  selected: CourseSyllabusSource[];
  /** Candidates the wrong-document guard refused. */
  rejected: SyllabusRejection[];
}
/**
 * Code picks the course's syllabus (D34), in tier order:
 * 1. the Canvas syllabus tab with at least 400 characters of text after boilerplate;
 * 2. a Canvas page, file or module item titled or linked as the syllabus (a material role of
 *    `syllabus` counts), preferring the current term and the newest version;
 * 3. a course-website page linked from the course's own Canvas module or syllabus, with
 *    "syllabus" in its URL or title;
 * 4. the front page, when it carries policy headings.
 * Returns at most two: a primary and a supplement (an AI note can live on the front page).
 * Titles, file names and URLs naming another term or another course code are refused.
 */
export function selectSyllabus(
  resources: Resource[],
  sources: SourceRole[],
  options: { at: string; roles?: ReadonlySet<string> },
): SyllabusSelectionResult {
  const sourceOf = new Map(sources.map((s) => [s.id, s]));
  const live = resources.filter((r) => !r.deleted && sourceOf.has(r.sourceId));
  const canvas = (r: Resource) => {
    const kind = sourceOf.get(r.sourceId)?.kind;
    return (kind === "canvas" || kind === "fixture") && !r.gitlab;
  };
  const scopeOf = (r: Resource) => sourceOf.get(r.sourceId)?.scope ?? "";
  const term = courseTerm(live);
  const numbers = courseNumbers(live);
  const labelOf = (r: Resource) =>
    [r.title, r.moduleItem?.title, r.file?.displayName, r.url].filter(Boolean).join(" | ");
  // Where Canvas points: module items titled as the syllabus, and links from the syllabus tab or pages.
  const syllabusTargets = new Set<string>();
  const syllabusLinks = new Set<string>();
  const linkedUrls = new Set<string>();
  const linkedHosts = new Set<string>();
  const canvasHosts = new Set<string>();
  for (const r of live.filter(canvas)) {
    const host = hostOf(r.url);
    if (host) canvasHosts.add(host);
    const item = r.moduleItem;
    const titled = SYLLABUS_WORD.test(`${r.title} ${item?.title ?? ""}`);
    if (item?.contentId && titled) syllabusTargets.add(item.contentId);
    if (item?.pageUrl && titled) syllabusTargets.add(`page:${item.pageUrl}`);
    const outward = [
      ...(item?.externalUrl ? [{ url: item.externalUrl, text: item.title ?? r.title }] : []),
      ...linkUrls(r),
    ];
    for (const link of outward) {
      const url = normaliseUrl(link.url);
      if (!url) continue;
      linkedUrls.add(url);
      if (SYLLABUS_WORD.test(link.text) || (item?.externalUrl === link.url && titled)) syllabusLinks.add(url);
      const linkHost = hostOf(link.url);
      if (linkHost) linkedHosts.add(linkHost);
    }
  }
  for (const host of canvasHosts) linkedHosts.delete(host);
  const pageSlug = (r: Resource) => /\/pages\/([^/?#]+)/.exec(r.url)?.[1];

  interface Candidate {
    r: Resource;
    tier: CourseSyllabusSource["tier"];
    reason: string;
    rank: number;
  }
  const candidates: Candidate[] = [];
  const rejected: SyllabusRejection[] = [];
  const guard = (r: Resource) => otherTerm(labelOf(r), term, options.at) ?? otherCourse(labelOf(r), numbers);
  for (const r of live) {
    const scope = scopeOf(r);
    const text = r.text.trim();
    if (canvas(r) && r.externalId === "syllabus" && scope === "syllabus") {
      const length = meaningfulLength(r.text);
      if (length >= SYLLABUS_MIN_CHARACTERS)
        candidates.push({ r, tier: 1, reason: `Canvas syllabus tab (${length} characters of text)`, rank: 0 });
      continue;
    }
    if (r.kind !== "material" && r.kind !== "course") continue;
    if (canvas(r)) {
      if (NOT_A_DOCUMENT.test(scope)) continue;
      const itemType = r.moduleItem?.type;
      if (itemType === "ExternalUrl" && r.moduleItem?.externalUrl && SYLLABUS_WORD.test(`${r.title} ${r.moduleItem.title ?? ""}`)) {
        // The module links the syllabus off Canvas: found, but its text is the linked page's (tier 3).
        const why = guard(r);
        if (why) rejected.push({ resourceId: r.id, reason: why });
        else
          candidates.push({
            r,
            tier: 3,
            reason: `Canvas module item linking the syllabus at ${hostOf(r.moduleItem.externalUrl) ?? "another site"} (the linked page isn't captured)`,
            rank: 2,
          });
        continue;
      }
      if (itemType && ["ExternalUrl", "ExternalTool", "SubHeader", "Assignment", "Quiz", "Discussion"].includes(itemType))
        continue;
      const titled = SYLLABUS_WORD.test(`${r.title} ${r.moduleItem?.title ?? ""} ${r.file?.displayName ?? ""}`);
      const headed = !titled && SYLLABUS_WORD.test(firstLine(r.text));
      const role = options.roles?.has(r.id) ?? false;
      const slug = pageSlug(r);
      const linked =
        fileIdsOf(r).some((id) => syllabusTargets.has(id)) ||
        (!!slug && syllabusTargets.has(`page:${slug}`)) ||
        syllabusLinks.has(normaliseUrl(r.url) ?? "");
      if (titled || headed || role || linked) {
        const why = guard(r);
        if (why) {
          rejected.push({ resourceId: r.id, reason: why });
          continue;
        }
        const what = r.moduleItem ? "module item" : slug ? "page" : fileIdsOf(r).length || r.document ? "file" : "item";
        const reason = titled
          ? `Canvas ${what} titled as the syllabus ("${(r.moduleItem?.title ?? r.title).slice(0, 120)}")`
          : linked
            ? `Canvas ${what} linked as the syllabus`
            : headed
              ? `Canvas ${what} whose first line names the syllabus`
              : `Canvas ${what} with the material role "syllabus"`;
        candidates.push({ r, tier: 2, reason, rank: titled || linked ? 0 : 1 });
        continue;
      }
      const front = FRONT_PAGE_TITLE.test(r.title.trim()) || FRONT_PAGE_SLUG.test(r.url);
      if (front && text) {
        const signals = policySignals(r.text);
        if (signals.headings || signals.ai) {
          const why = guard(r);
          if (why) rejected.push({ resourceId: r.id, reason: why });
          else
            candidates.push({
              r,
              tier: 4,
              reason: `Canvas home or course-information page with policy headings (${signals.headings} heading${signals.headings === 1 ? "" : "s"}${signals.ai ? ", mentions AI" : ""})`,
              rank: 0,
            });
        }
      }
      continue;
    }
    if (sourceOf.get(r.sourceId)?.kind !== "web") continue;
    if (!/syllabus/i.test(r.url) && !SYLLABUS_WORD.test(r.title)) continue;
    const url = normaliseUrl(r.url) ?? "";
    const host = hostOf(r.url);
    const exact = linkedUrls.has(url);
    if (!exact && !(host && linkedHosts.has(host))) continue;
    const why = guard(r);
    if (why) {
      rejected.push({ resourceId: r.id, reason: why });
      continue;
    }
    candidates.push({
      r,
      tier: 3,
      reason: exact
        ? `course-site page linked from Canvas (${host})`
        : `syllabus page on a course site Canvas links to (${host})`,
      rank: exact ? 0 : 1,
    });
  }
  // A module item and the file it points to are one document: keep the copy with text.
  const byDocument = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = c.r.moduleItem?.contentId ?? fileIdsOf(c.r)[0] ?? c.r.id;
    const held = byDocument.get(key);
    if (!held || (!held.r.text.trim() && c.r.text.trim()) || (c.tier < held.tier && !!c.r.text.trim() === !!held.r.text.trim()))
      byDocument.set(key, c);
  }
  const namesTerm = (r: Resource) => (term ? termsNamed(labelOf(r)).some((t) => t.year === term.year) : false);
  const ranked = [...byDocument.values()].sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(!!b.r.text.trim()) - Number(!!a.r.text.trim()) ||
      a.rank - b.rank ||
      Number(namesTerm(b.r)) - Number(namesTerm(a.r)) ||
      newestVersion(labelOf(b.r)) - newestVersion(labelOf(a.r)) ||
      (b.r.updatedAt ?? b.r.observedAt).localeCompare(a.r.updatedAt ?? a.r.observedAt) ||
      b.r.text.length - a.r.text.length ||
      a.r.id.localeCompare(b.r.id),
  );
  const selected: CourseSyllabusSource[] = [];
  const primary = ranked[0];
  if (primary) {
    const source = (c: Candidate, role: CourseSyllabusSource["role"], extra = ""): CourseSyllabusSource => ({
      resourceId: c.r.id,
      role,
      tier: c.tier,
      reason: c.reason + extra,
      title: c.r.title,
      url: c.r.url,
      hasText: !!c.r.text.trim(),
    });
    selected.push(source(primary, "primary"));
    const rest = ranked.slice(1).filter((c) => c.r.text.trim());
    const primaryAi = policySignals(primary.r.text).ai;
    const withAi = primaryAi ? undefined : rest.find((c) => policySignals(c.r.text).ai);
    const supplement = withAi ?? (primary.r.text.trim() ? rest.find((c) => c.tier === 4) : rest[0]);
    if (supplement)
      selected.push(
        source(
          supplement,
          "supplement",
          withAi ? "; supplement: mentions AI where the primary does not" : !primary.r.text.trim() ? "; supplement: the primary has no captured text yet" : "",
        ),
      );
  }
  return { selected, rejected };
}

export function compileCourseIntelligence(
  accountScope: string,
  courseId: string,
  resources: Resource[],
  compiledAt: string,
  previous?: CourseIntelligence,
  extraction?: CourseExtractionBatch,
  sources: Pick<SourceHealth, "id" | "kind" | "scope">[] = [],
  /**
   * The selected syllabus sources: their resource ids are the `syllabusResourceIds` set that course-level
   * facts may come from (H6). Absent: code selects them here from the same resources and sources.
   */
  syllabusSources?: CourseSyllabusSource[],
): CourseIntelligence {
  const ordered = [...resources].sort((a, b) => a.id.localeCompare(b.id));
  const inputHash = courseInputHash(ordered);
  const claims: CourseClaim[] = [];
  function add(c: Omit<CourseClaim, "id">) {
    claims.push({ id: hash(c), ...c });
  }
  const trusted = (r: Resource) => {
    const source = sources.find((s) => s.id === r.sourceId);
    return (
      !!source &&
      (source.kind === "canvas" || source.kind === "fixture") &&
      !r.gitlab
    );
  };
  const selection =
    syllabusSources ?? selectSyllabus(ordered, sources, { at: compiledAt }).selected;
  const syllabusResourceIds = new Set(selection.map((s) => s.resourceId));
  // The Canvas syllabus tab always counts (as before); the selected sources are added to it.
  const syllabus = (r: Resource) =>
    (trusted(r) &&
      r.externalId === "syllabus" &&
      sources.find((s) => s.id === r.sourceId)?.scope === "syllabus") ||
    syllabusResourceIds.has(r.id);
  const modelMethod: CourseClaim["method"] = extraction?.extractorVersion.startsWith(
    CLIENT_EXTRACTOR_PREFIX,
  )
    ? "client_model"
    : "local_model";
  for (const r of ordered) {
    if (!trusted(r)) {
      // A selected course-site page (tier 3) gives literal course-level passages, nothing structured.
      if (syllabusResourceIds.has(r.id)) literal(r);
      continue;
    }
    if (r.assignmentGroup) {
      for (const [key, value] of Object.entries(r.assignmentGroup)) {
        if (key === "position") continue;
        add({
          kind: "grading",
          scope: "course",
          label: `${r.title}: ${key}`,
          value: typeof value === "number" ? value : JSON.stringify(value),
          method: "structured",
          evidence: [fieldEvidence(r, `assignmentGroup.${key}`, value)],
        });
      }
    }
    if (r.kind === "assignment") {
      for (const [key, value] of Object.entries({
        points: r.points,
        submissionTypes: r.submissionTypes,
        rubric: r.rubric,
        assignmentGroupId: r.assignmentGroupId,
      })) {
        if (value == null || (Array.isArray(value) && !value.length)) continue;
        add({
          kind:
            key === "points" || key === "assignmentGroupId"
              ? "grading"
              : "assessment",
          ...scope(r),
          label: key,
          value: typeof value === "number" ? value : JSON.stringify(value),
          method: "structured",
          evidence: [fieldEvidence(r, key, value)],
        });
      }
    }
    // Existing explicit policy records are preserved as assertions, with their original field provenance.
    if (
      r.policy.mode !== "unknown" &&
      r.policy.evidence &&
      (r.kind === "assignment" || r.kind === "course" || syllabus(r))
    ) {
      add({
        kind: "ai_policy",
        ...scope(r),
        label: "Captured policy assertion",
        value: r.policy.evidence,
        method: "structured",
        policyMode: r.policy.mode,
        evidence: [fieldEvidence(r, "policy", r.policy)],
      });
    }
    // Course-level extraction is restricted to the syllabus sources code selected (not arbitrary linked pages).
    if (!syllabus(r) && r.kind !== "assignment") continue;
    literal(r);
  }
  function literal(r: Resource) {
    let section: Section | undefined;
    for (const match of r.text.matchAll(/[^\n]+/g)) {
      const line = match[0],
        start = match.index!;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const opened = trimmed.length <= 80 ? headingSection(trimmed) : undefined;
      if (opened !== undefined) section = opened ?? undefined;
      // Under "Academic integrity" only lines that talk about AI become AI-policy passages.
      const kind: CourseClaim["kind"] | undefined = isAiLine(line)
        ? "ai_policy"
        : section === "integrity"
          ? undefined
          : section;
      if (!kind || line.length > 4000) continue;
      add({
        kind,
        ...scope(r),
        label:
          kind === "ai_policy" ? "AI policy passage" : "Source section passage",
        value: line,
        method: "literal",
        ...(kind === "ai_policy"
          ? {
              policyMode:
                r.text.trim() === line.trim()
                  ? literalPolicyMode(line)
                  : "unknown",
            }
          : {}),
        evidence: [textEvidence(r, start, start + line.length)],
      });
    }
  }
  if (extraction?.inputHash === inputHash)
    for (const c of extraction.candidates.slice(0, 300)) {
      const r = ordered.find(
        (r) => r.id === c.resourceId && r.contentHash === c.contentHash,
      );
      if (
        !r ||
        typeof c.quote !== "string" ||
        typeof c.label !== "string" ||
        typeof c.value !== "string" ||
        (!syllabus(r) && !(trusted(r) && r.kind === "assignment")) ||
        !Number.isInteger(c.start) ||
        !Number.isInteger(c.end) ||
        c.start < 0 ||
        c.end <= c.start ||
        c.end > r.text.length ||
        r.text.slice(c.start, c.end) !== c.quote ||
        !c.quote.trim() ||
        c.quote.length > 4000 ||
        c.value !== c.quote ||
        c.label.length > 300 ||
        c.value.length > 4000
      )
        continue;
      if (!["ai_policy", "grading", "topic", "assessment"].includes(c.kind))
        continue;
      // A grounded quote is not proof of model interpretation. No inferred permission or numeric grade computation.
      add({
        kind: c.kind,
        ...scope(r),
        label: c.label,
        value: c.value,
        method: modelMethod,
        evidence: [textEvidence(r, c.start, c.end)],
        ...(c.kind === "ai_policy"
          ? {
              policyMode:
                r.text.trim() === c.quote.trim()
                  ? literalPolicyMode(c.quote)
                  : "unknown",
            }
          : {}),
      });
    }
  const conflicts: CourseIntelligence["conflicts"] = [];
  for (const assignmentId of new Set(
    claims.filter((c) => c.kind === "ai_policy").map((c) => c.assignmentId),
  )) {
    const policies = claims.filter(
      (c) =>
        c.kind === "ai_policy" &&
        c.assignmentId === assignmentId &&
        c.policyMode !== "unknown",
    );
    if (new Set(policies.map((c) => c.policyMode)).size > 1)
      conflicts.push({
        kind: "ai_policy",
        claimIds: policies.map((c) => c.id),
        reason:
          "Policy assertions disagree at the same scope; no permissive resolution inferred.",
      });
  }
  const rejectedByCompiler = extraction
    ? extraction.candidates.length -
      claims.filter((c) => c.method === modelMethod).length
    : 0;
  const extractionCoverage =
    extraction && rejectedByCompiler > 0
      ? {
          status: "partial" as const,
          examinedResourceIds: extraction.coverage?.examinedResourceIds ?? [],
          omittedResourceIds: extraction.coverage?.omittedResourceIds ?? [],
          rejectedCandidates:
            (extraction.coverage?.rejectedCandidates ?? 0) + rejectedByCompiler,
        }
      : extraction?.coverage;
  const unknowns = [
    "Captured sources do not establish complete course coverage.",
    "Syllabus term relevance and completeness require verification; old copies may remain published.",
    "Topic presence does not establish exam scope or student mastery.",
    "Canvas group weights do not establish that weighting is enabled or the final grade formula.",
  ];
  for (const kind of ["ai_policy", "grading", "topic", "assessment"] as const)
    if (!claims.some((c) => c.kind === kind))
      unknowns.push(`No ${kind} evidence recognized in captured sources.`);
  if (extractionCoverage?.status === "partial")
    unknowns.push(
      "Semantic extraction was partial; some source text or candidates were omitted.",
    );
  if (!extraction)
    unknowns.push(
      "Semantic extraction has not run; prose coverage is limited to literal sections and structured fields.",
    );
  if (!selection.length)
    unknowns.push("No syllabus was found among the captured sources.");
  else if (!selection.some((s) => s.hasText))
    unknowns.push("The selected syllabus has no captured text yet.");
  return {
    id: courseIntelligenceId(accountScope, courseId),
    accountScope,
    courseId,
    courseName: ordered[0]?.courseName ?? courseId,
    version: (previous?.version ?? 0) + 1,
    compilerVersion: COURSE_COMPILER_VERSION,
    ...(extraction
      ? {
          extraction: {
            extractorVersion: extraction.extractorVersion,
            resultHash: hash(extraction),
            coverage: extractionCoverage,
          },
        }
      : {}),
    inputHash,
    compiledAt,
    claims,
    unknowns,
    conflicts,
    dependencies: ordered.map((r) => ({
      resourceId: r.id,
      contentHash: r.contentHash,
      version: r.version,
    })),
    syllabus: selection,
  };
}
export function intelligenceView(
  profile: CourseIntelligence,
  sources: SourceHealth[],
  now: string,
): CourseIntelligenceView {
  const coverage = sources
    .filter(
      (s) =>
        s.accountScope === profile.accountScope &&
        s.courseId === profile.courseId,
    )
    .map(({ id, status, complete, lastAttemptAt, lastSuccessAt }) => ({
      sourceId: id,
      status,
      complete,
      lastAttemptAt,
      lastSuccessAt,
    }));
  const stale = coverage.some(
    (s) =>
      !s.lastSuccessAt ||
      Date.parse(now) - Date.parse(s.lastSuccessAt) > 24 * 60 * 60 * 1000 ||
      !["ok", "partial"].includes(s.status),
  );
  return {
    ...profile,
    coverage,
    freshness: stale
      ? "stale"
      : coverage.some((s) => !s.complete || s.status !== "ok")
        ? "partial"
        : "current_capture",
  };
}
// Pure policy projection is shared by backend enforcement and renderer evidence displays.
export { effectiveCoursePolicy } from "./course-policy";
