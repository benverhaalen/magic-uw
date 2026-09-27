/**
 * The page views (owner: page-views): assignment.workspace, lecture.session, assessment.page and
 * study.offers on a synthetic course. Every quote must be a literal slice of its source, a missing
 * field is reported as missing, conflicting sources are shown side by side, and no LTI tool is ever
 * given as a URL to open.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSENT_DISCLOSURE_VERSION,
} from "@magic/domain";
import {
  defaultPrivacy,
  learningRequestSchema,
  packScopeSchema,
  queryRequestSchema,
  type AssessmentPage,
  type AssignmentWorkspace,
  type LectureSession,
  type PageEvidence,
  type StudyOffers,
} from "@magic/contracts";
import { runQuery } from "../packages/core/src/queries";
import { compileCourse } from "../packages/core/src/graph/index";
import { checkApproach, approachFacts, createApproachHandler } from "../packages/core/src/views/index";
import { createModelRunner } from "../packages/runner/src/index";
import type { Concept } from "../packages/learning/src/store";
import { ACCOUNT, COURSE, NOW, batch, course, idOf, seededStore } from "./page-views-fixture";

type Store = ReturnType<typeof seededStore>;
const ctx = { now: () => NOW, gatewayConfigured: false };
async function setup(options: Parameters<typeof seededStore>[0] = {}) {
  const store = seededStore(options);
  await compileCourse(store, course, NOW);
  return store;
}
const q = <T>(store: Store, request: unknown) => runQuery(store, queryRequestSchema.parse(request), ctx) as T;

/** Every piece of evidence in a payload: text and title quotes must be literal slices of their source. */
function evidenceIn(value: unknown, out: PageEvidence[] = []): PageEvidence[] {
  if (Array.isArray(value)) for (const v of value) evidenceIn(v, out);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.quote === "string" && typeof o.basis === "string" && "origin" in o) out.push(o as unknown as PageEvidence);
    for (const v of Object.values(o)) evidenceIn(v, out);
  }
  return out;
}
function assertGrounded(store: Store, payload: unknown) {
  const all = evidenceIn(payload);
  assert.ok(all.length > 0, "the page carries evidence");
  for (const e of all) {
    assert.ok(e.quote.length > 0, "no empty quote");
    if ((e.basis === "text" || e.basis === "title") && e.resourceId) {
      const r = store.resource(e.resourceId)!;
      const source = e.basis === "title" ? r.title : r.text;
      assert.equal(source.slice(e.start!, e.end!), e.quote, `quote is a literal slice of "${r.title}"`);
    }
  }
}
/** No action or open link may point at a Canvas tool's launch: its module item or an external_tools path. */
function assertNoLtiLaunch(store: Store, payload: unknown) {
  const tool = store.resources().find((r) => r.moduleItem?.type === "ExternalTool")!;
  const text = JSON.stringify(payload);
  const urls = [...text.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]!);
  const opens = JSON.stringify(payload, (k, v) => (k === "evidence" ? undefined : v));
  for (const u of [...opens.matchAll(/"(?:url)":"([^"]+)"/g)].map((m) => m[1]!)) {
    if (/\/tools\/|lti|external_tools/.test(u)) assert.fail(`an LTI launch URL is offered to open: ${u}`);
  }
  assert.ok(urls.length > 0);
  // The tool's own module-item URL appears only as a tool's identity or its evidence, never as an action or open link.
  for (const m of opens.matchAll(/"(?:action|open)":\{[^}]*\}/g)) assert.ok(!m[0].includes(tool.url), `a tool's module item is never opened: ${m[0]}`);
}

