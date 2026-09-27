import test from "node:test";
import assert from "node:assert/strict";
import type { AuditNode, PlanningSourceHealth, Snapshot, StoredPlanningRecord } from "@magic/contracts";
import { offeringsToLoad, partText, projectMyUw, refreshOutcome, type BriefPart } from "../apps/desktop/src/renderer/myuw/model";

// Synthetic normalized records only; no UW response shapes or student data.
const now = Date.parse("2026-09-27T15:00:00Z");
const recent = "2026-09-27T14:00:00Z", old = "2026-05-01T14:00:00Z", tenDays = "2026-09-17T14:00:00Z";
const briefText = (brief: BriefPart[][]) => brief.map((line) => line.map(partText).join("")).join(" ");
const links = (brief: BriefPart[][]) => brief.flat().filter((part): part is Extract<BriefPart, { target: string }> => typeof part === "object" && "target" in part);
const account = "uw-account:synthetic";
function source(id: string, fields: Partial<PlanningSourceHealth> = {}): PlanningSourceHealth {
  return { id, source: "uw_enroll", accountScope: account, scope: { kind: "student_record", key: "connection:student-info" }, sourceUrl: "https://enroll.wisc.edu/",
    status: "complete", completeness: "complete", observedAt: recent, lastSuccessAt: recent, diagnostics: [], ...fields };
}
function stored<T extends object>(record: T, sourceId: string, scope = account): StoredPlanningRecord {
  return { ...record, localId: `${sourceId}:${(record as { id: string }).id}`, sourceId, accountScope: scope, contentHash: "x", version: 1, deleted: false } as unknown as StoredPlanningRecord;
}
const provenance = (kind: string, key: string, observedAt = recent) => ({ sourceUrl: "https://enroll.wisc.edu/", observedAt, scope: { kind, key } });
function node(nodeId: string, status: AuditNode["status"], fields: Partial<AuditNode> = {}): AuditNode {
  return { nodeId, parentId: null, index: 0, kind: "requirement", title: nodeId, requirementKind: "major_core", rawStatus: null, status, flags: [], earnedCredits: null, earnedGpa: null,
    needsCourses: null, needsCredits: null, acceptableCourseKeys: [], appliedCourses: [], coverage: "complete", evidence: [], ...fields };
}
function snapshot(records: StoredPlanningRecord[], sources: PlanningSourceHealth[]): Snapshot {
  return { planning: { records, sources } } as unknown as Snapshot;
}
function seeded(options: { auditAt?: string; auditSource?: Partial<PlanningSourceHealth>; nodes?: AuditNode[] } = {}) {
  const sources = [source("login"), source("audit", { source: "uw_dars", scope: { kind: "audit_program", key: "saved" }, ...options.auditSource }),
    source("enroll-1272", { scope: { kind: "enrollment_term", key: "1272" } }), source("terms", { source: "uw_public", accountScope: "public", scope: { kind: "terms", key: "t" } }),
    source("myuw", { source: "uw_myuw", scope: { kind: "student_record", key: "connection:myuw-session" } })];
  const records = [
    stored({ id: "summary", kind: "student_summary", provenance: provenance("student_record", "connection:student-info"), career: "UGRD", programNames: ["Synthetic Studies BS"], expectedGraduationTerm: null, cumulativeGpa: null, earnedCredits: 60, attemptedCredits: null }, "login"),
    stored({ id: "audit", kind: "audit", provenance: provenance("audit_program", "saved", options.auditAt ?? recent), programKey: "synthetic", generatedAt: options.auditAt ?? recent, catalogTerm: null, coverage: "complete",
      nodes: options.nodes ?? [node("Core", "incomplete", { needsCourses: 2, acceptableCourseKeys: ["uw:266:400", "uw:266:577", "uw:600:340"] }), node("Breadth", "completed", { index: 1 }), node("Partly read", "completed", { index: 2, coverage: "partial" })] }, "audit"),
    stored({ id: "pkg", kind: "enrollment_package", provenance: provenance("enrollment_term", "1272"), courseKey: "uw:266:300", termCode: "1272", sections: ["001"], status: "open", enrollmentState: "enrolled",
      meetings: [{ kind: "class", mode: "scheduled", days: [1, 3], startMinute: 570, endMinute: 620, startDate: null, endDate: null, timezone: "America/Chicago", location: null }], meetingsComplete: true, seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [] }, "enroll-1272"),
    stored({ id: "t1272", kind: "term", provenance: provenance("terms", "t"), code: "1272", season: "fall", year: 2026, label: "Fall 2026", past: false }, "terms", "public"),
    stored({ id: "t1274", kind: "term", provenance: provenance("terms", "t"), code: "1274", season: "spring", year: 2027, label: "Spring 2027", past: false }, "terms", "public"),
    stored({ id: "cs", kind: "subject", provenance: provenance("subjects", "s"), code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: [] }, "terms", "public"),
  ];
  return { records, sources };
}

