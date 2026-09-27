import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { createMcpService } from "../packages/core/src/mcp";
import {
  captureBatchSchema, personalReportIssue, personalReportVersion, personalReportState,
  personalReportChangeSchema, type PersonalReportChange, type Store,
} from "@magic/contracts";
import fixture from "../fixtures/course.json";
const batch = captureBatchSchema.parse(fixture);
const stamp = "2026-09-27T12:00:00.000Z";
const clock = { now: () => new Date(stamp) };
function setup(path = ":memory:") {
  const store = createStore(path, clock);
  store.ingest(batch);
  const resource = store.resources().find(r => r.kind === "assignment")!;
  return { store, resource };
}
function change(store: Store, extra: Partial<PersonalReportChange> = {}): PersonalReportChange {
  const r = store.resources().find(r => r.kind === "assignment")!;
  const evidence = [{ resourceId: r.id, contentHash: r.contentHash }];
  return { operationId: "operation-one", issueId: personalReportIssue("deadline-review", [r.id]),
    evidence, sourceVersion: personalReportVersion(evidence), expectedRevision: 0, handled: true, ...extra };
}
function updated(store: Store) {
  store.ingest({ ...batch, observedAt: stamp, resources: batch.resources.map(r => ({...r, text: r.text + " Updated source evidence."})) });
}

test("real SQLite restart preserves report, Undo and history without altering coursework completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-report-"));
  const path = join(dir, "workspace.sqlite");
  let store = setup(path).store;
  try {
    const input = change(store);
    const initial = store.setPersonalReport(input);
    assert.equal(initial.reportedAt, stamp);
    assert.equal(initial.revision, 1);
    assert.equal(store.resources().find(r => r.id === input.evidence[0]!.resourceId)!.completed, false);
    store.close(); store = createStore(path, clock);
    assert.deepEqual(personalReportState(store.personalReports(), input.issueId, input.sourceVersion), {
      revision: 1, record: { issueId: input.issueId, sourceVersion: input.sourceVersion, reportedAt: stamp },
    });
    const undo = {...input, operationId: "undo-one", expectedRevision: 1, handled: false};
    store.setPersonalReport(undo);
    store.close(); store = createStore(path, clock);
    assert.deepEqual(personalReportState(store.personalReports(), input.issueId, input.sourceVersion), {revision: 2, record: null});
    assert.equal(store.personalReports().length, 1); // compact projection, not history
    assert.deepEqual(store.personalReportHistory(input.issueId).map(e => e.handled), [true, false]);
    assert.equal(store.resources().find(r => r.id === input.evidence[0]!.resourceId)!.submitted, false);
  } finally { store.close(); rmSync(dir, {recursive: true, force: true}); }
});

test("retry is idempotent and cannot reapply an old checked value after Undo", () => {
  const {store} = setup();
  try {
    const input = change(store);
    const first = store.setPersonalReport(input);
    assert.deepEqual(store.setPersonalReport(input), first);
    assert.equal(store.personalReportHistory(input.issueId).length, 1);
    store.setPersonalReport({...input, operationId: "undo", expectedRevision: 1, handled: false});
    assert.deepEqual(store.setPersonalReport(input), first);
    assert.equal(store.personalReports()[0]!.handled, false);
    assert.equal(store.personalReportHistory(input.issueId).length, 2);
    assert.throws(() => store.setPersonalReport({...input, handled: false}), /operation ID/);
    assert.throws(() => store.setPersonalReport({...input, operationId: "stale"}), /another view/);
  } finally {store.close();}
});

test("separate SQLite connections reject a stale view and recover using the latest revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-report-connections-"));
  const path = join(dir, "workspace.sqlite");
  const first = setup(path).store;
  const second = createStore(path, clock);
  try {
    const stale = change(second, {operationId: "second-view"});
    const initial = change(first);
    first.setPersonalReport(initial);
    assert.throws(() => second.setPersonalReport(stale), /another view/);
    const latest = personalReportState(second.personalReports(), initial.issueId, initial.sourceVersion);
    second.setPersonalReport({...stale, handled: false, expectedRevision: latest.revision});
    assert.equal(first.personalReports()[0]!.handled, false);
    assert.equal(first.personalReportHistory(initial.issueId).length, 2);
  } finally {first.close(); second.close(); rmSync(dir, {recursive: true, force: true});}
});

test("updated source reopens the issue, rejects stale mutation and retains original version history", () => {
  const {store} = setup();
  try {
    const old = change(store); store.setPersonalReport(old); updated(store);
    const next = change(store, {operationId: "new", expectedRevision: 1});
    assert.notEqual(next.sourceVersion, old.sourceVersion);
    assert.equal(next.issueId, old.issueId);
    assert.deepEqual(personalReportState(store.personalReports(), next.issueId, next.sourceVersion), {revision: 1, record: null});
    assert.throws(() => store.setPersonalReport({...old, operationId: "stale-undo", expectedRevision: 1, handled: false}), /source changed/);
    store.setPersonalReport(next);
    assert.equal(store.personalReportHistory(old.issueId)[0]!.sourceVersion, old.sourceVersion);
    assert.equal(store.personalReports()[0]!.sourceVersion, next.sourceVersion);
    assert.throws(() => store.setPersonalReport({...next, operationId: "stale-view", handled: false}), /another view/);
  } finally {store.close();}
});