test("assignment.workspace: one read with header, quoted instructions, ranked resources, tools, changes and what's missing", async () => {
  const store = await setup();
  const hw1 = idOf(store, "assignments", "3001");
  const w = q<AssignmentWorkspace>(store, { view: "assignment.workspace", resourceId: hw1 });
  assert.equal(w.view, "assignment.workspace");
  assert.equal(w.header.title, "Homework 1");
  assert.equal(w.header.due?.at, "2026-10-02T04:59:00.000Z");
  assert.ok(w.header.due!.evidence.length > 0, "the due date carries its source");
  assert.equal(w.header.points?.value, 10);
  assert.deepEqual([w.header.gradeWeight.basis, w.header.gradeWeight.percent], ["computed", 20]);
  assert.equal(w.header.status.state, "not_submitted");
  assert.deepEqual(w.header.submissionTypes, ["online_upload"]);
  assert.match(w.instructions.text, /Lecture 1 notes/);
  assert.deepEqual(w.instructions.rubric.map((c) => c.criterion), ["Correctness", "Clarity"]);
  assert.equal(w.instructions.canvas.url, "https://canvas.wisc.edu/courses/202/assignments/3001");

  // Ranked: links in the instructions first, then files named in the prompt, then module siblings; ≤5.
  assert.ok(w.resources.length <= 5);
  assert.deepEqual(w.resources.slice(0, 3).map((r) => r.title), ["Lecture 1 notes", "Slides 9/29.pdf", "Problem set guide.pdf"]);
  assert.equal(w.resources[0]!.reason, "linked in instructions");
  assert.ok(w.resources[0]!.reasons.includes("syllabus reading for week 1"), "the syllabus's week-1 line adds its reason");
  assert.equal(w.resources[2]!.reason, "named in prompt");
  assert.ok(w.resources.some((r) => r.reason.startsWith("same module")));
  for (const r of [...w.resources, ...w.moreResources.items]) {
    assert.ok(r.reason && r.evidence.length, `${r.title} has a reason and evidence`);
    assert.ok(["app", "browser", "canvas", "none"].includes(r.open.how));
  }
  assert.equal(w.resources[0]!.open.how, "app", "a stored page opens in the app");
  assert.equal(w.resources.find((r) => r.title === "Lecture 1 recording")?.open.how, "browser", "a Kaltura link opens in the browser");

  // Tools: the Gradescope link (browser, with its launch effect) and the module's Canvas tool (from Canvas).
  const link = w.tools.find((t) => t.kind === "homework")!;
  assert.equal(link.action.kind, "open_in_browser");
  assert.match(link.launchEffect ?? "", /roster/);
  const lti = w.tools.find((t) => t.kind === "lti_tool")!;
  assert.equal(lti.action.kind, "open_from_canvas");
  assert.equal(lti.action.url, "https://canvas.wisc.edu/courses/202/modules");
  assert.equal(lti.accessState, "unknown");

  // Changes: the announcement that names it, quoted.
  const change = w.changes.find((c) => c.kind === "announcement")!;
  assert.equal(change.title, "Homework 1 clarification");
  assert.equal(change.evidence[0]!.quote, "For Homework 1, show your sketches.");

  // Missing, never invented.
  const missing = w.missing.map((m) => m.field);
  for (const f of ["startBy", "aiPolicy", "readiness"]) assert.ok(missing.includes(f), `${f} is reported missing`);
  assert.equal(w.header.startBy, null);
  // No course AI policy: UW–Madison's default applies and the line says so (the course's own policy is still missing).
  assert.deepEqual([w.header.aiPolicy.mode, w.header.aiPolicy.source], ["coaching", "uw-default"]);
  assert.equal(w.header.aiPolicy.text, "No course AI policy found, so UW–Madison's guidelines apply: study help is fine; ask your instructor before using AI on graded work. https://conduct.students.wisc.edu/artificial-intelligence/");
  assert.equal(w.readiness.status, "no_topics");
  assert.equal(w.approach.status, "not_generated");
  assert.deepEqual(w.approach.request, { type: "pack", pack: "page-approach", scope: { courseId: COURSE, resourceIds: [hw1] } });
  assert.deepEqual(w.offers, [], "a homework is not a test: no stakes-based offers");
  assertGrounded(store, w);
  assertNoLtiLaunch(store, w);
  assert.ok(JSON.stringify(w).length <= 64 * 1024, "payload ≤ 64 KB");
  store.close();
});

test("assignment.workspace: an external-tool submission opens from Canvas; the app never launches it", async () => {
  const store = await setup();
  const w = q<AssignmentWorkspace>(store, { view: "assignment.workspace", resourceId: idOf(store, "assignments", "3003") });
  const tool = w.tools.find((t) => t.name.startsWith("Canvas external tool"))!;
  assert.equal(tool.action.kind, "open_from_canvas");
  assert.match(tool.action.note ?? "", /never launches/);
  assertNoLtiLaunch(store, w);
  store.close();
});

