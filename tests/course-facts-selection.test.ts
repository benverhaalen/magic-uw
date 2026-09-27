// Syllabus selection (D34 tiers, the wrong-document guard) and the wider literal headings, on synthetic
// syllabus shapes modelled on the live investigation's courses B (syllabus tab + AI note on the front
// page) and E (a Canvas "Syllabus" page with its own headings). No real course text.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { captureBatchSchema, type Resource, type SourceHealth } from "@magic/contracts";
import {
  compileCourseIntelligence,
  headingSection,
  isAiLine,
  selectSyllabus as selectFrom,
  termsNamed,
} from "../packages/domain/src/course-intelligence";
import { selectSyllabus } from "../packages/core/src/course-facts/select";

const at = "2026-09-27T12:00:00Z";
const course = { accountScope: "acct", courseId: "101" };
const courseName = "PHIL 101: Introduction to Philosophy";
type Input = Partial<Resource> & { title: string; text?: string };
let n = 0;
function ingest(store: ReturnType<typeof createStore>, scope: string, resources: Input[], kind: "fixture" | "web" = "fixture") {
  store.ingest(
    captureBatchSchema.parse({
      source: { id: `src-${scope}`, label: scope, kind, accountScope: course.accountScope, courseId: course.courseId, scope },
      observedAt: new Date(Date.parse(at) + n++ * 1000).toISOString(),
      complete: true,
      status: "ok",
      resources: resources.map((r) => ({
        externalId: r.externalId ?? `x${n++}`,
        kind: r.kind ?? "material",
        courseId: course.courseId,
        courseName,
        url: r.url ?? `https://canvas.example.edu/courses/101/pages/p${n++}`,
        text: "",
        ...r,
      })),
    }),
  );
}
const filler = (label: string) =>
  Array.from({ length: 12 }, (_, i) => `${label} paragraph ${i + 1}: readings, discussion sections and weekly reflections continue as planned.`).join("\n");
const syllabusTab = (text: string) => ({ externalId: "syllabus", title: "Syllabus", url: "https://canvas.example.edu/courses/101/assignments/syllabus", text });
const detailsResource = { externalId: "course-101", kind: "course" as const, title: courseName, url: "https://canvas.example.edu/courses/101", course: { termName: "Fall 2026", courseCode: "PHIL 101" } };

function pick(store: ReturnType<typeof createStore>) {
  const result = selectSyllabus(store, course, at);
  const title = (id: string) => store.resource(id)?.title;
  return { ...result, titles: result.selected.map((s) => `${s.role}:${s.tier}:${title(s.resourceId)}`) };
}

test("tier 1: a syllabus tab with meaningful text is the primary; a near-empty one is not", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "syllabus", [syllabusTab(`Course Summary:\nDate\nDetails\nDue\n${filler("Week")}`)]);
  let s = pick(store);
  assert.deepEqual(s.titles, ["primary:1:Syllabus"]);
  assert.match(s.selected[0]!.reason, /Canvas syllabus tab \(\d+ characters/);
  ingest(store, "syllabus", [syllabusTab("Course Summary:\nDate\nDetails\nDue\nSee the syllabus page.")]);
  s = pick(store);
  assert.deepEqual(s.titles, [], "under 400 characters after boilerplate is not a syllabus");
  store.close();
});

test("tier 2: a Canvas page titled as the syllabus, and a file linked as the syllabus from a module item", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "syllabus", [syllabusTab("See Modules.")]);
  ingest(store, "pages", [{ title: "Course Syllabus", text: filler("Syllabus") }]);
  let s = pick(store);
  assert.deepEqual(s.titles, ["primary:2:Course Syllabus"]);
  store.close();

  const other = createStore(":memory:");
  ingest(other, "details", [detailsResource]);
  ingest(other, "module-items:1", [
    { title: "PHIL 101 Syllabus Fall 2026 [Read Me!]", moduleItem: { type: "File", contentId: "77", title: "PHIL 101 Syllabus Fall 2026 [Read Me!]" }, url: "https://canvas.example.edu/courses/101/modules/items/5" },
  ]);
  ingest(other, "files", [{ title: "phil101-f26.pdf", file: { id: "77" }, url: "https://canvas.example.edu/courses/101/files/77", text: filler("Policies") }]);
  s = pick(other);
  assert.deepEqual(s.titles, ["primary:2:phil101-f26.pdf"], "the module item and its file are one document; the copy with text wins");
  assert.match(s.selected[0]!.reason, /linked as the syllabus/);
  other.close();
});

