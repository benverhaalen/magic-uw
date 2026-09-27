// Headless check of the synthetic sample courses (fixtures/sample-courses.json): loads the sample into a
// temporary workspace the way the desktop worker does, then reads what Home, the assignment page,
// Study & Learn and Calendar are built from, and fails if any of them is empty. No model call, no window.
// Run: pnpm exec tsx scripts/verify-sample-courses.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBatchSchema, type ResourceView } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import sample from "../fixtures/sample-courses.json";
import { studyPrepQuery } from "../packages/core/src/study-prep/query";
import { canonicalHomeResources, selectHomeEvidence } from "../apps/desktop/src/renderer/home/projection";
import { currentEnrollmentBrief } from "../apps/desktop/src/renderer/home/brief";
import { gradeInputs } from "../packages/learning/src/grades/inputs";
import { courseGrades } from "../packages/learning/src/grades/index";

const TZ = "America/Chicago";
const now = new Date(process.env.SAMPLE_NOW ?? "2026-09-27T15:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "magic-sample-"));
const started = performance.now();
const store = createStore(join(dir, "workspace.sqlite"), { now: () => now });
const core = createCore(store, { fixture: sample.map((b) => captureBatchSchema.parse(b)), now: () => now, timeZone: TZ, drain: { derive: true } });
try {
  await core.execute({ type: "fixture" });
  const loadMs = Math.round(performance.now() - started);
  await core.settled();
  const snap = core.snapshot();
  assert.ok(snap.fixtureMode, "fixture mode");
  const total = sample.reduce((n, b) => n + b.resources.length, 0);
  assert.equal(snap.resources.length, total, "every sample record is saved");
  const byExt = (e: string) => snap.resources.find((r) => r.externalId === e)!;

  // Home: the Daily Brief and Upcoming, computed by the renderer's own projection.
  const canonical = canonicalHomeResources(snap.resources as ResourceView[], snap.sources, snap.links, snap.courseWorkAdmission?.aliases);
  const nowIso = now.toISOString();
  const { work, passages, prerequisites } = selectHomeEvidence(canonical, snap, nowIso, TZ);
  const activeWork = [...work.today, ...work.upcoming.flatMap((g) => g.items)];
  const brief = currentEnrollmentBrief({ resources: canonical, sources: snap.sources, links: snap.links, schedules: snap.courseWorkAdmission?.schedules,
    planning: snap.planning, timeZone: TZ, now: nowIso, activeWork, earlier: work.earlier, passages, prerequisites, conflict: null,
    launchable: new Set(work.upcoming.slice(0, 5).map((g) => g.items[0]!.id)), canOpenSource: true });
  const weekEnd = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const thisWeek = activeWork.filter((r) => (r.deadline.dueAt ?? "") <= weekEnd);
  console.log(`load ${loadMs} ms; ${snap.resources.length} records in ${snap.sources.length} sample courses`);
  console.log(`Upcoming this week (${thisWeek.length}):`, thisWeek.map((r) => `${r.courseName.split(":")[0]} ${r.title} · ${r.deadline.dueAt}`));
  console.log("Daily Brief:", brief.items.map((i) => `${i.kind}${"action" in i && i.action ? ` → ${i.action.label}` : ""}`), brief.fallback?.text ?? "");
  assert.ok(thisWeek.length >= 5, "at least five items due this week");
  assert.equal(new Set(thisWeek.map((r) => r.courseId)).size, 3, "this week spans three courses");
  assert.ok(!brief.fallback && brief.items.length >= 3, "the Daily Brief has passages");

  // The brief's assignment link opens Problem Set 4 with its linked slides and reading.
  const ps4 = byExt("math240-ps4");
  const linked = brief.items.find((i) => i.kind === "linked-materials");
  assert.ok(linked && linked.action.targetId === ps4.id, "the brief opens Problem Set 4");
  const related = snap.links.filter((l) => l.status === "accepted" && (l.toId === ps4.id || l.fromId === ps4.id));
  const workSet = (await core.execute({ type: "work-set", id: ps4.id })).workSet!;
  console.log("PS4 related material:", related.map((l) => snap.resources.find((r) => r.id === l.fromId)?.title));
  console.log("PS4 work set:", workSet.items.map((i) => i.title));
  assert.ok(related.length >= 2 && workSet.items.length >= 3, "the assignment has at least two linked sources");

  // Study & Learn: the upcoming list and the quiz's item space with sources and passages to generate from.
  const list = studyPrepQuery(store, { view: "study.prep" }, nowIso);
  assert.equal(list.status, "list");
  console.log("Study upcoming:", list.status === "list" ? list.upcoming.map((u) => `${u.courseName.split(":")[0]} ${u.title}`) : list);
  assert.ok(list.status === "list" && list.upcoming.length >= 3, "Study lists upcoming exams and quizzes");
  for (const ext of ["math240-quiz2", "math240-midterm1"]) {
    const item = byExt(ext);
    const space = studyPrepQuery(store, { view: "study.prep", courseId: item.courseId, itemId: item.id }, nowIso);
    assert.equal(space.status, "ok", `${ext}: ${"message" in space ? space.message : ""}`);
    if (space.status !== "ok") continue;
    const passageCount = space.sources.reduce((n, s) => n + (store.passages?.(s.resourceId)?.length ?? 0), 0);
    console.log(`${item.title}: type ${space.item.type}; ${space.sources.length} sources (${space.sources.map((s) => s.title).join("; ")}); ${passageCount} passages`);
    assert.ok(space.sources.length >= 2, `${ext} has study sources`);
  }

  // Course analytics: the grade bank over the captured scores (the same functions `course.grades` runs).
  for (const courseId of ["math-240", "compsci-300", "biology-151"]) {
    const input = gradeInputs(store, { accountScope: "synthetic", courseId });
    const g = courseGrades(input, now);
    const scored = input.items.filter((i) => i.score !== null).length;
    console.log(`${courseId} grades: ${scored} scored of ${input.items.length}; weights ${g.weights.status}; grade ${JSON.stringify(g.grade).slice(0, 120)}`);
    assert.ok(scored >= 1, `${courseId} has captured scores`);
  }

  // Calendar and chat grounding inputs.
  const events = snap.resources.filter((r) => r.kind === "event" && r.calendar?.start && r.calendar.start >= nowIso && r.calendar.start <= weekEnd);
  const messages = snap.resources.filter((r) => r.kind === "message");
  console.log(`Calendar this week: ${events.length} events; announcements: ${messages.length}`);
  assert.ok(events.length >= 5 && messages.length >= 3);
  console.log("OK");
} finally {
  await core.close?.();
  store.close?.();
  rmSync(dir, { recursive: true, force: true });
}