test("assessment.page: posted details merge Canvas, syllabus and announcements; a move and a conflict show both sources", async () => {
  const store = await setup();
  const mid = idOf(store, "assignments", "3002");
  const p = q<AssessmentPage>(store, { view: "assessment.page", assessmentId: mid });
  const detail = (f: string) => p.details.find((d) => d.field === f)!;

  // Announced in the syllabus, moved by an announcement: the change wins and the old date stays visible.
  const date = detail("date");
  assert.equal(date.status, "changed");
  assert.equal(date.value, "2026-10-21T00:15:00.000Z");
  assert.deepEqual(
    date.claims.map((c) => [c.evidence.origin, c.superseded]).sort(),
    [["announcement", false], ["syllabus", true]],
  );
  // Two sources disagree and nothing settles it: both are shown, no value is picked.
  const duration = detail("duration");
  assert.equal(duration.status, "conflict");
  assert.equal(duration.value, null);
  assert.deepEqual(duration.claims.map((c) => c.value).sort(), ["120 minutes", "90 minutes"]);
  assert.deepEqual([detail("location").status, detail("location").value], ["found", "1100 Grainger Hall"]);
  assert.deepEqual([detail("weight").status, detail("weight").value], ["found", "25%"]);
  assert.deepEqual([detail("allowed_materials").status, detail("allowed_materials").value], ["found", "a notes sheet"]);
  assert.equal(detail("format").value, "on paper");

  // Scope in the instructor's words, mapped to the modules it names.
  assert.equal(p.scope.stated, true);
  assert.equal(p.scope.quotes[0]!.quote, "Midterm 1 covers weeks 1-2.");
  assert.deepEqual(p.scope.modules.map((m) => m.moduleId), ["m1", "m2"]);
  // Materials by tier; announcements are changes, not materials.
  const core = p.materials.core.map((r) => r.title);
  for (const t of ["Slides 9/29.pdf", "Lecture 1 notes", "Convolution notes"]) assert.ok(core.includes(t), `${t} is core`);
  assert.ok(p.materials.practice.some((r) => r.title === "Homework 1"), "past problem sets are practice");
  assert.ok(![...p.materials.core, ...p.materials.alsoUseful, ...p.materials.practice].some((r) => r.title === "Midterm 1 moved"));
  assert.ok(p.materials.core.length <= 8 && p.materials.alsoUseful.length <= 6 && p.materials.practice.length <= 5);
  // The sheet: notes are allowed, so quoted formulas and definitions from the scope's materials.
  assert.equal(p.sheet.status, "allowed");
  assert.ok(p.sheet.entries.some((e) => e.kind === "formula" && e.value === "y(t) = x(t) * h(t)"));
  assert.equal(p.practice.blueprint, null);
  assert.deepEqual(p.mastery, { status: "not_built", message: "Course mastery isn't on this build yet.", slice: null });
  assert.ok(p.officeHours.every((o) => o.date >= "2026-09-29" && o.date <= "2026-10-20"));
  assert.ok(p.officeHours.some((o) => o.date === "2026-10-05"), "Mondays and Tuesdays before the exam");
  assert.deepEqual(p.offers.map((o) => [o.id, o.status]), [["study_plan", "ready"], ["practice_exam", "not_built"], ["formula_sheet", "ready"]]);
  assertGrounded(store, p);
  assertNoLtiLaunch(store, p);
  assert.ok(JSON.stringify(p).length <= 64 * 1024);
  store.close();
});

test("assessment.page: missing details are reported as missing, never invented; no sheet without a posted rule", async () => {
  const store = await setup();
  const p = q<AssessmentPage>(store, { view: "assessment.page", assessmentId: idOf(store, "assignments", "3004") });
  for (const f of ["location", "duration", "allowed_materials"] as const) {
    const d = p.details.find((x) => x.field === f)!;
    assert.deepEqual([d.status, d.value, d.claims.length], ["missing", null, 0], `${f} is missing`);
    assert.ok(p.missing.some((m) => m.field === f && /^No posted/.test(m.text)));
  }
  assert.equal(p.details.find((d) => d.field === "date")!.value, "2026-12-15T15:00:00.000Z");
  assert.equal(p.sheet.status, "not_stated");
  assert.deepEqual(p.sheet.entries, []);
  assert.equal(p.scope.stated, false);
  assert.equal(p.scope.text, "Scope not stated by the instructor.");
  assertGrounded(store, p);
  store.close();
});