test("tier 2 without text is still selected (and reported) until the file is acquired", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "module-items:1", [{ title: "PHIL 101 Syllabus Fall 2026", moduleItem: { type: "File", contentId: "9", title: "PHIL 101 Syllabus Fall 2026" } }]);
  const s = pick(store);
  assert.equal(s.selected.length, 1);
  assert.equal(s.selected[0]!.hasText, false);
  store.close();
});

test("tier 3: a course-site syllabus linked from a Canvas module; the other term's copy is refused", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "module-items:2", [
    { title: "Course website", moduleItem: { type: "ExternalUrl", externalUrl: "https://phil.example.edu/fa26/", title: "Course website" }, url: "https://canvas.example.edu/courses/101/modules/items/8" },
  ]);
  ingest(
    store,
    "web",
    [
      { title: "Syllabus", url: "https://phil.example.edu/fa26/syllabus.html", text: filler("Site") },
      { title: "Syllabus", url: "https://phil.example.edu/fa24/syllabus.html", text: filler("Old") },
      { title: "Syllabus", url: "https://unlinked.example.org/syllabus.html", text: filler("Elsewhere") },
    ],
    "web",
  );
  const s = pick(store);
  assert.deepEqual(s.titles, ["primary:3:Syllabus"]);
  assert.equal(store.resource(s.selected[0]!.resourceId)!.url, "https://phil.example.edu/fa26/syllabus.html");
  assert.equal(s.rejected.length, 1);
  assert.match(s.rejected[0]!.reason, /another term \(fall 2024\)/);
  store.close();
});

test("tier 3 link only: a module item linking the syllabus off Canvas is found and reported without text", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "module-items:3", [
    { title: "Syllabus - 101 - F26", moduleItem: { type: "ExternalUrl", externalUrl: "https://files.example.edu/s/abc", title: "Syllabus - 101 - F26" }, url: "https://canvas.example.edu/courses/101/modules/items/9" },
  ]);
  const s = pick(store);
  assert.deepEqual(s.titles, ["primary:3:Syllabus - 101 - F26"]);
  assert.equal(s.selected[0]!.hasText, false);
  assert.match(s.selected[0]!.reason, /files\.example\.edu/);
  store.close();
});

test("tier 4: the front page with policy headings, as primary alone or as the AI supplement", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "pages", [{ title: "Home", url: "https://canvas.example.edu/courses/101/pages/front-page", text: "Welcome!\nAI Policy\nYou may use AI tools to brainstorm, not to write." }]);
  let s = pick(store);
  assert.deepEqual(s.titles, ["primary:4:Home"]);
  ingest(store, "syllabus", [syllabusTab(`Grading breakdown\nEssays 40%\n${filler("Week")}`)]);
  s = pick(store);
  assert.deepEqual(s.titles, ["primary:1:Syllabus", "supplement:4:Home"]);
  assert.match(s.selected[1]!.reason, /mentions AI where the primary does not/);
  store.close();
});

test("wrong-document guard: another course's code and another term's year are refused; the newest version wins", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "files", [
    { title: "ECON 301 Syllabus.pdf", file: { id: "1" }, url: "https://canvas.example.edu/courses/101/files/1", text: filler("Econ") },
    { title: "Syllabus Fall 2024.pdf", file: { id: "2" }, url: "https://canvas.example.edu/courses/101/files/2", text: filler("Old") },
    { title: "PHIL101_Syllabus_F26 v1.pdf", file: { id: "3" }, url: "https://canvas.example.edu/courses/101/files/3", text: filler("One") },
    { title: "PHIL101_Syllabus_F26 v2.pdf", file: { id: "4" }, url: "https://canvas.example.edu/courses/101/files/4", text: filler("Two") },
  ]);
  const s = pick(store);
  assert.equal(s.titles[0], "primary:2:PHIL101_Syllabus_F26 v2.pdf");
  assert.deepEqual(s.rejected.map((r) => r.reason).sort(), ["names another course (ECON 301)", "names another term (fall 2024)"]);
  store.close();
});

