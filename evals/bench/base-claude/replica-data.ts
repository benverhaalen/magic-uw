/**
 * The synthetic account behind the replica: deterministic from (seed, scale, anchor), sized like the
 * operator's account at "full" (6 current + 6 past-term courses, ~800 items, ~230 files, 4 courses
 * with the Files tab hidden, a syllabus per course as a tab, page or PDF). Entirely fabricated; with
 * `ocwDir` the public variant takes page text and PDFs from the local OCW corpus at run time (never
 * copied into the repository).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { buildDocx, buildPdf, buildPptx } from "./docs";
import { htmlToText, rng } from "./text";

export type Scale = "tiny" | "full";
export interface RFile { id: string; name: string; contentType: string; bytes: Uint8Array; updatedAt: string; folderId: string }
export interface RPage { pageId: string; url: string; title: string; bodyHtml: string; updatedAt: string }
export interface RItem {
  id: string; moduleId: string; title: string; type: string; position: number;
  contentId?: string; pageUrl?: string; externalUrl?: string;
}
export interface RModule { id: string; name: string; position: number; items: RItem[] }
export interface RGroup { id: string; name: string; weight: number | null; position: number }
export interface RAssignment {
  id: string; name: string; dueAt: string | null; points: number | null; groupId: string; descriptionHtml: string;
  submissionTypes: string[]; quizId?: string; discussionId?: string; updatedAt: string;
}
export interface RQuiz { id: string; title: string; assignmentId: string; dueAt: string | null; points: number; descriptionHtml: string }
export interface RTopic { id: string; title: string; messageHtml: string; postedAt: string; assignmentId?: string }
export interface RCourse {
  index: number;
  id: string;
  name: string;
  code: string;
  term: { id: string; name: string; start: string | null; end: string | null };
  kind: "current" | "past" | "restricted" | "org";
  filesHidden: boolean;
  weighted: boolean;
  syllabusMode: "body" | "page" | "file";
  syllabusHtml: string;
  modules: RModule[];
  groups: RGroup[];
  assignments: RAssignment[];
  quizzes: RQuiz[];
  pages: RPage[];
  files: RFile[];
  announcements: RTopic[];
  discussions: RTopic[];
}
export interface Account {
  anchor: Date;
  now: Date;
  user: { id: string; name: string };
  courses: RCourse[];
}

const TOPICS: Array<{ code: string; title: string; words: string[] }> = [
  { code: "COMP SCI 577", title: "Introduction to Algorithms", words: "graph greedy dynamic programming recurrence divide conquer shortest path flow network matching reduction complexity invariant proof induction heap sorting hashing amortized bound".split(" ") },
  { code: "MATH 340", title: "Elementary Matrix and Linear Algebra", words: "matrix vector span basis eigenvalue eigenvector determinant rank kernel subspace orthogonal projection transformation inverse row reduction pivot diagonal symmetric".split(" ") },
  { code: "STAT 309", title: "Introduction to Probability", words: "probability random variable distribution expectation variance binomial poisson normal conditional independence bayes sample likelihood estimator moment generating".split(" ") },
  { code: "HISTORY 201", title: "The Historian's Craft", words: "archive source evidence argument historiography primary secondary context chronology interpretation citation narrative empire migration memory document".split(" ") },
  { code: "CHEM 103", title: "General Chemistry I", words: "atom molecule bond stoichiometry equilibrium enthalpy entropy reaction mole solution acid base oxidation electron orbital periodic gas".split(" ") },
  { code: "ENGLISH 120", title: "Introduction to College Composition", words: "thesis paragraph revision audience rhetoric claim evidence draft outline citation genre voice analysis synthesis argument peer review".split(" ") },
];
const PAST: Array<{ code: string; title: string }> = [
  { code: "PSYCH 202", title: "Introduction to Psychology" },
  { code: "ECON 101", title: "Principles of Microeconomics" },
  { code: "BIOLOGY 151", title: "Introductory Biology" },
  { code: "PHYSICS 207", title: "General Physics" },
  { code: "SOC 134", title: "Problems of American Racial and Ethnic Minorities" },
  { code: "ART HIST 201", title: "Global Art and Architecture" },
];
const FILLER = "the of and to in for with on as by from this that each which course students week notes review example problem section".split(" ");

function seasonName(date: Date): string {
  const m = date.getUTCMonth();
  return m >= 8 ? "Fall" : m >= 5 ? "Summer" : "Spring";
}
/** Wall-clock time in America/Chicago to a UTC instant (DST-aware via Intl). */
export function chicago(y: number, month: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, month, d, h, mi);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }).formatToParts(new Date(at));
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-6";
    const m = name.match(/GMT([+-]\d+)(?::(\d+))?/);
    return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : -360;
  };
  return new Date(guess - offset(guess - 6 * 3600_000) * 60_000);
}
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

