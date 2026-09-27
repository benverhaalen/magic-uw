import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResourceView, Snapshot, SourceHealth } from "@magic/contracts";
import { summarize } from "../apps/desktop/src/renderer/onboarding/model";
import { projectReadiness } from "../apps/desktop/src/renderer/onboarding/readiness";
import { ReadinessOverview } from "../apps/desktop/src/renderer/onboarding/ReadinessOverview";
import { buildSourcesModel } from "../apps/desktop/src/renderer/sources/model";

const at = "2026-09-27T14:00:00Z";
const source = (id: string, courseId: string, scope: string, status: SourceHealth["status"] = "ok"): SourceHealth => ({
  id, label: `Synthetic ${courseId} · ${scope}`, kind: "canvas", accountScope: "test-account", courseId, scope,
  status, complete: status === "ok", lastAttemptAt: at, lastSuccessAt: status === "ok" ? at : null,
  resourceCount: status === "ok" ? 1 : 0,
});
const course = (id: string, sourceId: string, included: boolean): ResourceView => ({
  id: `resource:${id}`, sourceId, courseId: id, kind: "course", title: `Synthetic ${id}`,
  courseName: `Synthetic ${id}`, deleted: false, course: { selection: { score: included ? 5 : 0, included, reasons: [] } },
} as unknown as ResourceView);
const snapshot = (sources: SourceHealth[], resources: ResourceView[]): Snapshot => ({
  sources, resources, fixtureMode: false, generatedAt: at,
} as Snapshot);

test("onboarding keeps all checks in bounded disclosure and gives assignment gaps priority", () => {
  const sources = [source("current", "a", "course"), source("assignments", "a", "assignments", "partial"),
    ...Array.from({ length: 100 }, (_, i) => source(`file:${i}`, "a", `file:${i}`, "partial")),
    source("old", "old", "course", "inaccessible")];
  const data = snapshot(sources, [course("a", "current", true), course("old", "old", false)]);
  const summary = summarize(data, false);
  const overview = projectReadiness(data, summary.sources);
  assert.equal(overview.checks, 103);
  assert.equal(overview.important, 1);
  assert.equal(overview.primaryGap, true);
  assert.equal(overview.includedCourses, 1);
  assert.equal(overview.groups.flatMap((g) => g.checks).length, 103);
  const html = renderToStaticMarkup(React.createElement(ReadinessOverview, { snapshot: data, summary }));
  assert.match(html, /More about this read/);
  assert.match(html, /Show less/);
  assert.match(html, /Assignments for Synthetic a: partly read/);
  assert.match(html, /Synthetic a · file:99/);
  assert.doesNotMatch(html.split("<details")[0], /file:99/);
});

test("old catalog warnings and bounded linked-file scans stay secondary", () => {
  const sources = [source("included", "a", "course"), source("assignments", "a", "assignments"),
    source("file", "a", "file:1", "partial"), source("old", "old", "course", "inaccessible")];
  const data = snapshot(sources, [course("a", "included", true), course("old", "old", false)]);
  const overview = projectReadiness(data, summarize(data, false).sources);
  assert.equal(overview.incomplete, 2);
  assert.equal(overview.primaryGap, false);
  assert.equal(overview.important, 0);
  assert.equal(overview.groups.flatMap((group) => group.checks).length, 4);
});

test("Connected accounts does not headline old catalog sites as current or fully read", () => {
  const sources = [source("current", "a", "course"), source("assignments", "a", "assignments", "partial"),
    source("old", "old", "course", "inaccessible")];
  const resources = [course("a", "current", true), course("old", "old", false)];
  const model = buildSourcesModel({ sources, resources }, { now: new Date("2026-09-27T15:00:00Z"), outlook: { icsConnected: false } });
  const canvas = model.connections[0]!;
  assert.equal(canvas.state, "partial");
  assert.match(canvas.headline, /1 included course site has important areas/);
  assert.doesNotMatch(canvas.headline, /2 courses/);
  assert.equal(canvas.courses.find((c) => c.courseId === "old")?.relevance, "other");
  assert.equal(canvas.courses.find((c) => c.courseId === "a")?.relevance, "included");
});

test("Connected accounts keeps linked file limits in details without calling Canvas partial", () => {
  const sources = [source("course", "a", "course"), source("assignments", "a", "assignments"),
    source("file", "a", "file:1", "partial")];
  const model = buildSourcesModel(snapshot(sources, [course("a", "course", true)]),
    { now: new Date("2026-09-27T15:00:00Z"), outlook: { icsConnected: false } });
  const canvas = model.connections[0]!;
  assert.equal(canvas.state, "connected");
  assert.match(canvas.headline, /linked content was partly read/);
  assert.equal(canvas.courses[0]?.scopes.length, 3);
});

test("verified enrollment marks only the linked Canvas account current", () => {
  const first = source("first", "a", "course");
  const second = { ...source("second", "b", "course"), accountScope: "other-account" };
  const withCode = (id: string, sourceId: string) => ({ ...course(id, sourceId, true),
    courseName: "COMP SCI 400", course: { selection: { included: true, score: 5, reasons: [] }, courseCode: "FA26 COMP SCI 400 001" } }) as unknown as ResourceView;
  const data = snapshot([first, second], [withCode("a", "first"), withCode("b", "second")]);
  data.planning = { records: [
    { kind: "account_link", accountScope: "planning-account", canvasAccountScope: "test-account", method: "matched_institutional_login" },
    { kind: "subject", accountScope: "public", code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: [] },
    { kind: "enrollment_package", accountScope: "planning-account", courseKey: "uw:266:400", termCode: "1272", sections: ["001"], enrollmentState: "enrolled" },
  ], sources: [{ accountScope: "planning-account", source: "uw_enroll", scope: { kind: "enrollment_term", key: "1272" },
    status: "complete", completeness: "complete", lastSuccessAt: at, observedAt: at, diagnostics: [] }] } as unknown as Snapshot["planning"];
  const overview = projectReadiness(data, summarize(data, false).sources, new Date(at));
  assert.equal(overview.currentCourses, 1);
  assert.equal(overview.includedCourses, 2);
  const model = buildSourcesModel(data, { now: new Date(at), outlook: { icsConnected: false } });
  const canvas = model.connections[0]!;
  assert.equal(canvas.courses.find((c) => c.accountScope === "test-account")?.relevance, "current");
  assert.equal(canvas.courses.find((c) => c.accountScope === "other-account")?.relevance, "included");
  data.planning!.sources[0]!.lastSuccessAt = "2026-09-20T14:00:00Z";
  assert.equal(projectReadiness(data, summarize(data, false).sources, new Date(at)).currentCourses, 0);
  assert.equal(buildSourcesModel(data, { now: new Date(at), outlook: { icsConnected: false } }).connections[0]!.courses[0]!.relevance, "included");
});
