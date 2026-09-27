import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import type { PlanningCapture, PlanningCourseHistory, PlanningProvenance, Store } from "@magic/contracts";
import { parseGuideSubject } from "../packages/connectors/src/planning-public";

const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`;
const provenance = (day = 26): PlanningProvenance => ({ sourceUrl: "https://enroll.wisc.edu/", observedAt: at(day), scope: { kind: "degree_plan", key: "primary" } });
const course = (id = "attempt", day = 26): PlanningCourseHistory => ({ id, kind: "course_history", provenance: provenance(day), courseKey: "uw:266:300", termCode: "1264", state: "completed", credits: 3, grade: "AB", gpaEligible: true });
const capture = (day = 26, records: PlanningCapture["records"] = [course("attempt", day)], extra: Partial<PlanningCapture> = {}): PlanningCapture => ({
  schemaVersion: 1, id: `capture-${day}`, accountScope: "local-account-a", source: "normalized_import", scope: provenance().scope,
  sourceUrl: "https://enroll.wisc.edu/", observedAt: at(day), status: "complete", completeness: "complete", records, diagnostics: [], ...extra,
});
function withStore(run: (store: Store) => void) { const store = createStore(":memory:"); try { run(store); } finally { store.close(); } }

test("Guide cross-list evidence survives the capture-to-store boundary", () => withStore((store) => {
  const subjects = [{ code: "266", shortName: "COMP SCI" }, { code: "600", shortName: "MATH" }].map((subject) => ({ ...subject, kind: "subject" as const, id: subject.code, formalName: subject.shortName, aliases: [], provenance: { ...provenance(), scope: { kind: "subjects" as const, key: "registrar-subjects" } } }));
  const parsed = parseGuideSubject('<div class="courseblock"><p class="courseblocktitle"><span class="courseblockcode">COMP SCI/MATH 240</span> — Discrete Mathematics</p><p class="courseblockcredits">3 credits.</p><p class="courseblockdesc">Synthetic course description.</p></div>', "comp_sci", subjects, at(26));
  const result = store.ingestPlanning(parsed);
  assert.equal(result.accepted, 2);
  assert.equal(result.rejected, 0);
  const crosslist = store.planningRecords().find((row) => row.kind === "crosslist");
  assert.deepEqual(crosslist?.courseKeys, ["uw:266:240", "uw:600:240"]);
}));

test("planning storage isolates account, source, and scope identities from coursework", () => withStore((store) => {
  store.ingestPlanning(capture());
  store.ingestPlanning(capture(26, [course()], { accountScope: "local-account-b" }));
  store.ingestPlanning(capture(26, [course()], { source: "uw_enroll" }));
  const other = course(); other.provenance.scope = { kind: "degree_plan", key: "secondary" };
  store.ingestPlanning(capture(26, [other], { scope: other.provenance.scope }));
  assert.equal(store.planningRecords().length, 4);
  assert.equal(new Set(store.planningRecords().map((row) => row.localId)).size, 4);
  assert.equal(store.planningSources().length, 4);
  assert.equal(store.resources().length, 0);
  assert.equal(store.sources().length, 0);
}));

test("partial capture adds valid evidence without deletion authority or a new last success", () => withStore((store) => {
  store.ingestPlanning(capture(24, [course("one", 24), course("two", 24)]));
  const result = store.ingestPlanning(capture(25, [course("one", 25)], { status: "partial", completeness: "partial" }));
  assert.equal(result.accepted, 1);
  assert.equal(store.planningRecords().filter((row) => !row.deleted).length, 2);
  assert.equal(store.planningSources()[0].lastSuccessAt, new Date(at(24)).toISOString());
  assert.equal(store.planningSources()[0].status, "partial");
  store.ingestPlanning(capture(26, [course("one", 26)]));
  assert.equal(store.planningRecords().find((row) => row.id === "two")?.deleted, true);
  assert.equal(store.planningSources()[0].lastSuccessAt, new Date(at(26)).toISOString());
}));

test("malformed records cannot turn failed or blocked captures into successful writable imports", () => withStore((store) => {
  store.ingestPlanning(capture(24));
  for (const [day, status] of [[25, "failed"], [26, "blocked"]] as const) {
    const bad = { ...course("bad", day), grade: { private: "untrusted" } };
    const incoming = capture(day, [course("new", day)], { status, completeness: "unknown" });
    const result = store.ingestPlanning({ ...incoming, records: [...incoming.records, bad] });
    assert.equal(result.accepted, 0);
    assert.equal(result.rejected, 1);
    assert.equal(store.planningSources()[0].status, status);
    assert.equal(store.planningSources()[0].lastSuccessAt, new Date(at(24)).toISOString());
    assert.deepEqual(store.planningRecords().map((row) => row.id), ["attempt"]);
  }
}));

test("malformed successful capture downgrades coverage and keeps prior rows", () => withStore((store) => {
  store.ingestPlanning(capture(24, [course("old", 24)]));
  const result = store.ingestPlanning({ ...capture(25, [course("valid", 25)]), records: [course("valid", 25), { ...course("bad", 25), studentName: "private" }] });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(store.planningSources()[0].status, "partial");
  assert.equal(store.planningRecords().filter((row) => !row.deleted).length, 2);
  assert.equal(store.planningSources()[0].lastSuccessAt, new Date(at(24)).toISOString());
}));

test("duplicate record IDs remain ambiguous instead of choosing the first conflicting grade", () => withStore((store) => {
  store.ingestPlanning(capture(24));
  const result = store.ingestPlanning(capture(25, [{ ...course("attempt", 25), grade: "A" }, { ...course("attempt", 25), grade: "F" }]));
  assert.equal(result.accepted, 0);
  assert.equal(result.rejected, 2);
  const saved = store.planningRecords()[0];
  assert.equal(saved.kind === "course_history" && saved.grade, "AB");
  assert.equal(saved.deleted, false);
}));

test("unchanged reads refresh observation without version churn; newer envelopes cannot roll evidence backward", () => withStore((store) => {
  store.ingestPlanning(capture(24));
  store.ingestPlanning(capture(25));
  let saved = store.planningRecords()[0];
  assert.equal(saved.version, 1);
  assert.equal(saved.provenance.observedAt, new Date(at(25)).toISOString());
  const stale = store.ingestPlanning(capture(26, [{ ...course("attempt", 24), grade: "F" }]));
  assert.equal(stale.rejected, 1);
  saved = store.planningRecords()[0];
  assert.equal(saved.provenance.observedAt, new Date(at(25)).toISOString());
  assert.equal(saved.kind === "course_history" && saved.grade, "AB");
  assert.equal(store.planningSources()[0].status, "partial");
  assert.equal(store.planningSources()[0].observedAt, new Date(at(26)).toISOString());
  const ignored = store.ingestPlanning(capture(25, []));
  assert.equal(ignored.ignored, true);
  assert.equal(store.planningRecords()[0].deleted, false);
}));

test("public scope cannot store private records or a claimed enrolled package; term scopes cannot bleed", () => withStore((store) => {
  assert.equal(store.ingestPlanning(capture(24, [course()], { accountScope: "public" })).accepted, 0);
  const scope = { kind: "enrollment_term" as const, key: "1272" };
  const pkg = { id: "pkg", kind: "enrollment_package" as const, provenance: { ...provenance(), scope }, courseKey: "uw:266:400", termCode: "1272",
    sections: ["001"], status: "open" as const, enrollmentState: "enrolled" as const, meetings: [], meetingsComplete: false, seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [] };
  assert.equal(store.ingestPlanning(capture(25, [pkg], { accountScope: "public", scope })).accepted, 0);
  assert.equal(store.ingestPlanning(capture(26, [{ ...pkg, termCode: "1274" }], { scope })).accepted, 0);
  assert.equal(store.planningRecords().length, 0);
}));

test("complete empty capture removes only its own account and scope", () => withStore((store) => {
  store.ingestPlanning(capture(24));
  store.ingestPlanning(capture(24, [course("attempt", 24)], { accountScope: "local-account-b" }));
  store.ingestPlanning(capture(25, []));
  assert.equal(store.planningRecords().filter((row) => !row.deleted).length, 1);
  assert.equal(store.planningRecords().find((row) => !row.deleted)?.accountScope, "local-account-b");
}));