test("identity depends on semantic purpose and exact objects; evidence order and display copy do not create issues", () => {
  const evidence = [{resourceId: "b", contentHash: "hash-b"}, {resourceId: "a", contentHash: "hash-a"}];
  assert.equal(personalReportVersion(evidence), personalReportVersion([...evidence].reverse()));
  assert.equal(personalReportIssue("deadline-review", ["a", "b"]), personalReportIssue("deadline-review", ["b", "a"]));
  assert.notEqual(personalReportIssue("deadline-review", ["a"]), personalReportIssue("reading-review", ["a"]));
  const {store} = setup();
  try {
    const input = change(store);
    assert.throws(() => personalReportChangeSchema.parse({...input, issueId: "wording changed"}));
    assert.throws(() => personalReportChangeSchema.parse({...input, sourceVersion: "unknown"}));
    assert.throws(() => personalReportChangeSchema.parse({...input, evidence: [{...input.evidence[0], contentHash: null}]}));
    assert.throws(() => personalReportChangeSchema.parse({...input, evidence: [input.evidence[0], input.evidence[0]]}));
    assert.throws(() => store.setPersonalReport({...input, handled: false}), /no current report/);
  } finally {store.close();}
});

test("reports cannot cross accounts or operate on removed or excluded evidence", () => {
  const {store} = setup();
  try {
    const own = change(store);
    store.ingest({...batch, source: {...batch.source, id: "other", accountScope: "other-person"}});
    const other = store.resources().find(r => r.sourceId === "other")!;
    const evidence = [...own.evidence, {resourceId: other.id, contentHash: other.contentHash}];
    assert.throws(() => store.setPersonalReport({...own, evidence, issueId: personalReportIssue("deadline-review", evidence.map(e => e.resourceId)), sourceVersion: personalReportVersion(evidence)}), /different accounts/);
    store.setPersonalReport(own);
    store.setCourseOverride({accountScope: batch.source.accountScope, courseId: batch.source.courseId, included: false});
    assert.equal(store.personalReports().length, 0);
    assert.throws(() => store.setPersonalReport({...own, operationId: "excluded", expectedRevision: 1, handled: false}), /no longer available/);
    store.setCourseOverride({accountScope: batch.source.accountScope, courseId: batch.source.courseId, included: true});
    store.removeSource(batch.source.id);
    assert.equal(store.personalReports().length, 0);
    assert.equal(store.personalReportHistory(own.issueId).length, 0);
    assert.throws(() => store.setPersonalReport({...own, operationId: "removed", expectedRevision: 1, handled: false}), /no longer available/);
  } finally {store.close();}
});

test("rebound source identifiers do not reveal or inherit another account's report", () => {
  const {store} = setup();
  try {
    const old = change(store); store.setPersonalReport(old);
    assert.throws(() => store.ingest({...batch, source: {...batch.source, accountScope: "new-account"}}), /cannot be reassigned/);
    store.removeSource(batch.source.id);
    store.ingest({...batch, source: {...batch.source, accountScope: "new-account"}});
    assert.equal(store.personalReports().length, 0);
    assert.equal(store.personalReportHistory(old.issueId).length, 0);
    const current = change(store, {operationId: "new-account-operation"});
    assert.throws(() => store.setPersonalReport(old), /no longer available/);
    store.setPersonalReport(current);
    assert.equal(store.personalReports()[0]!.revision, 1);
    assert.equal(store.personalReportHistory(current.issueId).length, 1);
  } finally {store.close();}
});

test("typed core command returns latest snapshot; private reports are absent from model context and MCP", async () => {
  const {store} = setup();
  const core = createCore(store, {fixture: batch, now: clock.now});
  try {
    const input = change(store, {operationId: "PRIVATE_REPORT_OPERATION"});
    const result = await core.execute({type: "personal-report", value: input});
    assert.equal(result.snapshot.personalReports?.[0]?.revision, 1);
    const replay = await core.execute({type: "personal-report", value: input});
    assert.equal(replay.snapshot.personalReports?.length, 1);
    await core.execute({type: "personal-report", value: {...input, operationId: "undo", expectedRevision: 1, handled: false}});
    const delayedRetry = await core.execute({type: "personal-report", value: input});
    assert.equal(delayedRetry.snapshot.personalReports?.[0]?.handled, false);
    assert.equal(delayedRetry.snapshot.personalReports?.[0]?.revision, 2);
    const payload = core.context(input.evidence[0]!.resourceId, "local").payload;
    const token = "local-test-token";
    store.setMcpGrant({id: "test", label: "Test", recipient: "local", enabled: true,
      courses: [{accountScope: batch.source.accountScope, courseId: batch.source.courseId}], categories: ["course_text"],
      tokenHash: createHash("sha256").update(token).digest("hex")});
    const service = createMcpService(store, "test", token);
    const exported = service.call("get_item", {id: input.evidence[0]!.resourceId});
    for (const value of [payload, exported]) {
      const text = JSON.stringify(value);
      assert.equal(text.includes(input.issueId), false);
      assert.equal(text.includes("PRIVATE_REPORT_OPERATION"), false);
      assert.equal(text.includes("personalReports"), false);
    }
    await core.execute({type: "purge", confirmation: "DELETE LOCAL DATA"});
    assert.deepEqual(core.snapshot().personalReports, []);
    assert.deepEqual(store.personalReportHistory(input.issueId), []);
    await assert.rejects(core.execute({type: "personal-report", value: input}), /no longer available/);
  } finally {await core.close();}
});
