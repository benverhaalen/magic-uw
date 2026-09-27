import test from "node:test";
import assert from "node:assert/strict";
import { syncUwPlanning } from "../packages/connectors/src/uw-planning-sync";
import type { UwPlanningReadRequest, UwPlanningReadResult } from "../packages/connectors/src/uw-planning-http";
import { createStore } from "@magic/storage";

const seed = "synthetic-installation-seed-0000000000000000";
const date = new Date("2026-09-26T18:00:00Z");
const ok = (data: unknown): UwPlanningReadResult => ({ status: "ok", data, bytes: 0, elapsedMs: 0, schemaVerified: false });
const blocked: UwPlanningReadResult = { status: "needs_sign_in", code: "unauthorized", bytes: 0, elapsedMs: 0, schemaVerified: false };
const student = (emplid = "98765432101234") => ({
  personAttributes: { emplid, netid: "NEVER_EXPOSE_NETID", email: "NEVER_EXPOSE_EMAIL" },
  primaryCareer: { careerCode: "UGRD", programName: "Undergraduate", termCode: "1272" },
  enrollmentImpacts: { holds: [], registrationAppointments: [] }, studentAdvisorRelationships: [],
});
function host(change: (request: UwPlanningReadRequest, profileReads: number) => UwPlanningReadResult | undefined = () => undefined) {
  const requests: UwPlanningReadRequest[] = []; let profileReads = 0;
  return { requests, async read(request: UwPlanningReadRequest) {
    requests.push(request);
    if (request.kind === "student-info") profileReads++;
    const changed = change(request, profileReads);
    if (changed) return changed;
    switch (request.kind) {
      case "student-info": return ok(student());
      case "current-enrollment": case "audit-metadata": case "degree-plans": return ok([]);
      case "myuw-session": return ok({ person: { firstName: "NEVER_EXPOSE", lastName: "NEVER_EXPOSE", displayName: "NEVER_EXPOSE", userName: "NEVER_EXPOSE", sessionKey: "NEVER_EXPOSE_SESSION", serverName: "synthetic.test", version: "1" } });
      default: return ok({});
    }
  } };
}
test("native planning orchestration checks identity twice and returns only normalized evidence", async () => {
  const http = host();
  const result = await syncUwPlanning({ http, accountSeed: seed, now: () => date });
  assert.equal(http.requests.filter((request) => request.kind === "student-info").length, 2);
  assert.ok(http.requests.some((request) => request.kind === "current-enrollment" && request.term === "1272"));
  const output = JSON.stringify(result);
  assert.equal(output.includes("NEVER_EXPOSE"), false);
  assert.equal(output.includes("98765432101234"), false);
  assert.equal(output.includes(seed), false);
  const privateRows = result.captures.filter((capture) => capture.records.some((row) => row.kind === "student_summary"));
  assert.equal(privateRows.length, 1);
  assert.match(privateRows[0].accountScope, /^uw-account:[a-f0-9]{64}$/);
  const store = createStore(":memory:");
  try {
    for (const capture of result.captures) assert.equal(store.ingestPlanning(capture).rejected, 0);
    assert.equal(store.planningRecords().filter((row) => row.kind === "student_summary").length, 1);
    assert.ok(store.planningSources().some((source) => source.diagnostics.some((item) => item.code === "saved_audit_inventory_partial")));
  } finally { store.close(); }
});
test("identity mismatch or expiry before completion releases no private academic records", async () => {
  for (const later of [ok(student("11111111111111")), blocked]) {
    const http = host((request, reads) => request.kind === "student-info" && reads > 1 ? later : undefined);
    const result = await syncUwPlanning({ http, accountSeed: seed, now: () => date });
    assert.equal(result.captures.some((capture) => capture.accountScope !== "public" && capture.records.length > 0), false);
    assert.ok(result.invalidated.some((source) => source.source === "uw_enroll" && source.code === "account_recheck_failed"));
  }
});
test("unverified identity blocks dependent private reads without blocking public data or portal check", async () => {
  for (const response of [blocked, ok({ ...student(), personAttributes: {} })]) {
    const http = host((request) => request.kind === "student-info" ? response : undefined);
    const result = await syncUwPlanning({ http, accountSeed: seed, now: () => date });
    assert.equal(http.requests.some((request) => ["current-enrollment", "degree-plans", "audit-metadata"].includes(request.kind)), false);
    assert.equal(result.captures.some((capture) => capture.records.length), false);
    assert.ok(result.captures.some((capture) => capture.source === "uw_myuw" && capture.status === "complete"));
    assert.ok(result.invalidated.some((source) => source.source === "uw_enroll"));
  }
});
test("different accounts and installation seeds produce distinct opaque scopes", async () => {
  const scope = async (person: string, accountSeed: string) => (await syncUwPlanning({ http: host((r) => r.kind === "student-info" ? ok(student(person)) : undefined), accountSeed, now: () => date })).captures.find((capture) => capture.records.length)!.accountScope;
  assert.notEqual(await scope("12345", seed), await scope("67890", seed));
  assert.notEqual(await scope("12345", seed), await scope("12345", `${seed}other`));
});
test("aborted refresh returns no captures and makes no requests", async () => {
  const controller = new AbortController(); controller.abort(); const http = host();
  await assert.rejects(syncUwPlanning({ http, accountSeed: seed, signal: controller.signal }));
  assert.equal(http.requests.length, 0);
});
test("institutional account links require matching logins and stable Canvas identity, without persisting identifiers", async () => {
  for (const mode of ["match", "mismatch", "switch"] as const) {
    let canvasReads = 0;
    const http = host((request) => {
      if (request.kind === "student-info") return ok({ ...student(), personAttributes: { emplid: "12345", netid: "synthetic", email: "synthetic@wisc.edu" } });
      if (request.kind === "canvas-profile") return ok({ id: ++canvasReads > 1 && mode === "switch" ? 88 : 77, login_id: mode === "mismatch" ? "other@wisc.edu" : "synthetic@wisc.edu", name: "DO_NOT_SAVE" });
      return undefined;
    });
    const result = await syncUwPlanning({ http, accountSeed: seed, now: () => date });
    assert.equal(result.captures.flatMap(c => c.records).filter(r => r.kind === "account_link").length, mode === "match" ? 1 : 0);
    assert.equal(/synthetic@|DO_NOT_SAVE|12345/.test(JSON.stringify(result)), false);
  }
});