test("assessment.page: readiness per topic and a day-by-day plan into free days before the exam", async () => {
  const store = await setup();
  const mid = idOf(store, "assignments", "3002");
  const info = idOf(store, "page:exam-info", "p3");
  const ref = `${ACCOUNT}:${COURSE}`;
  store.learning.course(ACCOUNT, COURSE, "Signals Example");
  const concept = (id: string, label: string, kind: Concept["kind"], parentId: string | null, position: number): Concept => ({
    id, courseRef: ref, parentId, label, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "t1",
    sources: kind === "concept" ? [{ resourceId: info, contentHash: store.resource(info)!.contentHash, start: 0, end: 9, quote: "Midterm 1", quoteValid: true }] : [],
  });
  store.learning.putConceptMap(ref, [concept("u1", "Signals", "unit", null, 0), concept("c1", "Sampling", "concept", "u1", 0), concept("c2", "Convolution", "concept", "u1", 1)], "t1");
  const p = q<AssessmentPage>(store, { view: "assessment.page", assessmentId: mid });
  assert.equal(p.readiness.status, "ok");
  assert.deepEqual(p.readiness.topics.map((t) => t.label).sort(), ["Convolution", "Sampling"]);
  assert.match(p.readiness.note, /not a grade prediction/);
  const target = p.practice.targets[0]!;
  assert.ok(learningRequestSchema.safeParse(target.request).success, "the target is a valid learning request");
  assert.equal(p.plan.status, "ok");
  const busy = new Set(["2026-09-30", "2026-10-01", "2026-10-07", "2026-10-08"]);
  assert.ok(p.plan.days.every((d) => !busy.has(d.date) && d.busy === 0), "topics go on free days");
  assert.ok(p.plan.days.every((d) => d.date < "2026-10-20"));
  assert.equal(p.plan.days.flatMap((d) => d.topics).length, 2);
  assert.equal(p.plan.days.reduce((n, d) => n + d.minutes, 0), 60, "30 minutes per topic not yet seen");

  // The assessment's study plan (built from deadlines in every included course) never reaches the student's AI.
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, NOW);
  const sent: string[] = [];
  const planRunner = createModelRunner({ backend: { client: "claude", async call(...args: unknown[]) { sent.push(JSON.stringify(args)); return { value: { paragraph: "Review the core materials first.", quotes: [] }, usage: { in: 50, cached: 0, out: 20 }, model: "synthetic" }; } } });
  const planned = await createApproachHandler({ store, runner: () => planRunner, now: () => new Date(NOW) }).run({ courseId: COURSE, assessmentId: mid });
  assert.equal(planned.status, "done", planned.message);
  assert.ok(sent.length > 0);
  assert.ok(!approachFacts(p).lines.some((l) => l.startsWith("Plan:")));
  for (const payload of sent) {
    assert.ok(!payload.includes("Plan:"), "no plan line in the pack input");
    assert.ok(!payload.includes(JSON.stringify(p.plan.text).slice(1, -1)), "no plan text in the pack input");
  }

  // The cached paragraph survives midnight: its hash covers only the facts it was written from.
  const tomorrow = new Date(Date.parse(NOW) + 86_400_000).toISOString();
  const nextDay = runQuery(store, queryRequestSchema.parse({ view: "assessment.page", assessmentId: mid }), { ...ctx, now: () => tomorrow }) as AssessmentPage;
  assert.notEqual(nextDay.factHash, p.factHash, "the page's own facts moved with the day");
  assert.equal(nextDay.approach.status, "ready", "the paragraph is still served the next day");
  store.close();
});