interface OcwCourse { name: string; pages: { title: string; text: string }[]; pdfs: { name: string; bytes: Uint8Array }[] }
function loadOcw(dir: string | undefined): OcwCourse[] {
  if (!dir || !existsSync(dir)) return [];
  const out: OcwCourse[] = [];
  for (const name of readdirSync(dir).sort()) {
    const root = join(dir, name);
    if (!statSync(root).isDirectory()) continue;
    const pages: OcwCourse["pages"] = [];
    const pagesDir = join(root, "pages");
    if (existsSync(pagesDir))
      for (const p of readdirSync(pagesDir).sort()) {
        const file = join(pagesDir, p, "index.html");
        if (!existsSync(file)) continue;
        const html = readFileSync(file, "utf8");
        const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
        const text = htmlToText(main).slice(0, 6000);
        if (text.length > 300) pages.push({ title: p.replace(/-/g, " "), text });
        if (pages.length >= 14) break;
      }
    const pdfs: OcwCourse["pdfs"] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d).sort()) {
        if (pdfs.length >= 36) return;
        const full = join(d, entry);
        const info = statSync(full);
        if (info.isDirectory()) walk(full);
        else if (/\.pdf$/i.test(entry) && info.size < 3_000_000) pdfs.push({ name: basename(entry), bytes: readFileSync(full) });
      }
    };
    walk(root);
    out.push({ name, pages, pdfs });
  }
  return out;
}