test("term tokens: season words, short codes and file-name forms", () => {
  assert.deepEqual(termsNamed("Syllabus - 234 - S26"), [{ season: "spring", year: 2026 }]);
  assert.deepEqual(termsNamed("PHIL101_Syllabus_F26.pdf"), [{ season: "fall", year: 2026 }]);
  assert.deepEqual(termsNamed("/fa26/syllabus.html"), [{ season: "fall", year: 2026 }]);
  assert.deepEqual(termsNamed("Syllabus 2025-26"), [{ year: 2025 }, { year: 2026 }]);
  assert.deepEqual(termsNamed("Syllabus v2"), []);
  assert.deepEqual(termsNamed("Spring 2025-2026"), [{ season: "spring", year: 2026 }], "UW term names carry the academic year");
  assert.deepEqual(termsNamed("Fall 2026-2027"), [{ season: "fall", year: 2026 }]);
});

test("wider headings and AI lines", () => {
  for (const [line, section] of [
    ["Grading breakdown", "grading"], ["Grading Policy:", "grading"], ["GRADE BREAKDOWN", "grading"], ["## Grading", "grading"],
    ["Exams", "assessment"], ["3. Examinations", "assessment"], ["Exam:", "assessment"],
    ["AI Policy", "ai_policy"], ["Generative AI use", "ai_policy"], ["LLM Policy:", "ai_policy"], ["Use of Generative AI", "ai_policy"],
    ["Academic Integrity", "integrity"], ["Office Hours:", null], ["OFFICE HOURS", null],
  ] as const)
    assert.equal(headingSection(line), section, line);
  // Keyword headings as real syllabi write them; Title Case headings end a section, list items don't.
  for (const [line, section] of [
    ["Course Grading Overview", "grading"], ["Grading Scale for Individual Assignments", "grading"],
    ["Midterm and Final Exam Information", "assessment"], ["Course Learning Outcomes", "topic"],
    ["Generative AI and Your Writing", "ai_policy"], ["Classroom Expectations", null], ["☞ Key Details", null],
  ] as const)
    assert.equal(headingSection(line), section, line);
  for (const line of ["Participation", "Essays 40%", "Participation (discussion section artifacts) = 20%"]) assert.equal(headingSection(line), undefined, line);
  assert.equal(headingSection("Essays are due at noon."), undefined);
  for (const line of ["You may use an LLM for feedback.", "GitHub Copilot is not allowed.", "Using AI to draft is misconduct."]) assert.ok(isAiLine(line), line);
  for (const line of ["Paid work is available.", "Email the TA.", "Explain the main claim."]) assert.ok(!isAiLine(line), line);
});

/** Course B shape: syllabus tab headed "Grading breakdown" and "Exams"; the AI note lives on the front page. */
test("course B shape: grading and exam claims from the tab, the AI note from the front-page supplement", () => {
  const store = createStore(":memory:");
  ingest(store, "details", [detailsResource]);
  ingest(store, "syllabus", [
    syllabusTab([
      "PHIL 101 Fall 2026", filler("Week"),
      "Grading breakdown", "Participation 10%", "Essays 40%", "Midterm 20%", "Final exam 30%",
      "Exams", "The midterm is on October 20 in lecture. The final is cumulative.",
      "Office Hours:", "Tuesdays 2-4pm.",
    ].join("\n")),
  ]);
  ingest(store, "pages", [{ title: "Home", url: "https://canvas.example.edu/courses/101/pages/front-page", text: "Welcome!\nA note on AI\nGenerative AI tools are not permitted for graded essays unless the prompt says otherwise." }]);
  const profile = store.courseIntelligence().find((p) => p.courseId === "101")!;
  assert.deepEqual(profile.syllabus?.map((s) => [s.role, s.tier]), [["primary", 1], ["supplement", 4]]);
  const values = (kind: string) => profile.claims.filter((c) => c.kind === kind).map((c) => c.value);
  assert.ok(values("grading").includes("Essays 40%"));
  assert.ok(values("assessment").includes("The midterm is on October 20 in lecture. The final is cumulative."));
  assert.ok(!values("grading").includes("Tuesdays 2-4pm."), "another heading ends the section");
  assert.ok(values("ai_policy").some((v) => String(v).startsWith("Generative AI tools are not permitted")));
  assert.ok(!profile.unknowns.some((u) => /No ai_policy evidence/.test(u)));
  for (const c of profile.claims.filter((c) => c.method === "literal")) {
    const e = c.evidence[0]!;
    assert.equal(store.resource(e.resourceId)!.text.slice(e.start!, e.end!), e.quote, "every literal quote is an exact span");
  }
  store.close();
});