test("lecture.session: scaffold, slides, recordings as link cards, key terms, what's due and office hours that day", async () => {
  const store = await setup();
  const l = q<LectureSession>(store, { view: "lecture.session", courseId: COURSE, date: "2026-09-29" });
  assert.equal(l.session?.id, `${COURSE}/2026-09-29:lecture`);
  assert.equal(l.session?.module?.title, "Week 1: Signals");
  assert.ok(l.scaffold && l.scaffold.blocks.some((b) => b.kind === "sources"));
  assert.equal(l.slides[0]!.title, "Slides 9/29.pdf");
  assert.equal(l.slides[0]!.reason, "title names the session date");
  assert.equal(new Set(l.slides.map((r) => r.resourceId)).size, l.slides.length, "no duplicate slides");
  const rec = l.recordings.find((r) => r.title === "Lecture 1 recording")!;
  assert.deepEqual([rec.open.how, rec.open.url], ["browser", "https://mediaspace.wisc.edu/media/Lecture+1/1_abc"]);
  assert.deepEqual(l.keyTerms.map((t) => t.term), ["Signal", "Sampling rate"]);
  assert.equal(l.dueSoon[0]!.title, "Homework 1");
  assert.equal(l.officeHours.length, 1, "Tuesday office hours");
  assert.ok(l.missing.some((m) => m.field === "readings"));
  assertGrounded(store, l);
  const byId = q<LectureSession>(store, { view: "lecture.session", courseId: COURSE, sessionId: `${COURSE}/2026-09-29:lecture` });
  assert.equal(byId.factHash, l.factHash, "the same session by ID or by date");
  const none = q<LectureSession>(store, { view: "lecture.session", courseId: COURSE, date: "2026-11-26" });
  assert.equal(none.session, null);
  assert.ok(none.missing.some((m) => m.field === "session"));
  store.close();
});

test("study.offers: grade bank, critical factor and offers by stakes; a 25% final outranks a weekly quiz", async () => {
  const store = await setup();
  const o = q<StudyOffers>(store, { view: "study.offers", courseId: COURSE, days: 90 });
  assert.equal(o.gradeBank.status, "complete");
  assert.deepEqual(o.gradeBank.groups.map((g) => [g.title, g.weight]), [["Homework", 40], ["Exams", 50], ["Quizzes", 10]]);
  const quiz = o.items.find((i) => i.title === "Quiz 1")!;
  const final = o.items.find((i) => i.title === "Final Exam")!;
  assert.deepEqual([quiz.stakes, quiz.grade.basis, quiz.grade.sharePercent], ["low", "computed", 5]);
  assert.deepEqual([final.stakes, final.grade.sharePercent], ["high", 25]);
  assert.ok(quiz.dueAt! < final.dueAt!, "the quiz is sooner");
  assert.ok(o.items.indexOf(final) < o.items.indexOf(quiz), "the final ranks higher by weight");
  assert.ok(final.critical.score > quiz.critical.score);
  assert.deepEqual(quiz.offers.map((x) => [x.id, x.label]), [["cards", "Quick card set (10)"], ["review_sheet", "One-page review sheet"]]);
  for (const x of quiz.offers) {
    assert.equal((x.command as { type: string }).type, "pack");
    assert.ok(packScopeSchema.safeParse((x.command as { scope: unknown }).scope).success);
  }
  const exam = final.offers.find((x) => x.id === "practice_exam")!;
  assert.equal(exam.status, "not_built");
  assert.ok(learningRequestSchema.safeParse((exam.command as { request: unknown }).request).success);
  assert.equal(final.offers.find((x) => x.id === "formula_sheet")!.status, "not_stated");
  // The midterm, dated only by the syllabus and the announcement, is in the list too.
  assert.ok(o.items.some((i) => i.title === "Midterm 1" && i.dueAt === "2026-10-21T00:15:00.000Z"));
  store.close();
});

