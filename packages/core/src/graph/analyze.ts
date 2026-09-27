/**
 * The code-first analyzers (the material pipeline). No model is called here: every fact is a rule
 * over a structured field, the title or the text, and carries the exact quote it came from.
 * What code can't settle is written as `needs_judgment` for a later Jev or AI pass.
 */
import type { MaterialFactsInput, ResourceRefInput } from "../../../contracts/src/course-core";
import { classifyHost } from "../../../connectors/src/space-hosts";
import type { CourseIndex, Res } from "./course-index";
import { normaliseUrl } from "./course-index";

export const ANALYZER_VERSION = "graph.classify.v1";
export const roles = ["syllabus", "lecture", "reading", "homework", "lab", "exam", "solutions", "rubric", "admin"] as const;
export type Role = (typeof roles)[number];
type Fact = MaterialFactsInput["facts"][number];

/** Order is priority: "Exam 1 solutions" is solutions, "Homework 3 rubric" is a rubric. */
const roleRules: [Role, RegExp][] = [
  ["syllabus", /\b(syllabus|course (?:outline|overview))\b/i],
  ["solutions", /\b(solutions?|solns?|answer keys?)\b/i],
  ["rubric", /\b(rubrics?|grading (?:criteria|guide|scheme))\b/i],
  ["exam", /\b(exams?|midterms?|final exam|quiz(?:zes)?|practice (?:exam|test|midterm|final|problems)|(?<!peer[- ])review|study guide|tests?\s*#?\d)\b/i],
  ["lab", /\b(labs?|laboratory|lab\s*#?\d+)\b/i],
  ["homework", /\b(hw\s*#?\d*|homeworks?|problem sets?|psets?|ps\s*#?\d+|assignments?|worksheets?|exercises?|projects?|essays?|write-?ups?|peer[- ]review|programming assignment|reflections?)\b/i],
  ["lecture", /\b(lectures?|lec\s*#?\d+|slides?|slide deck|notes|recordings?|videos?|powerpoint)\b/i],
  ["reading", /\b(readings?|chapters?|ch\.?\s*\d+|textbook|articles?|excerpts?|pp\.\s*\d+)\b/i],
  [
    "admin",
    /\b(welcome|introductions?|start here|getting started|office hours|staff|instructors?|contact|polic(?:y|ies)|announcements?|zoom|piazza|faq|academic (?:integrity|misconduct)|accommodations?|mcburney|surveys?|evaluations?|grading|grades|schedule|calendar|logistics|meet the|expectations|technology|tutoring|resources|course (?:info|information))\b/i,
  ],
];
const lectureTypes = /presentation|powerpoint|ms-ppt|keynote/i;

function firstMatch(value: string, rules = roleRules): { role: Role; start: number; end: number } | undefined {
  for (const [role, re] of rules) {
    const m = re.exec(value);
    if (m) return { role, start: m.index, end: m.index + m[0].length };
  }
  return undefined;
}

export interface Analysis {
  role: Role | undefined;
  facts: Fact[];
}

const structure = (kind: Fact["kind"], value: string, quote: string): Fact => {
  const q = quote.slice(0, 2000) || value;
  return { kind, value: value.slice(0, 4000), basis: "structure", quote: q, start: 0, end: q.length };
};

/** The role and where it came from: title, assignment group, text head, module, then Canvas type. */
export function classifyRole(index: CourseIndex, r: Res): { role: Role; fact: Fact } | undefined {
  const type = index.contentType(r);
  if (type === "syllabus") return { role: "syllabus", fact: structure("role", "syllabus", "Canvas syllabus") };
  const title = firstMatch(r.title);
  if (title) return { role: title.role, fact: { kind: "role", value: title.role, basis: "title", start: title.start, end: title.end } };
  const group = r.assignmentGroupId ? index.groupTitle.get(r.assignmentGroupId) : undefined;
  const byGroup = group ? firstMatch(group) : undefined;
  if (byGroup && group) return { role: byGroup.role, fact: structure("role", byGroup.role, group) };
  const folder = r.file?.folderId ? index.folderTitle.get(r.file.folderId) : undefined;
  const byFolder = folder ? firstMatch(folder) : undefined;
  if (byFolder && folder) return { role: byFolder.role, fact: structure("role", byFolder.role, folder) };
  // The text's first line only (its heading): a sentence further in ("submit your solutions") isn't a role.
  const head = r.text.trimStart().split("\n", 1)[0]!.slice(0, 120);
  const headAt = r.text.length - r.text.trimStart().length;
  const byText = head ? firstMatch(head) : undefined;
  if (byText && byText.role !== "admin")
    return { role: byText.role, fact: { kind: "role", value: byText.role, basis: "text", start: headAt + byText.start, end: headAt + byText.end } };
  const contentType = r.file?.contentType ?? r.contentType;
  if (contentType && lectureTypes.test(contentType)) return { role: "lecture", fact: structure("role", "lecture", contentType) };
  const external = r.moduleItem?.externalUrl;
  if (external) {
    try {
      const kind = classifyHost(new URL(external).hostname).rule.kind;
      if (kind === "video") return { role: "lecture", fact: structure("role", "lecture", `host kind: ${kind}`) };
      if (kind === "etext") return { role: "reading", fact: structure("role", "reading", `host kind: ${kind}`) };
    } catch {
      /* stored URLs are valid */
    }
  }
  for (const moduleId of index.modulesOf.get(r.id) ?? []) {
    const m = index.modules.get(moduleId);
    const byModule = m?.title ? firstMatch(m.title) : undefined;
    if (byModule && m && byModule.role !== "admin") return { role: byModule.role, fact: structure("role", byModule.role, m.title) };
  }
  if (byText) return { role: byText.role, fact: { kind: "role", value: byText.role, basis: "text", start: headAt + byText.start, end: headAt + byText.end } };
  if (type === "assignment") return { role: "homework", fact: structure("role", "homework", "Canvas assignment") };
  if (type === "quiz") return { role: "exam", fact: structure("role", "exam", "Canvas quiz") };
  if (type === "announcement") return { role: "admin", fact: structure("role", "admin", "Canvas announcement") };
  return undefined;
}

const sessionRules: [string, RegExp][] = [
  ["week", /\b(?:week|wk)\s*#?\s*(\d{1,2})\b/i],
  ["session", /\b(?:lecture|lec|class|session|day|unit|module|topic|chapter|ch\.?)\s*#?\s*(\d{1,3})\b/i],
];

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthDate =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(20\d\d))?/gi;
const isoDate = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
const slashDate = /(?:\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+|\b(?:due|on|by)\s+)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/gi;

function inferYear(month: number, day: number, reference: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ref = new Date(reference);
  const target = reference + 60 * 86_400_000;
  let best: string | undefined;
  let distance = Infinity;
  for (const year of [ref.getUTCFullYear() - 1, ref.getUTCFullYear(), ref.getUTCFullYear() + 1]) {
    const at = Date.UTC(year, month - 1, day);
    if (new Date(at).getUTCDate() !== day) continue;
    const d = Math.abs(at - target);
    if (d < distance) {
      distance = d;
      best = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return best;
}

/** The line around an offset, at most 200 characters: the quote a date fact carries. */
function lineAround(text: string, start: number, end: number): [number, number] {
  let a = text.lastIndexOf("\n", start - 1) + 1;
  let b = text.indexOf("\n", end);
  if (b < 0) b = text.length;
  if (start - a > 100) a = start - 100;
  if (b - end > 100) b = end + 100;
  while (a < start && /\s/.test(text[a]!)) a++;
  while (b > end && /\s/.test(text[b - 1]!)) b--;
  return [a, b];
}

export function dateFacts(r: Res): Fact[] {
  const text = r.text;
  if (!text) return [];
  const reference = Date.parse(r.createdAt ?? r.updatedAt ?? r.observedAt) || Date.parse(r.observedAt);
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const add = (iso: string | undefined, start: number, end: number) => {
    if (!iso || facts.length >= 60) return;
    const [a, b] = lineAround(text, start, end);
    const key = `${iso}:${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ kind: "date", value: iso, basis: "text", start: a, end: b });
  };
  for (const m of text.matchAll(monthDate)) {
    const month = months.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    const day = Number(m[2]);
    const iso = m[3] ? inferYear(month, day, Date.UTC(Number(m[3]), month - 1, day) - 60 * 86_400_000) : inferYear(month, day, reference);
    add(iso, m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(isoDate)) add(inferYear(Number(m[2]), Number(m[3]), Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 60 * 86_400_000), m.index, m.index + m[0].length);
  for (const m of text.matchAll(slashDate)) {
    const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined;
    const month = Number(m[1]);
    const day = Number(m[2]);
    add(year ? inferYear(month, day, Date.UTC(year, month - 1, day) - 60 * 86_400_000) : inferYear(month, day, reference), m.index, m.index + m[0].length);
  }
  return facts;
}

const labelStop = new Set(
  "due points note notes date time location email office instructor room website phone hint example answer question part step submission deadline grading goal goals objective objectives task input output format total name title when where who what why how score problem exercise section chapter week lecture lab homework quiz exam reading readings important update reminder link links file files zoom tip tips warning".split(" "),
);
const definitionLine = /^[ \t]*(?:def(?:inition)?\.?\s*\d*[:.]?\s*)?([A-Z][A-Za-z0-9'()\- ]{1,48}?)[ \t]*(?::|—|–| - )[ \t]+(\S[^\n]{14,299})$/gm;
const definedAs = /\b([A-Za-z][A-Za-z\- ]{1,40}?)\s+(?:is|are)\s+(?:defined as|known as|referred to as)\s+[^.\n]{3,200}/g;
const calledAs = /\b(?:is|are)\s+called\s+(?:an?\s+|the\s+)?([a-z][\w\- ]{1,40}?)(?=[.,;:\n)])/gi;

export function termFacts(text: string): Fact[] {
  const facts: Fact[] = [];
  for (const m of text.matchAll(definitionLine)) {
    const term = m[1]!.trim();
    if (term.split(/\s+/).length > 5 || labelStop.has(term.toLowerCase()) || /^\d/.test(term) || /https?:/.test(m[2]!)) continue;
    const termStart = m.index + m[0].indexOf(m[1]!);
    facts.push({ kind: "term", value: term, basis: "text", start: termStart, end: termStart + term.length });
    facts.push({ kind: "definition", value: term, basis: "text", start: m.index + (m[0].length - m[0].trimStart().length), end: m.index + m[0].length });
    if (facts.length >= 200) return facts;
  }
  for (const m of text.matchAll(definedAs)) {
    const term = m[1]!.trim().split(/\s+/).slice(-4).join(" ").replace(/^(?:an?|the)\s+/i, "");
    if (!term) continue;
    const termStart = m.index + m[0].indexOf(term);
    if (termStart < m.index) continue;
    facts.push({ kind: "term", value: term, basis: "text", start: termStart, end: termStart + term.length });
    facts.push({ kind: "definition", value: term, basis: "text", start: m.index, end: m.index + m[0].length });
    if (facts.length >= 200) return facts;
  }
  for (const m of text.matchAll(calledAs)) {
    const term = m[1]!.trim();
    const termStart = m.index + m[0].lastIndexOf(term);
    facts.push({ kind: "term", value: term, basis: "text", start: termStart, end: termStart + term.length });
    if (facts.length >= 200) return facts;
  }
  return facts;
}

const codeLine = /;\s*$|[{}]\s*$|==|^\s*(?:let|var|const|int|def|return|for\s*\(|while\s*\(|public|private|void|import)\b/;
const mathChar = /[+\-*/^√∑∫≤≥≈∞πθλμσ]|\b(?:sin|cos|tan|log|ln|exp|sqrt|lim|max|min)\b/;
export function formulaFacts(text: string): Fact[] {
  const facts: Fact[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length >= 3 &&
      trimmed.length <= 160 &&
      /[A-Za-z0-9)\]]\s*=\s*[-A-Za-z0-9(\\√]/.test(trimmed) &&
      !/https?:|www\./.test(trimmed)
    ) {
      const code = codeLine.test(trimmed);
      if (code || mathChar.test(trimmed)) {
        const start = offset + line.indexOf(trimmed);
        facts.push({ kind: code ? "code" : "formula", value: trimmed, basis: "text", start, end: start + trimmed.length });
        if (facts.length >= 200) break;
      }
    }
    offset += line.length + 1;
  }
  return facts;
}

const coversPhrase =
  /\b(?:covers?|covering|will cover|material from|topics? (?:on|for) (?:the )?(?:exam|midterm|quiz|final))\b[^.\n]{0,160}?\b(?:chapters?|ch\.|sections?|lectures?|weeks?|modules?|units?|topics?)\b[^.\n]{0,80}/gi;
const assessmentName = /\b(midterm|exam|final exam|quiz|test)(?:\s*#?\s*(\d{1,2}))?\b/i;

/** The course's assessments: assignment and quiz resources whose role is exam. */
export function assessmentsOf(index: CourseIndex, roleOf: (r: Res) => Role | undefined): Res[] {
  return [...index.assignmentById.values(), ...index.quizById.values()].filter(
    (r, i, all) => all.indexOf(r) === i && roleOf(r) === "exam",
  );
}
const normalName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every fact for one resource; `assessments` are the course's exam-role assignments and quizzes. */
export function analyzeResource(index: CourseIndex, r: Res, assessments: Res[]): Analysis {
  const facts: Fact[] = [];
  const classified = classifyRole(index, r);
  const role = classified?.role;
  if (classified) facts.push(classified.fact);
  else facts.push(structure("needs_judgment", "role", r.title));

  const moduleIds = index.modulesOf.get(r.id) ?? [];
  for (const id of moduleIds) {
    const m = index.modules.get(id);
    facts.push(structure("module", id, m?.title || `module ${id}`));
  }
  let session: Fact | undefined;
  for (const [label, re] of sessionRules) {
    const m = re.exec(r.title);
    if (m) {
      session = { kind: "session", value: `${label}:${Number(m[1])}`, basis: "title", start: m.index, end: m.index + m[0].length };
      break;
    }
  }
  if (!session)
    for (const id of moduleIds) {
      const title = index.modules.get(id)?.title ?? "";
      for (const [label, re] of sessionRules) {
        const m = re.exec(title);
        if (m) {
          session = structure("session", `${label}:${Number(m[1])}`, title);
          break;
        }
      }
      if (session) break;
    }
  if (session) facts.push(session);

  facts.push(...dateFacts(r));
  if (r.text && role !== "admin" && role !== "syllabus" && role !== "rubric") {
    facts.push(...termFacts(r.text));
    facts.push(...formulaFacts(r.text));
  }

  // Which assessments it covers (materials only; an assessment doesn't cover itself).
  const type = index.contentType(r);
  const isAssessment = type === "assignment" || type === "quiz";
  if (!isAssessment && role && role !== "admin" && role !== "syllabus") {
    const byName = new Map(assessments.map((a) => [normalName(a.title), a]));
    const covers: Fact[] = [];
    const named = assessmentName.exec(r.title);
    if (named) {
      const want = normalName(named[0]);
      const match = [...byName].find(([name]) => name.includes(want));
      covers.push({ kind: "covers", value: match ? match[1].id : named[0], basis: "title", start: named.index, end: named.index + named[0].length });
    }
    if (role === "exam" && r.text)
      for (const m of r.text.matchAll(coversPhrase)) {
        covers.push({ kind: "covers", value: m[0].slice(0, 200), basis: "text", start: m.index, end: m.index + m[0].length });
        if (covers.length >= 20) break;
      }
    if (!covers.length)
      for (const id of moduleIds) {
        const m = index.modules.get(id);
        for (const a of assessments)
          if ((index.modulesOf.get(a.id) ?? []).includes(id)) covers.push(structure("covers", a.id, m?.title || `module ${id}`));
      }
    facts.push(...covers);
    if (role === "exam" && !covers.length) facts.push(structure("needs_judgment", "covers", r.title));
  }
  return { role, facts };
}

// ---------- Outgoing references ----------
export interface ExternalFound {
  url: string;
  title: string | null;
  hostClass: string;
  treatment: "store" | "link";
}
export interface LinkAnalysis {
  refs: (ResourceRefInput & { external?: ExternalFound })[];
}
const bareUrl = /https?:\/\/[^\s<>"')\]]+/g;
const genericTitles = new Set(
  "syllabus home homepage front page notes slides readings resources schedule announcements lecture homework course information modules files".split(" "),
);
const trunc = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A resource's outgoing references: its body links (resolved) and the course files and pages it names. */
export function analyzeLinks(index: CourseIndex, r: Res): LinkAnalysis {
  const refs: LinkAnalysis["refs"] = [];
  const seen = new Set<string>();
  const found: { url: string; text?: string }[] = [];
  for (const link of r.links ?? []) found.push(typeof link === "string" ? { url: link } : { url: link.url, ...(link.text ? { text: link.text } : {}) });
  if (r.moduleItem?.externalUrl) found.push({ url: r.moduleItem.externalUrl, text: r.moduleItem.title ?? r.title });
  for (const m of r.text.matchAll(bareUrl)) found.push({ url: m[0].replace(/[.,;:!?]+$/, "") });
  for (const link of found) {
    const resolution = index.resolve(link.url);
    const reason = `linked in the body${link.text ? ` as "${trunc(link.text.trim(), 80)}"` : ""}`;
    if (resolution.type === "ignore") continue;
    if (resolution.type === "resource") {
      if (resolution.resource.id === r.id || seen.has(resolution.resource.id)) continue;
      seen.add(resolution.resource.id);
      refs.push({ toResourceId: resolution.resource.id, externalRefId: null, target: normaliseUrl(link.url) ?? link.url, kind: resolution.kind, strength: "direct", reason });
      continue;
    }
    if (seen.has(resolution.url)) continue;
    seen.add(resolution.url);
    if (resolution.type === "unresolved") {
      refs.push({ toResourceId: null, externalRefId: null, target: resolution.url, kind: resolution.kind, strength: "direct", reason: `${reason}; not captured` });
      continue;
    }
    const rule = classifyHost(new URL(resolution.url).hostname).rule;
    refs.push({
      toResourceId: null,
      externalRefId: null,
      target: resolution.url,
      kind: "external",
      strength: "direct",
      reason,
      external: { url: resolution.url, title: link.text?.trim().slice(0, 500) || null, hostClass: rule.kind, treatment: rule.treatment },
    });
  }
  // Named: course files and pages whose name appears in the text (word-bounded, case-insensitive).
  if (r.text) {
    const lower = r.text.toLowerCase();
    const candidates = [...index.pageBySlug.values(), ...index.fileById.values()];
    for (const c of candidates) {
      if (c.id === r.id || seen.has(c.id)) continue;
      const names = new Set([c.title, c.file?.displayName ?? c.title].flatMap((n) => [n, n.replace(/\.[a-z0-9]{2,5}$/i, "")]));
      for (const name of names) {
        const needle = name.trim().toLowerCase();
        if (needle.length < 6 || genericTitles.has(needle)) continue;
        let at = lower.indexOf(needle);
        while (at >= 0) {
          const before = at === 0 ? " " : lower[at - 1]!;
          const after = lower[at + needle.length] ?? " ";
          if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) break;
          at = lower.indexOf(needle, at + 1);
        }
        if (at < 0) continue;
        seen.add(c.id);
        refs.push({
          toResourceId: c.id,
          externalRefId: null,
          target: r.text.slice(at, at + needle.length),
          kind: index.contentType(c) ?? "page",
          strength: "named",
          reason: `named in the body: "${trunc(r.text.slice(at, at + needle.length), 120)}"`,
        });
        break;
      }
    }
  }
  return { refs };
}