/** Course E shape: a Canvas page "Syllabus" (the tab is empty) with its own headings and many AI mentions. */
test("course E shape: a tier-2 syllabus page yields AI, grading and exam claims", () => {
  const resources: Resource[] = [];
  const sources: Pick<SourceHealth, "id" | "kind" | "scope">[] = [
    { id: "s-syl", kind: "canvas", scope: "syllabus" },
    { id: "s-pages", kind: "canvas", scope: "pages" },
  ];
  const base = { courseId: "101", courseName, observedAt: at, capturedAt: at, deleted: false, completed: false, version: 1, deadlines: [], points: null, submitted: false, policy: { mode: "unknown" as const, evidence: "" } };
  resources.push({ ...base, id: "tab", sourceId: "s-syl", externalId: "syllabus", kind: "material", title: "Syllabus", url: "https://canvas.example.edu/courses/101/assignments/syllabus", text: "", contentHash: "h1" } as Resource);
  const text = [
    "Syllabus", filler("Week"),
    "Generative AI Policy", "You may use LLMs such as ChatGPT or Copilot to check grammar.", "Cite any AI assistance in a footnote.",
    "Grade Breakdown", "Homework 30%", "Projects 30%",
    "Examinations", "Two in-class exams; notes are not allowed.",
  ].join("\n");
  resources.push({ ...base, id: "page", sourceId: "s-pages", externalId: "syllabus-page", kind: "material", title: "Syllabus", url: "https://canvas.example.edu/courses/101/pages/syllabus", text, contentHash: "h2" } as Resource);
  const selection = selectFrom(resources, sources, { at });
  assert.deepEqual(selection.selected.map((s) => [s.resourceId, s.tier]), [["page", 2]]);
  const profile = compileCourseIntelligence("acct", "101", resources, at, undefined, undefined, sources);
  const kinds = new Set(profile.claims.filter((c) => c.evidence[0]?.resourceId === "page").map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), ["ai_policy", "assessment", "grading"]);
  assert.ok(profile.claims.some((c) => c.kind === "ai_policy" && c.value === "Cite any AI assistance in a footnote."));
  assert.ok(!profile.claims.some((c) => c.kind === "ai_policy" && c.policyMode !== "unknown"), "a quote is never collapsed into allowed or restricted");
});

test("compile accepts syllabusResourceIds: facts only from the named sources", () => {
  const sources: Pick<SourceHealth, "id" | "kind" | "scope">[] = [{ id: "s-pages", kind: "canvas", scope: "pages" }];
  const base = { courseId: "101", courseName, observedAt: at, capturedAt: at, deleted: false, completed: false, version: 1, deadlines: [], points: null, submitted: false, policy: { mode: "unknown" as const, evidence: "" }, sourceId: "s-pages", kind: "material" as const };
  const page = { ...base, id: "p", externalId: "p", title: "Week 3 notes", url: "https://canvas.example.edu/courses/101/pages/week-3", text: "Grading\nQuizzes 20%", contentHash: "h" } as Resource;
  const none = compileCourseIntelligence("acct", "101", [page], at, undefined, undefined, sources);
  assert.ok(!none.claims.some((c) => c.kind === "grading"));
  const chosen = compileCourseIntelligence("acct", "101", [page], at, undefined, undefined, sources, [
    { resourceId: "p", role: "primary", tier: 2, reason: "test", title: page.title, url: page.url, hasText: true },
  ]);
  assert.ok(chosen.claims.some((c) => c.kind === "grading" && c.value === "Quizzes 20%"));
  assert.equal(chosen.syllabus?.[0]?.resourceId, "p");
});