test("connected journey: briefing, remaining requirements, this term and next-term default come from saved evidence", () => {
  const { records, sources } = seeded();
  const model = projectMyUw(snapshot(records, sources), now);
  assert.equal(model.state, "current");
  assert.equal(model.thisTerm?.label, "Fall 2026");
  assert.equal(model.thisTerm?.courses[0].label, "COMP SCI 300");
  assert.equal(model.defaultPlanTerm, "1274", "next term follows the enrolled term");
  const audit = model.audits[0];
  assert.deepEqual(audit.remaining.map((view) => [view.node.nodeId, view.tone]), [["Core", "open"], ["Partly read", "unknown"]]);
  assert.deepEqual(audit.met.map((view) => view.node.nodeId), ["Breadth"], "a partially read completed node is never counted as met");
  assert.equal(audit.remaining[0].needs, "2 courses still needed");
  assert.deepEqual(audit.remaining[0].subjects.map((subject) => subject.name), ["COMP SCI", "Subject 600"]);
  const text = briefText(model.brief);
  assert.match(text, /Synthetic Studies BS/);
  assert.match(text, /You’re enrolled in COMP SCI 300 for Fall 2026\./);
  // One semantic for what remains: the audit's own status per named requirement, with the unread
  // part named separately and never folded into an open or met count.
  assert.match(text, /shows Core still open\. Partly read couldn’t be fully read, so it isn’t counted as met\./);
  assert.doesNotMatch(text, /\d+ (open )?requirements? (still in play|open)/, "no bare requirement count");
  assert.deepEqual(links(model.brief).filter((part) => part.target === "degree").map((part) => part.ref),
    audit.remaining.map((view) => `${audit.record.localId}:${view.node.nodeId}`), "each named requirement opens its own row");
  assert.ok(model.brief.flat().some((part) => typeof part === "object" && "time" in part), "the audit date is a time chip, not a link");
  assert.doesNotMatch(text, /—/, "no authored em dash");
});

test("audit heading shows the saved program name for a matching program key, else the key as written", () => {
  const { records, sources } = seeded();
  const withKey = (programKey: string) => records.map((row) => row.kind === "audit" ? { ...row, programKey } : row);
  assert.equal(projectMyUw(snapshot(withKey("synthetic-studies-bs"), sources), now).audits[0].title, "Synthetic Studies BS");
  assert.equal(projectMyUw(snapshot(withKey("other_program"), sources), now).audits[0].title, "other program", "an unmatched key is not renamed");
});

test("offerings to load come from open requirements and skip subjects already saved for the term", () => {
  const { records, sources } = seeded();
  let model = projectMyUw(snapshot(records, sources), now);
  assert.deepEqual(offeringsToLoad(model, "1274").map((row) => row.code), ["266", "600"]);
  records.push(stored({ id: "c400", kind: "catalog_course", provenance: provenance("catalog_term", "1274"), courseKey: "uw:266:400", termCode: "1274", title: "Synthetic 400", description: "", creditMin: 3, creditMax: 3, designations: [], prerequisiteText: null, prerequisite: null, prerequisiteCheckedAt: null, offeringFrequency: null }, "terms", "public"));
  model = projectMyUw(snapshot(records, sources), now);
  assert.deepEqual(offeringsToLoad(model, "1274").map((row) => row.code), ["600"]);
  assert.deepEqual(offeringsToLoad(model, ""), []);
});

test("stale, partial and failed sources never read as current", () => {
  const { records, sources } = seeded({ auditAt: old, auditSource: { observedAt: old } });
  const model = projectMyUw(snapshot(records, sources), now);
  assert.equal(model.state, "partial");
  assert.ok(model.audits[0].stale);
  const text = briefText(model.brief);
  assert.match(text, /Run a fresh audit/);
  const failed = seeded({ auditSource: { status: "failed", completeness: "unknown" } });
  const failedModel = projectMyUw(snapshot(failed.records, failed.sources), now);
  assert.equal(failedModel.privateSources.find((row) => row.id === "audit")?.state, "failed");
  assert.ok(failedModel.audits[0].stale, "records kept from a failed refresh need verification");
  assert.equal(failedModel.audits[0].staleReason, "unconfirmed");
  assert.match(briefText(failedModel.brief), /last refresh couldn’t reconfirm this audit/, "a recent audit that failed to reconfirm isn't told to be re-run");
  assert.doesNotMatch(briefText(failedModel.brief), /Run a fresh audit/);
});

test("unfinished enrollment source says so instead of claiming current enrollment", () => {
  const { records, sources } = seeded();
  const partial = sources.map((row) => row.id === "enroll-1272" ? { ...row, status: "partial" as const, completeness: "partial" as const } : row);
  const model = projectMyUw(snapshot(records, partial), now);
  assert.equal(model.thisTerm?.complete, false);
  const text = briefText(model.brief);
  assert.match(text, /Your last saved Fall 2026 enrollment lists COMP SCI 300 as of .+\. Refresh to confirm it/);
  assert.doesNotMatch(text, /You’re enrolled/);
});