test("study.offers: a partial capture says only what's listed; another account's groups never mix in (FDB-001)", async () => {
  const store = await setup({ assignmentsComplete: false });
  store.ingest({
    ...batch("assignment-groups", [
      { externalId: "g9", kind: "material", courseId: COURSE, courseName: "Other", title: "Everything", url: "https://canvas.wisc.edu/courses/202/assignments", text: "", deadlines: [], points: null, submitted: null, policy: { mode: "unknown", evidence: "" }, assignmentGroup: { weight: 100 } },
    ]),
    source: { id: "src-other-groups", label: "Other Canvas", kind: "canvas", accountScope: "student-2", courseId: COURSE, scope: "assignment-groups" },
  });
  const o = q<StudyOffers>(store, { view: "study.offers", courseId: COURSE, accountScope: ACCOUNT, days: 90 });
  assert.equal(o.gradeBank.status, "partial");
  assert.equal(o.gradeBank.groups.length, 3, "only this account's groups");
  const quiz = o.items.find((i) => i.title === "Quiz 1")!;
  assert.deepEqual([quiz.grade.basis, quiz.grade.sharePercent, quiz.grade.maxMovePercent, quiz.grade.reason], ["listed", null, 10, "partial_capture"]);
  assert.match(quiz.grade.text, /isn't known/);
  store.close();
});

test("approach: generated on request through the pack path, cached by the page's fact hash, every date checked", async () => {
  const store = await setup();
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, NOW);
  const hw1 = idOf(store, "assignments", "3001");
  const page = q<AssignmentWorkspace>(store, { view: "assignment.workspace", resourceId: hw1 });
  const facts = approachFacts(page);
  assert.deepEqual(checkApproach('Open "Lecture 1 notes" first; it is worth 10 points.', facts), []);
  assert.ok(checkApproach("Finish it by Nov 3.", facts).some((e) => /date/.test(e)), "an invented date fails");
  assert.ok(checkApproach("Spend 45 minutes on it.", facts).some((e) => /number 45/.test(e)), "an invented number fails");
  assert.ok(checkApproach('The prompt says "show all your work twice".', facts).some((e) => /quote/.test(e)), "an invented quote fails");

  let calls = 0;
  let reply: unknown = { paragraph: 'Start with "Lecture 1 notes", then the slides; it is worth 10 points.', quotes: [] };
  const runner = createModelRunner({ backend: { client: "claude", async call() { calls++; return { value: reply, usage: { in: 50, cached: 0, out: 20 }, model: "synthetic" }; } } });
  const handler = createApproachHandler({ store, runner: () => runner, now: () => new Date(NOW) });
  const none = await createApproachHandler({ store, runner: () => null, now: () => new Date(NOW) }).run({ courseId: COURSE, resourceIds: [hw1] });
  assert.equal(none.status, "no_client");
  const done = await handler.run({ courseId: COURSE, resourceIds: [hw1] });
  assert.equal(done.status, "done", done.message);
  assert.equal(calls, 1);
  assert.ok(done.receiptIds.length > 0, "the send left a receipt");
  const again = q<AssignmentWorkspace>(store, { view: "assignment.workspace", resourceId: hw1 });
  assert.equal(again.approach.status, "ready");
  assert.equal(again.approach.text, 'Start with "Lecture 1 notes", then the slides; it is worth 10 points.');
  assert.equal(calls, 1, "the query never calls a model");
  const cached = await handler.run({ courseId: COURSE, resourceIds: [hw1] });
  assert.deepEqual([cached.cached, cached.tokens, calls], [true, { in: 0, cached: 0, out: 0 }, 1]);

  const mid = idOf(store, "assignments", "3002");
  reply = { paragraph: "Start studying on Nov 3.", quotes: [] };
  const bad = await handler.run({ courseId: COURSE, assessmentId: mid });
  assert.equal(bad.status, "needs_student");
  assert.ok((bad.checkErrors ?? []).some((e) => /date/.test(e)));
  const midPage = q<AssessmentPage>(store, { view: "assessment.page", assessmentId: mid });
  assert.equal(midPage.approach.status, "not_generated", "a paragraph that failed the checks is never stored");
  store.close();
});

test("page views: the request schema accepts the four views; an excluded course is refused", async () => {
  const store = await setup();
  for (const request of [
    { view: "assignment.workspace", resourceId: "x" },
    { view: "lecture.session", courseId: COURSE, date: "2026-09-29" },
    { view: "assessment.page", assessmentId: "x" },
    { view: "study.offers", courseId: COURSE },
  ])
    assert.ok(queryRequestSchema.safeParse(request).success, request.view);
  assert.ok(!queryRequestSchema.safeParse({ view: "lecture.session", courseId: COURSE, date: "Sept 29" }).success);
  store.setCourseOverride({ accountScope: ACCOUNT, courseId: COURSE, included: false });
  for (const request of [
    { view: "assignment.workspace", resourceId: idOf(store, "assignments", "3001") },
    { view: "lecture.session", courseId: COURSE, date: "2026-09-29" },
    { view: "assessment.page", assessmentId: idOf(store, "assignments", "3002") },
    { view: "study.offers", courseId: COURSE },
  ])
    assert.throws(() => q(store, request), /excluded/, request.view);
  store.close();
});