export function buildAccount(options: { seed?: number; scale?: Scale; anchor?: Date; ocwDir?: string } = {}): Account {
  const scale = options.scale ?? "full";
  const anchor = new Date(Date.UTC(
    (options.anchor ?? new Date()).getUTCFullYear(), (options.anchor ?? new Date()).getUTCMonth(), (options.anchor ?? new Date()).getUTCDate(),
  ));
  const now = new Date(anchor.getTime() + 15 * 3600_000);
  const random = rng(options.seed ?? 20260927);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
  const ocw = loadOcw(options.ocwDir);
  const full = scale === "full";

  const termStart = new Date(anchor.getTime() - 30 * 86400_000);
  const termEnd = new Date(anchor.getTime() + 80 * 86400_000);
  const currentTerm = { id: "171", name: `${seasonName(anchor)} ${anchor.getUTCFullYear()}`, start: iso(termStart), end: iso(termEnd) };
  const pastStart = new Date(anchor.getTime() - 250 * 86400_000);
  const pastTerm = { id: "170", name: `${seasonName(pastStart)} ${pastStart.getUTCFullYear()}`, start: iso(pastStart), end: iso(new Date(anchor.getTime() - 130 * 86400_000)) };

  const sentence = (words: string[], n = 10 + Math.floor(random() * 8)) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(random() < 0.55 ? pick(words) : pick(FILLER));
    const s = out.join(" ");
    return s[0]!.toUpperCase() + s.slice(1) + ".";
  };
  const paragraph = (words: string[], n = 3 + Math.floor(random() * 3)) => Array.from({ length: n }, () => sentence(words)).join(" ");

  const courses: RCourse[] = [];
  const currentCount = full ? 6 : 2;
  const pastCount = full ? 6 : 2;
  for (let c = 0; c < currentCount; c++) {
    const topic = TOPICS[c]!;
    const words = topic.words;
    const id = String(412000 + c);
    const ocwCourse = ocw[c];
    const course: RCourse = {
      index: c, id, name: `${topic.code}: ${topic.title}`, code: topic.code, term: currentTerm, kind: "current",
      filesHidden: full ? c < 4 : c === 0,
      weighted: c !== 3,
      syllabusMode: (["body", "page", "file"] as const)[c % 3]!,
      syllabusHtml: "", modules: [], groups: [], assignments: [], quizzes: [], pages: [], files: [], announcements: [], discussions: [],
    };
    const origin = "";
    const fileUrl = (fid: string) => `${origin}/courses/${id}/files/${fid}?wrap=1`;
    const pageHref = (s: string) => `${origin}/courses/${id}/pages/${s}`;
    const updated = iso(new Date(termStart.getTime() + (5 + c) * 86400_000));

    // Groups
    const groupDefs: Array<[string, number]> = [["Homework", 40], ["Quizzes", 20], ["Exams", 30], ["Participation", 10]];
    course.groups = groupDefs.map(([name, weight], g) => ({ id: String(60000 + c * 10 + g), name, weight: course.weighted ? weight : null, position: g + 1 }));

    // Files
    const fileCount = full ? 40 : 6;
    let fileSeq = 0;
    const makeFile = (label: string, kind: "pdf" | "docx" | "pptx" | "txt" | "mp4"): RFile => {
      const fid = String(30000000 + c * 1000 + fileSeq++);
      const lines = () => Array.from({ length: 12 + Math.floor(random() * 14) }, () => sentence(words, 8 + Math.floor(random() * 6)));
      const ocwPdf = kind === "pdf" && ocwCourse?.pdfs[fileSeq - 1];
      if (ocwPdf)
        return { id: fid, name: ocwPdf.name, contentType: "application/pdf", bytes: ocwPdf.bytes, updatedAt: updated, folderId: String(9000 + c) };
      const bytes =
        kind === "pdf" ? buildPdf(Array.from({ length: 2 + Math.floor(random() * 4) }, lines))
        : kind === "docx" ? buildDocx(Array.from({ length: 10 + Math.floor(random() * 20) }, () => sentence(words)))
        : kind === "pptx" ? buildPptx(Array.from({ length: 5 + Math.floor(random() * 7) }, () => [sentence(words, 5), sentence(words), sentence(words)]))
        : kind === "txt" ? Buffer.from(lines().join("\n"))
        : Buffer.from("synthetic video bytes");
      const type = {
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain",
        mp4: "video/mp4",
      }[kind];
      return { id: fid, name: `${label}.${kind}`, contentType: type, bytes, updatedAt: updated, folderId: String(9000 + c) };
    };
    for (let f = 0; f < fileCount; f++) {
      const r = f % 20;
      const kind = r < 11 ? "pdf" : r < 16 ? "docx" : r < 19 ? "pptx" : f === 19 ? "mp4" : "txt";
      const label = kind === "pptx" ? `Lecture ${f + 1} slides` : kind === "docx" ? `Handout ${f + 1}` : kind === "mp4" ? `Lecture recording ${f + 1}` : `Reading ${f + 1} ${pick(words)}`;
      course.files.push(makeFile(label, kind));
    }
    if (course.syllabusMode === "file") {
      const syl = makeFile(`${topic.code.replace(/\s+/g, "")} Syllabus`, "pdf");
      syl.bytes = buildPdf([
        [`${topic.code} ${topic.title} Syllabus`, `Instructor office hours are listed below.`, ...Array.from({ length: 16 }, () => sentence(words))],
        ["Grading", ...course.groups.map((g) => `${g.name}: ${g.weight ?? "unweighted"}`), ...Array.from({ length: 10 }, () => sentence(words))],
      ]);
      course.files.push(syl);
    }

    // Pages
    const pageCount = full ? 12 : 3;
    for (let p = 0; p < pageCount; p++) {
      const o = ocwCourse?.pages[p];
      const title = o ? o.title.replace(/\b\w/g, (x) => x.toUpperCase()) : `${pick(["Notes", "Guide", "Overview", "Review", "Worked example"])} ${p + 1}: ${pick(words)} and ${pick(words)}`;
      const body = o ? o.text.split(/\n+/).map((l) => `<p>${l.replace(/</g, "&lt;")}</p>`).join("") : Array.from({ length: 3 }, () => `<p>${paragraph(words)}</p>`).join("");
      course.pages.push({ pageId: String(900000 + c * 100 + p), url: slug(title), title, bodyHtml: body, updatedAt: updated });
    }
    // Two pages reachable only through links (not in modules), linked from the first pages.
    if (full) {
      course.pages[0]!.bodyHtml += `<p>See also <a href="${pageHref(course.pages[10]!.url)}">${course.pages[10]!.title}</a>.</p>`;
      course.pages[1]!.bodyHtml += `<p>Worked solutions: <a href="${pageHref(course.pages[11]!.url)}">${course.pages[11]!.title}</a> and <a href="${fileUrl(course.files[36]!.id)}">${course.files[36]!.name}</a>.</p>`;
    }
    if (course.syllabusMode === "page") {
      const text = [`${topic.code} ${topic.title} course syllabus.`, ...Array.from({ length: 6 }, () => paragraph(words))];
      course.pages.push({ pageId: String(900000 + c * 100 + 99), url: "course-syllabus", title: "Course Syllabus", bodyHtml: text.map((t) => `<p>${t}</p>`).join(""), updatedAt: updated });
    }

    // Quizzes (each has an assignment) and assignments
    const weeks = full ? 12 : 3;
    const due = (week: number, weekday = 4) => {
      const day = new Date(termStart.getTime() + (week * 7 + weekday) * 86400_000);
      return iso(chicago(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59));
    };
    let aSeq = 0;
    const assignmentId = () => String(2000000 + c * 100 + aSeq++);
    const linkedFiles = full ? course.files.slice(28, 36) : course.files.slice(4, 5);
    for (let w = 0; w < weeks; w++) {
      // Every description-linked file is linked at least once (weeks cycle through the list).
      const fileLink = linkedFiles[w % linkedFiles.length];
      const pageLink = course.pages[(w * 3) % Math.min(course.pages.length, 10)]!;
      const reading = fileLink
        ? `<p>Before starting, read <a href="${fileUrl(fileLink.id)}">${fileLink.name}</a> and <a href="${pageHref(pageLink.url)}">${pageLink.title}</a>.</p>`
        : `<p>Review <a href="${pageHref(pageLink.url)}">${pageLink.title}</a>.</p>`;
      course.assignments.push({
        id: assignmentId(), name: `Homework ${w + 1}: ${pick(words)} ${pick(words)}`, dueAt: due(w + 1), points: 20 + (w % 3) * 5,
        groupId: course.groups[0]!.id, descriptionHtml: `<p>${paragraph(words)}</p>${reading}`, submissionTypes: ["online_upload"], updatedAt: updated,
      });
    }
    const quizCount = full ? 6 : 1;
    for (let q = 0; q < quizCount; q++) {
      const aid = assignmentId();
      const qid = String(700000 + c * 100 + q);
      const dueAt = due(q * 2 + 1, 1);
      course.quizzes.push({ id: qid, title: `Quiz ${q + 1}`, assignmentId: aid, dueAt, points: 10, descriptionHtml: `<p>${sentence(words)}</p>` });
      course.assignments.push({
        id: aid, name: `Quiz ${q + 1}`, dueAt, points: 10, groupId: course.groups[1]!.id, descriptionHtml: `<p>${sentence(words)}</p>`,
        submissionTypes: ["online_quiz"], quizId: qid, updatedAt: updated,
      });
    }
    const exams: Array<[string, number]> = full ? [["Midterm Exam", 7], ["Final Exam", 15]] : [["Midterm Exam", 4]];
    const examDue = (week: number) => {
      const day = new Date(termStart.getTime() + (week * 7 + 2) * 86400_000);
      return iso(chicago(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 19, 0));
    };
    for (const [name, week] of exams)
      course.assignments.push({
        id: assignmentId(), name, dueAt: examDue(week), points: 100,
        groupId: course.groups[2]!.id, descriptionHtml: `<p>The ${name.toLowerCase()} covers ${pick(words)}, ${pick(words)} and ${pick(words)}. ${sentence(words)}</p>`,
        submissionTypes: ["on_paper"], updatedAt: updated,
      });
    const discussionCount = full ? 4 : 1;
    for (let d = 0; d < discussionCount; d++) {
      const did = String(8500000 + c * 100 + d);
      const graded = d < 2;
      const aid = graded ? assignmentId() : undefined;
      course.discussions.push({ id: did, title: `Discussion ${d + 1}: ${pick(words)}`, messageHtml: `<p>${paragraph(words, 2)}</p>`, postedAt: iso(new Date(termStart.getTime() + d * 7 * 86400_000)), assignmentId: aid });
      if (aid)
        course.assignments.push({
          id: aid, name: `Discussion ${d + 1}: ${pick(words)}`, dueAt: due(d * 3 + 2, 3), points: 5, groupId: course.groups[3]!.id,
          descriptionHtml: `<p>${sentence(words)}</p>`, submissionTypes: ["discussion_topic"], discussionId: did, updatedAt: updated,
        });
    }
    // Two undated assignments (participation).
    for (let u = 0; u < (full ? 2 : 1); u++)
      course.assignments.push({
        id: assignmentId(), name: `Participation ${u + 1}`, dueAt: null, points: u === 0 ? 5 : null, groupId: course.groups[3]!.id,
        descriptionHtml: `<p>${sentence(words)}</p>`, submissionTypes: ["none"], updatedAt: updated,
      });
    for (let k = 0; k < (full ? 8 : 2); k++)
      course.announcements.push({ id: String(8000000 + c * 100 + k), title: `Announcement ${k + 1}`, messageHtml: `<p>${paragraph(words, 2)}</p>`, postedAt: iso(new Date(termStart.getTime() + k * 4 * 86400_000)) });

    // Modules: per week, a header, two pages, files, the week's homework, a quiz or discussion, and a link.
    const moduleCount = full ? 9 : 2;
    let itemSeq = 0;
    const itemId = () => String(5000000 + c * 1000 + itemSeq++);
    const moduleFiles = full ? course.files.slice(0, 28) : course.files.slice(0, 4);
    const homeworks = course.assignments.filter((a) => a.submissionTypes[0] === "online_upload");
    for (let m = 0; m < moduleCount; m++) {
      const mid = String(1000000 + c * 100 + m);
      const items: RItem[] = [];
      const add = (item: Omit<RItem, "id" | "moduleId" | "position">) => items.push({ ...item, id: itemId(), moduleId: mid, position: items.length + 1 });
      add({ type: "SubHeader", title: `Week ${m + 1} materials` });
      if (m === 0 && course.syllabusMode === "page") add({ type: "Page", title: "Course Syllabus", pageUrl: "course-syllabus" });
      for (const page of course.pages.slice(0, 10).filter((_, i) => i % moduleCount === m)) add({ type: "Page", title: page.title, pageUrl: page.url });
      for (const file of moduleFiles.filter((_, i) => i % moduleCount === m)) add({ type: "File", title: file.name, contentId: file.id });
      const hw = homeworks[m];
      if (hw) add({ type: "Assignment", title: hw.name, contentId: hw.id });
      const quiz = course.quizzes[m];
      if (quiz && m % 2 === 0) add({ type: "Quiz", title: quiz.title, contentId: quiz.id });
      const topicRow = course.discussions[m];
      if (topicRow && m % 2 === 1) add({ type: "Discussion", title: topicRow.title, contentId: topicRow.id });
      if (m % 3 === 2) add({ type: "ExternalUrl", title: `Further reading on ${pick(words)}`, externalUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(pick(words))}` });
      course.modules.push({ id: mid, name: `Week ${m + 1}: ${pick(words)}`, position: m + 1, items });
    }

    // Syllabus
    const summary = `<h2>${topic.code}: ${topic.title}</h2>`;
    if (course.syllabusMode === "body")
      course.syllabusHtml = `${summary}${Array.from({ length: 5 }, () => `<p>${paragraph(words)}</p>`).join("")}<h3>Grading</h3><ul>${course.groups.map((g) => `<li>${g.name}: ${g.weight ?? "not weighted"}${g.weight ? "%" : ""}</li>`).join("")}</ul>`;
    else if (course.syllabusMode === "page") course.syllabusHtml = `<p>The syllabus is on the <a href="${pageHref("course-syllabus")}">Course Syllabus</a> page.</p>`;
    else {
      const syl = course.files[course.files.length - 1]!;
      course.syllabusHtml = `<p>Download the syllabus: <a href="${fileUrl(syl.id)}">${syl.name}</a></p>`;
    }
    courses.push(course);
  }

  // A non-term site that is listed as active but is not a course (orientation).
  courses.push({
    index: 50, id: "399001", name: "Canvas Student Orientation", code: "Orientation", term: { id: "1", name: "Default Term", start: null, end: null },
    kind: "org", filesHidden: false, weighted: false, syllabusMode: "body", syllabusHtml: "<p>Welcome.</p>",
    modules: [{ id: "1099001", name: "Start here", position: 1, items: [{ id: "5999001", moduleId: "1099001", title: "Welcome", type: "SubHeader", position: 1 }] }],
    groups: [], assignments: [{ id: "2999001", name: "Orientation checklist", dueAt: null, points: null, groupId: "69999", descriptionHtml: "<p>Complete the checklist.</p>", submissionTypes: ["none"], updatedAt: iso(termStart) }],
    quizzes: [], pages: [], files: [], announcements: [], discussions: [],
  });

  for (let p = 0; p < pastCount; p++) {
    const t = PAST[p]!;
    const restricted = full ? p >= 3 : p === 1;
    const id = String(380000 + p);
    const course: RCourse = {
      index: 100 + p, id, name: `${t.code}: ${t.title}`, code: t.code, term: pastTerm, kind: restricted ? "restricted" : "past",
      filesHidden: false, weighted: false, syllabusMode: "body", syllabusHtml: `<p>${t.title} syllabus (past term).</p>`,
      modules: [], groups: [{ id: String(69000 + p), name: "Assignments", weight: null, position: 1 }], assignments: [], quizzes: [], pages: [], files: [], announcements: [], discussions: [],
    };
    for (let a = 0; a < 5; a++)
      course.assignments.push({
        id: String(2900000 + p * 100 + a), name: `${t.code} assignment ${a + 1}`, dueAt: iso(new Date(pastStart.getTime() + (a + 2) * 14 * 86400_000)),
        points: 10, groupId: String(69000 + p), descriptionHtml: "<p>Past-term work.</p>", submissionTypes: ["online_upload"], updatedAt: iso(pastStart),
      });
    course.modules.push({ id: String(1090000 + p * 10), name: "Unit 1", position: 1, items: course.assignments.slice(0, 3).map((a, i) => ({ id: String(5900000 + p * 10 + i), moduleId: String(1090000 + p * 10), title: a.name, type: "Assignment", contentId: a.id, position: i + 1 })) });
    courses.push(course);
  }
  return { anchor, now, user: { id: "99001", name: "Synthetic Student" }, courses };
}

export interface Mutation { kind: "due_date_moved" | "page_edited" | "file_added"; courseId: string; id: string }
/** The repeat-sync change set: three items change, the rest is untouched. */
export function mutate(account: Account): Mutation[] {
  const [first, second, third] = account.courses.filter((c) => c.kind === "current");
  const later = new Date(account.now.getTime() + 3600_000);
  const stamp = later.toISOString().replace(/\.\d{3}Z$/, "Z");
  const changes: Mutation[] = [];
  const a = first!.assignments.find((x) => x.dueAt && Date.parse(x.dueAt) > account.now.getTime())!;
  a.dueAt = new Date(Date.parse(a.dueAt!) + 2 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  a.updatedAt = stamp;
  changes.push({ kind: "due_date_moved", courseId: first!.id, id: a.id });
  const page = (second ?? first)!.pages[0]!;
  page.bodyHtml += "<p>Update: the review session moved to the Thursday lecture slot.</p>";
  page.updatedAt = stamp;
  changes.push({ kind: "page_edited", courseId: (second ?? first)!.id, id: page.url });
  const course = (third ?? first)!;
  const fid = String(30000000 + course.index * 1000 + 900);
  course.files.push({ id: fid, name: "Added handout.pdf", contentType: "application/pdf", bytes: buildPdf([["Added handout for the repeat sync.", "It covers the newly posted practice problems."]]), updatedAt: stamp, folderId: String(9000 + course.index) });
  const module = course.modules[0]!;
  module.items.push({ id: String(5000000 + course.index * 1000 + 900), moduleId: module.id, title: "Added handout.pdf", type: "File", contentId: fid, position: module.items.length + 1 });
  changes.push({ kind: "file_added", courseId: course.id, id: fid });
  return changes;
}