test("empty and multiple-account states hide personal planning", () => {
  const empty = projectMyUw(snapshot([], []), now);
  assert.equal(empty.state, "not_connected");
  assert.deepEqual(empty.signIn, ["myuw", "enroll"]);
  assert.equal(empty.brief.length, 0);
  const { records, sources } = seeded();
  records.push(stored({ id: "other", kind: "hold", provenance: provenance("student_record", "x"), title: "Other student", description: "", blocksEnrollment: true, resolutionUrl: null }, "login", "uw-account:other"));
  const multiple = projectMyUw(snapshot(records, sources), now);
  assert.equal(multiple.state, "multiple_accounts");
  assert.equal(multiple.audits.length, 0);
  assert.equal(multiple.attention.length, 0);
  assert.deepEqual(multiple.signIn, []);
});

test("blocking holds lead attention; unknown impact is not treated as harmless; past windows drop", () => {
  const { records, sources } = seeded();
  records.push(
    stored({ id: "h-unknown", kind: "hold", provenance: provenance("student_record", "connection:student-info"), title: "Unknown hold", description: "", blocksEnrollment: null, resolutionUrl: null }, "login"),
    stored({ id: "h-block", kind: "hold", provenance: provenance("student_record", "connection:student-info"), title: "Blocking hold", description: "", blocksEnrollment: true, resolutionUrl: "https://my.wisc.edu/" }, "login"),
    stored({ id: "w-past", kind: "appointment", provenance: provenance("student_record", "connection:student-info"), termCode: "1272", startsAt: "2026-04-01T13:00:00Z", endsAt: "2026-04-30T13:00:00Z" }, "login"),
    stored({ id: "w-next", kind: "appointment", provenance: provenance("student_record", "connection:student-info"), termCode: "1274", startsAt: "2026-11-03T14:00:00Z", endsAt: null }, "login"),
  );
  const model = projectMyUw(snapshot(records, sources), now);
  assert.deepEqual(model.attention.map((item) => item.kind === "hold" ? item.record.title : item.termLabel), ["Blocking hold", "Unknown hold", "Spring 2027"]);
  const text = briefText(model.brief);
  // The briefing carries only the consequence; the hold and window details live once, in Needs attention.
  assert.match(text, /Blocking hold blocks enrollment, so it needs to be cleared before your Spring 2027 window opens [A-Z][a-z]{2} \d/);
  assert.equal(text.match(/hold/gi)?.length, 1, "one sentence names one hold");
  assert.doesNotMatch(text, /Unknown hold/);
  assert.deepEqual(links(model.brief).filter((part) => part.target === "attention").map((part) => part.ref), [model.attention[0].key]);
});

test("freshness follows the semester horizons Compare uses; holds and windows keep a short confirmation limit", () => {
  const { records, sources } = seeded({ auditAt: tenDays, auditSource: { observedAt: tenDays } });
  const aged = sources.map((row) => row.id === "enroll-1272" || row.id === "login" ? { ...row, observedAt: tenDays } : row);
  records.push(stored({ id: "h-old", kind: "hold", provenance: provenance("student_record", "connection:student-info", tenDays), title: "Old hold", description: "", blocksEnrollment: true, resolutionUrl: null }, "login"));
  const model = projectMyUw(snapshot(records, aged), now);
  assert.equal(model.privateSources.find((row) => row.id === "audit")?.state, "current", "a ten-day-old audit is within the term horizon");
  assert.equal(model.audits[0].stale, false);
  assert.equal(model.privateSources.find((row) => row.id === "enroll-1272")?.state, "stale", "enrollment is fresh for seven days");
  assert.equal(model.thisTerm?.complete, false);
  const hold = model.attention.find((item) => item.kind === "hold");
  assert.equal(hold?.stale, true, "a ten-day-old hold may have changed");
  assert.match(briefText(model.brief), /Old hold blocks enrollment until it’s resolved\. UW reported this on .+; refresh to confirm it still applies\./);
});

test("refresh outcome is judged from changed source health", () => {
  const { records, sources } = seeded();
  const before = Object.fromEntries(sources.map((row) => [row.id, row.observedAt]));
  const after = sources.map((row) => row.id === "audit" ? { ...row, observedAt: "2026-09-27T14:30:00Z", status: "failed" as const, completeness: "unknown" as const } : row.id === "login" ? { ...row, observedAt: "2026-09-27T14:30:00Z" } : row);
  const outcome = refreshOutcome(before, projectMyUw(snapshot(records, after), now).sources);
  assert.equal(outcome.checked, 2);
  assert.equal(outcome.current, 1);
  assert.deepEqual(outcome.problems.map((row) => row.label), ["Degree audit"]);
  assert.equal(refreshOutcome(before, projectMyUw(snapshot(records, sources), now).sources).checked, 0);
});
